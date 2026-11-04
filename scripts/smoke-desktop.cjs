'use strict';

/**
 * Section 3 computer-use smoke test over the Chrome DevTools Protocol.
 * Requires an ORVEX window started with --remote-debugging-port=9222.
 * Exercises screen capture, UIA, OCR, clipboard, windows, processes, input,
 * recording and the guardrail approvals against the real machine.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const PORT = Number(process.env.ORVEX_CDP_PORT || 9222);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeOcrImage() {
  const file = path.join(os.tmpdir(), 'orvex-ocr-smoke.png');
  const script = path.join(os.tmpdir(), 'orvex-ocr-smoke.ps1');
  fs.writeFileSync(
    script,
    `Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap 900,260
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::White)
$font = New-Object System.Drawing.Font('Segoe UI', 40)
$g.DrawString('ORVEX OCR SMOKE 98765', $font, [System.Drawing.Brushes]::Black, 30, 40)
$g.DrawString('Second line for the smoke test', $font, [System.Drawing.Brushes]::Black, 30, 130)
$bmp.Save('${file.replace(/\\/g, '/')}', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
`,
    'utf8',
  );
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
    timeout: 60000,
    windowsHide: true,
  });
  return file;
}

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  if (!res.ok) throw new Error(`CDP list failed: HTTP ${res.status}`);
  return res.json();
}

function connect(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let nextId = 1;
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', (e) => reject(e));
  });
  ws.addEventListener('message', (msg) => {
    const data = JSON.parse(msg.data);
    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) reject(new Error(data.error.message));
      else resolve(data.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { ws, send, ready };
}

async function main() {
  const list = await targets();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('No page target — is the ORVEX window open?');

  const cdp = connect(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');
  const evaluate = async (expression) => {
    const res = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) {
      throw new Error(`evaluate failed: ${res.exceptionDetails.text} ${res.exceptionDetails.exception?.description || ''}`);
    }
    return res.result.value;
  };

  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  };
  const tool = async (name, args) => {
    const res = await evaluate(`window.orvex.tools.run(${JSON.stringify(name)}, ${JSON.stringify(args || {})})`);
    return res && res.ok === true && res.data ? res.data : res;
  };
  const text = (r) => (r && (r.output || r.error)) || '';

  const desktop = require('../electron/desktop.cjs');
  const guardrails = require('../electron/guardrails.cjs');
  const names = desktop.definitions.map((d) => d.name);
  const expected = [
    'screen_capture',
    'screen_info',
    'screen_ocr',
    'ui_tree',
    'ui_action',
    'ui_wait',
    'ui_sequence',
    'mouse_scroll',
    'mouse_drag',
    'mouse_down',
    'mouse_up',
    'window_list',
    'window_action',
    'process_list',
    'process_kill',
    'clipboard_read',
    'clipboard_write',
    'screen_record_start',
    'screen_record_stop',
    'screen_record_status',
    'wait',
  ];
  const missing = expected.filter((n) => !names.includes(n));
  check('Section 3 tools are registered', missing.length === 0, missing.join(', '));

  check('process_kill needs approval', !!guardrails.needsApproval('process_kill', { pid: 1234 }));
  check('window close needs approval', !!guardrails.needsApproval('window_action', { action: 'close' }));
  check('window focus needs no approval', !guardrails.needsApproval('window_action', { action: 'focus' }));
  check('system path still blocked', !!guardrails.checkPath('C:\\Windows\\System32', 'read'));

  const info = await tool('screen_info');
  check('screen_info lists displays', info.ok && /Display #1/.test(text(info)) && /Cursor now/.test(text(info)), text(info).split('\n')[0]);

  const shot = await tool('screen_capture');
  check('screen_capture saves a PNG', shot.ok && /Screenshot saved:/.test(text(shot)) && fs.existsSync(shot.image), shot.image);
  const region = await tool('screen_capture', { region: { x: 20, y: 20, width: 240, height: 160 } });
  check('screen_capture crops a region', region.ok && /-r20-20-240x160/.test(text(region)) && fs.existsSync(region.image), region.image);
  const all = await tool('screen_capture', { all: true });
  check('screen_capture all:true handles every display', all.ok && /Captured \d+ display/.test(text(all)), text(all).split('\n')[0]);

  const clipText = `orvex clipboard ${Date.now()}`;
  const cw = await tool('clipboard_write', { text: clipText });
  const cr = await tool('clipboard_read');
  check('clipboard round-trips text', cw.ok && cr.ok && text(cr).includes(clipText));

  const testImage = makeOcrImage();
  const ocr = await tool('screen_ocr', { path: testImage.replace(/\\/g, '/') });
  check(
    'screen_ocr reads a real image',
    ocr.ok && /ORVEX OCR SMOKE 98765/.test(text(ocr)) && /line/.test(text(ocr)),
    text(ocr).split('\n')[0],
  );

  const wins = await tool('window_list', { limit: 15 });
  check('window_list enumerates windows', wins.ok && /hwnd \d+/.test(text(wins)), text(wins).split('\n')[0]);

  const procs = await tool('process_list', { limit: 8 });
  check('process_list enumerates processes', procs.ok && /\(pid \d+\)/.test(text(procs)), text(procs).split('\n')[0]);

  const scroll = await tool('mouse_scroll', { amount: 1, x: 40, y: 40 });
  check('mouse_scroll drives the wheel', scroll.ok && /Scrolled up 1/.test(text(scroll)), text(scroll));

  const waitRes = await tool('wait', { ms: 250 });
  check('wait pauses', waitRes.ok && /Waited 250/.test(text(waitRes)));

  const notepadFile = path.join(os.tmpdir(), 'orvex-desktop-smoke.txt');
  fs.writeFileSync(notepadFile, 'ORVEX desktop smoke test file', 'utf8');
  const launched = await tool('app_open', { target: notepadFile });
  check('app_open opens a text file in Notepad', launched.ok, text(launched).split('\n')[0]);
  let nw = { ok: false, output: '' };
  for (let i = 0; i < 20; i += 1) {
    await sleep(500);
    nw = await tool('window_list', { filter: 'orvex-desktop-smoke' });
    if (nw.ok && /orvex-desktop-smoke\.txt - Notepad/.test(text(nw))) break;
  }
  check('window_list finds Notepad', nw.ok && /orvex-desktop-smoke\.txt - Notepad/.test(text(nw)), text(nw).split('\n')[0]);

  const tree = await tool('ui_tree', { title: 'orvex-desktop-smoke', depth: 5, max: 160 });
  const treeText = text(tree);
  check('ui_tree exposes controls', tree.ok && /Document "Text editor"/.test(treeText) && /\[0\/0\/0\]/.test(treeText), treeText.split('\n')[0]);
  const docPath = (treeText.match(/\[(\d+(?:\/\d+)+)\] Document/) || [])[1] || '0/0/0';

  const focus = await tool('window_action', { title: 'orvex-desktop-smoke', action: 'focus' });
  check('window_action focus works', focus.ok && /focused/.test(text(focus)), text(focus));

  const focusDoc = await tool('ui_action', { title: 'orvex-desktop-smoke', path: docPath, action: 'focus' });
  check('ui_action focuses the document', focusDoc.ok && /focused/.test(text(focusDoc)) && /verified/.test(text(focusDoc)), text(focusDoc));

  const setValue = await tool('ui_action', {
    title: 'orvex-desktop-smoke',
    path: docPath,
    action: 'set_value',
    value: 'ORVEX UIA WRITE OK',
  });
  check(
    'ui_action set_value writes text and verifies it',
    setValue.ok && /value set/.test(text(setValue)) && /verified: the element now reports the new state/.test(text(setValue)),
    text(setValue),
  );
  check(
    'ui_action reports a pixel change for the edited region',
    setValue.ok && /the screen region visibly changed|the screen region looks unchanged/.test(text(setValue)),
    text(setValue).split(' — ').pop(),
  );

  const waitedValue = await tool('ui_wait', {
    title: 'orvex-desktop-smoke',
    match: 'Text editor',
    state: 'value',
    value: 'ORVEX UIA WRITE OK',
    timeoutMs: 3000,
  });
  check(
    'ui_wait sees the value that was just written',
    waitedValue.ok && /Wait met/.test(text(waitedValue)) && /now holds "ORVEX UIA WRITE OK"/.test(text(waitedValue)),
    text(waitedValue),
  );

  const sequence = await tool('ui_sequence', {
    title: 'orvex-desktop-smoke',
    steps: [
      { match: 'Text editor', action: 'focus' },
      { match: 'Text editor', action: 'set_value', value: 'ORVEX SEQUENCE OK' },
    ],
  });
  check(
    'ui_sequence runs and verifies every step',
    sequence.ok && /completed 2 step/.test(text(sequence)) && /verified/.test(text(sequence)),
    text(sequence).split('\n')[0],
  );

  const sequenceStop = await tool('ui_sequence', {
    title: 'orvex-desktop-smoke',
    steps: [
      { path: '0/99/99', action: 'click' },
      { path: docPath, action: 'set_value', value: 'SHOULD NOT RUN' },
    ],
  });
  check(
    'ui_sequence stops at the first failed step',
    sequenceStop.ok !== true && /Step 1/.test(text(sequenceStop)) && /stopped/.test(text(sequenceStop)),
    text(sequenceStop).split('\n')[0],
  );

  const drag = await tool('mouse_drag', { fromX: 300, fromY: 300, toX: 460, toY: 360, durationMs: 300 });
  check('mouse_drag runs', drag.ok && /Dragged from/.test(text(drag)), text(drag));

  const down = await tool('mouse_down', { button: 'left' });
  const moveHeld = await tool('mouse_move', { x: 480, y: 380 });
  const up = await tool('mouse_up', { button: 'left' });
  check('mouse_down and mouse_up hold and release a button', down.ok && moveHeld.ok && up.ok && /held down/.test(text(down)) && /released/.test(text(up)), `${text(down)} / ${text(up)}`);

  const min = await tool('window_action', { title: 'orvex-desktop-smoke', action: 'minimize' });
  check('window_action minimizes', min.ok && /minimized/.test(text(min)), text(min));
  const restore = await tool('window_action', { title: 'orvex-desktop-smoke', action: 'focus' });
  check('window_action refocuses', restore.ok && /focused/.test(text(restore)), text(restore));

  const recStart = await tool('screen_record_start', { fps: 10, audio: 'none' });
  check('screen_record_start begins a recording', recStart.ok && /Recording display/.test(text(recStart)), text(recStart));
  await sleep(3200);
  let recStatus = await tool('screen_record_status');
  if (!/\d+(\.\d+)?(KB|MB)/.test(text(recStatus))) {
    await sleep(2600);
    recStatus = await tool('screen_record_status');
  }
  check('screen_record_status reports progress', recStatus.ok && /Recording .*\.webm/.test(text(recStatus)), text(recStatus));
  const recStop = await tool('screen_record_stop');
  const recMatch = /Recording saved: (.+\.webm) \(([^,]+), (\d+)s\)/.exec(text(recStop));
  const recOk =
    recStop.ok &&
    !!recMatch &&
    fs.existsSync(recMatch[1]) &&
    fs.statSync(recMatch[1]).size > 3000;
  check('screen_record_stop writes a playable .webm', recOk, recMatch ? `${recMatch[1]} ${recMatch[2]}` : text(recStop));

  const { spawn } = require('node:child_process');
  const pingProc = spawn('ping.exe', ['-n', '300', '127.0.0.1'], { stdio: 'ignore', windowsHide: true });
  const ping = { ok: !!pingProc.pid };
  let pingPid = pingProc.pid || 0;
  let pingList = { ok: false, output: '' };
  for (let i = 0; i < 10 && pingPid; i += 1) {
    await sleep(300);
    pingList = await tool('process_list', { filter: 'ping', limit: 20 });
    if (new RegExp(`pid ${pingPid}\\b`).test(text(pingList))) break;
  }
  let killed = pingPid ? await tool('process_kill', { pid: pingPid }) : { ok: false, error: `no ping process. list: ${text(pingList)}` };
  // Windows can recycle or finish a short-lived child between listing and kill.
  if (!killed.ok && /Cannot find a process/i.test(text(killed))) {
    const latest = await tool('process_list', { filter: 'ping', limit: 20 });
    const fresh = [...text(latest).matchAll(/\(pid (\d+)\)/g)].map((m) => Number(m[1]));
    if (fresh.length) {
      pingPid = fresh[0];
      killed = await tool('process_kill', { pid: pingPid });
    }
  }
  await sleep(600);
  const afterKill = await tool('process_list', { filter: 'ping', limit: 20 });
  const pingGone = killed.ok && !new RegExp(`pid ${pingPid}\\b`).test(text(afterKill));
  check(
    'process_kill stops a real process',
    !!ping.ok && !!pingPid && pingGone,
    killed.ok
      ? `pid ${pingPid}${pingGone ? ' gone' : ` still listed: ${text(afterKill)}`}`
      : `${text(killed)} (ping pid ${pingPid || 'none'})`,
  );

  const core = await tool('process_kill', { pid: 4 });
  check('process_kill refuses core system processes', !core.ok && /Refusing/.test(text(core)), text(core));

  const close = await tool('window_action', { title: 'orvex-desktop-smoke', action: 'close' });
  await sleep(1200);
  let afterClose = await tool('window_list', { filter: 'orvex-desktop-smoke' });
  if (!/No open window matches/.test(text(afterClose))) {
    await tool('key_press', { keys: 'ALT+N' });
    await sleep(900);
    afterClose = await tool('window_list', { filter: 'orvex-desktop-smoke' });
  }
  check('window_action closes the test window', close.ok && /No open window matches/.test(text(afterClose)), text(afterClose).split('\n')[0]);

  const failed = results.filter((r) => !r.ok);

  cdp.ws.close();
  try {
    fs.rmSync(notepadFile, { force: true });
  } catch {
    /* best effort */
  }
  if (failed.length) {
    console.error(`desktop smoke FAILED: ${failed.length} check(s)`);
    process.exit(1);
  }
  console.log(`desktop smoke OK: ${results.length} checks`);
}

main().catch((err) => {
  console.error(`desktop smoke crashed: ${err && err.message ? err.message : err}`);
  process.exit(1);
});
