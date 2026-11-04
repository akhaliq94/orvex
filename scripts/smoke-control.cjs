'use strict';

/**
 * Section 11 Control PC backend smoke over CDP.
 * Requires the ORVEX window running with --remote-debugging-port=9222.
 *
 * Covers the real machine paths the Control PC page depends on:
 * system status, CoreAudio volume/mute, WMI brightness (honest when missing),
 * media/volume keys, screen capture + region/all, OCR structure, window and
 * process lists, clipboard text/image, screen recording lifecycle, source URLs
 * and the guardrails that stop dangerous kills.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PORT = Number(process.env.ORVEX_CDP_PORT || 9222);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeOcrImage() {
  const file = path.join(os.tmpdir(), `orvex-control-ocr-${Date.now()}.png`);
  const script = path.join(os.tmpdir(), `orvex-control-ocr-${Date.now()}.ps1`);
  fs.writeFileSync(
    script,
    `Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap 1000,280
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::White)
$font = New-Object System.Drawing.Font('Segoe UI', 44)
$g.DrawString('ORVEX CONTROL OCR 2026', $font, [System.Drawing.Brushes]::Black, 30, 40)
$g.DrawString('A second line for the machine test', $font, [System.Drawing.Brushes]::Black, 30, 150)
$bmp.Save('${file.replace(/\\/g, '/')}', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
`,
    'utf8',
  );
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
    timeout: 60000,
    windowsHide: true,
  });
  fs.rmSync(script, { force: true });
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

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  const list = await targets();
  const page = list.find((t) => t.type === 'page' && !/recorder\.html/.test(t.url));
  if (!page) throw new Error('No page target — is the ORVEX window open?');
  const cdp = connect(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');

  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'evaluate failed');
    }
    return r.result.value;
  };
  const deskEval = (body) =>
    evaluate(`(async () => {
      const api = window.orvex && window.orvex.desktop;
      if (!api) return { ok: false, error: 'desktop bridge missing' };
      ${body}
    })()`);
  const desk = async (call, ...args) =>
    deskEval(`
      const r = await api.${call}(${args.map((a) => JSON.stringify(a)).join(', ')});
      return r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error };
    `);
  const tool = async (name, args) => {
    const res = await evaluate(`window.orvex.tools.run(${JSON.stringify(name)}, ${JSON.stringify(args || {})})`);
    return res && res.ok === true && res.data ? { ok: true, data: res.data } : { ok: false, error: (res && res.error) || 'tool failed' };
  };

  const desktop = require('../electron/desktop.cjs');
  const guardrails = require('../electron/guardrails.cjs');

  console.log('\n— bridge and tool registration');
  const bridgeKeys = await evaluate(`Object.keys(window.orvex.desktop || {})`);
  const needed = [
    'system', 'volume', 'brightness', 'screenInfo', 'capture', 'ocr', 'uiTree', 'uiAction',
    'mouseMove', 'mouseClick', 'mouseScroll', 'mouseDrag', 'mouseDown', 'mouseUp',
    'keyType', 'keyPress', 'windows', 'windowAction', 'processes', 'processKill',
    'clipboardRead', 'clipboardWrite', 'recordStart', 'recordStop', 'recordStatus',
    'source', 'exportFile', 'reveal',
  ];
  check('preload exposes the full desktop bridge', needed.every((k) => bridgeKeys.includes(k)), `${bridgeKeys.length} methods`);
  const names = desktop.definitions.map((d) => d.name);
  check(
    'system_status, system_volume and system_brightness tools are registered',
    ['system_status', 'system_volume', 'system_brightness'].every((n) => names.includes(n)),
    names.filter((n) => n.startsWith('system_')).join(', '),
  );
  const keyDef = desktop.definitions.find((d) => d.name === 'key_press');
  check(
    'key_press documents the media and volume keys',
    ['MEDIAPLAY', 'MEDIANEXT', 'MEDIAPREV', 'VOLUMEUP', 'VOLUMEDOWN', 'VOLUMEMUTE'].every((k) => keyDef.description.includes(k)),
  );
  check('process_kill still needs approval', !!guardrails.needsApproval('process_kill', { pid: 1234 }));
  check('system_volume needs no approval', !guardrails.needsApproval('system_volume', { level: 20 }));
  check('system paths stay blocked', !!guardrails.checkPath('C:\\Windows\\System32', 'read'));

  console.log('\n— system status');
  const status = await desk('system');
  const s = status.ok ? status.data : {};
  check(
    'system() returns real machine facts',
    status.ok &&
      typeof s.hostname === 'string' && s.hostname.length > 0 &&
      s.cores >= 1 && typeof s.cpu === 'string' &&
      s.memory && s.memory.total > 0 && s.memory.used > 0 && s.memory.used <= s.memory.total &&
      s.uptimeSec > 0 && s.displays >= 1 && Array.isArray(s.addresses) &&
      typeof s.node === 'string' && /^\d+\./.test(s.node),
    status.ok ? `${s.hostname} · ${s.cores} threads · ${Math.round(s.memory.used / 1024 ** 3)}GB / ${Math.round(s.memory.total / 1024 ** 3)}GB` : status.error,
  );
  const statusTool = await tool('system_status');
  check(
    'system_status tool reports host, RAM and volume state',
    statusTool.ok && /threads/.test(statusTool.data.output) && /RAM/.test(statusTool.data.output),
    statusTool.ok ? statusTool.data.output.split('\n')[0] : statusTool.error,
  );

  console.log('\n— real volume and mute through CoreAudio');
  const before = status.ok ? { volume: s.volume, muted: s.muted } : { volume: null, muted: false };
  const volumeSupported = status.ok && s.volume != null;
  if (volumeSupported) {
    const set = await desk('volume', { level: 23 });
    check('volume() sets the system level', set.ok && set.data.supported === true && set.data.volume === 23, set.ok ? set.data.output : set.error);
    const read = await desk('volume');
    check('volume() reads the level back from Windows', read.ok && read.data.volume === 23, read.ok ? read.data.output : read.error);

    const mute = await desk('volume', { mute: true });
    check('volume() mutes the real endpoint', mute.ok && mute.data.muted === true, mute.ok ? mute.data.output : mute.error);
    const unmute = await desk('volume', { mute: false });
    check('volume() unmutes the real endpoint', unmute.ok && unmute.data.muted === false, unmute.ok ? unmute.data.output : unmute.error);

    const badHigh = await desk('volume', { level: 101 });
    check('volume() rejects levels above 100', !badHigh.ok && /0 to 100/.test(badHigh.error), badHigh.ok ? 'accepted 101' : badHigh.error);
    const badText = await desk('volume', { level: 'loud' });
    check('volume() rejects non-numeric levels', !badText.ok, badText.ok ? 'accepted text' : badText.error);

    const target = await desk('volume', { level: 50 });
    const up = await desk('keyPress', 'VOLUMEUP');
    await sleep(400);
    const afterUp = await desk('volume');
    check(
      'VOLUMEUP really raises the system volume',
      target.ok && up.ok && afterUp.ok && afterUp.data.volume >= 50,
      `${afterUp.ok ? `${before.volume}% → ${afterUp.data.volume}%` : up.error}`,
    );
    const down = await desk('keyPress', 'VOLUMEDOWN');
    await sleep(400);
    const afterDown = await desk('volume');
    check(
      'VOLUMEDOWN really lowers the system volume',
      down.ok && afterDown.ok && afterDown.data.volume < afterUp.data.volume,
      afterDown.ok ? `${afterUp.data.volume}% → ${afterDown.data.volume}%` : down.error,
    );
    const unknown = await desk('keyPress', 'BOGUSKEY');
    check('key_press rejects an unknown key', !unknown.ok && /Unknown key/.test(unknown.error), unknown.ok ? 'accepted BOGUSKEY' : unknown.error);

    const restored = await desk('volume', { level: before.volume, mute: before.muted });
    check('volume and mute return to their original state', restored.ok && restored.data.volume === before.volume && restored.data.muted === before.muted, restored.ok ? restored.data.output : restored.error);
  } else {
    check('volume() honestly reports unavailable endpoints', status.ok, status.ok ? 'no active output device' : status.error);
  }

  console.log('\n— brightness honesty');
  const bright = await desk('brightness');
  if (bright.ok && bright.data.supported) {
    check('brightness() reads a real level', typeof bright.data.level === 'number' && bright.data.level >= 0 && bright.data.level <= 100, bright.data.output);
    const original = bright.data.level;
    const set = await desk('brightness', { level: 55 });
    check('brightness() sets the display level', set.ok && set.data.level === 55, set.ok ? set.data.output : set.error);
    const restored = await desk('brightness', { level: original });
    check('brightness() restores the level', restored.ok && restored.data.level === original, restored.ok ? restored.data.output : restored.error);
  } else {
    check(
      'brightness() reports an honest unsupported state',
      bright.ok && bright.data.supported === false && /not available/i.test(bright.data.output),
      bright.ok ? bright.data.output : bright.error,
    );
  }
  const brightBad = await desk('brightness', { level: 120 });
  check('brightness() rejects levels above 100', !brightBad.ok && /0 to 100/.test(brightBad.error), brightBad.ok ? 'accepted 120' : brightBad.error);

  console.log('\n— screen capture with real files and preview URLs');
  const info = await desk('screenInfo');
  check(
    'screenInfo() lists displays, bounds and cursor',
    info.ok && info.data.displays.length >= 1 && info.data.displays.every((d) => d.id != null && d.w > 0 && d.h > 0 && typeof d.primary === 'boolean') &&
      info.data.bounds.w > 0 && info.data.bounds.h > 0 && typeof info.data.cursor.x === 'number',
    info.ok ? info.data.displays.map((d) => `${d.id}:${d.w}x${d.h}`).join(', ') : info.error,
  );

  const shot = await desk('capture');
  const shotData = shot.ok ? shot.data : {};
  let pngMagic = false;
  try {
    const head = fs.readFileSync(shotData.file).subarray(0, 8);
    pngMagic = head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  } catch {
    /* file missing is caught below */
  }
  check(
    'capture() writes a real PNG with dimensions and display id',
    shot.ok && pngMagic && shotData.width > 0 && shotData.height > 0 && shotData.display != null &&
      typeof shotData.origin.x === 'number' && typeof shotData.offset.x === 'number',
    shot.ok ? `${shotData.file} ${shotData.width}x${shotData.height}` : shot.error,
  );
  check(
    'capture() attaches a tokenised preview URL that the renderer can fetch',
    shot.ok && /^orvex-media:\/\/source\/[0-9a-f-]+\//.test(String(shotData.url)) &&
      (await evaluate(`fetch(${JSON.stringify(shotData.url)}).then((r) => r.status)`)) === 200,
    shot.ok ? String(shotData.url).slice(0, 60) : 'no url',
  );

  const region = await desk('capture', { region: { x: 20, y: 20, width: 240, height: 160 } });
  check(
    'capture() crops the requested region',
    region.ok && region.data.width === 240 && region.data.height === 160 && /-r20-20-240x160\.png$/.test(region.data.file),
    region.ok ? `${region.data.width}x${region.data.height}` : region.error,
  );
  const all = await desk('capture', { all: true });
  check(
    'capture({all:true}) covers every display',
    all.ok && all.data.files.length === (all.data.displays || info.data.displays.length) &&
      all.data.files.every((f) => fs.existsSync(f.file) && /^orvex-media:\/\/source\//.test(f.url)),
    all.ok ? `${all.data.files.length} display shot(s)` : all.error,
  );

  console.log('\n— OCR structure');
  const ocrImage = makeOcrImage();
  const ocr = await desk('ocr', { path: ocrImage });
  const ocrLines = ocr.ok && Array.isArray(ocr.data.lines) ? ocr.data.lines : [];
  check(
    'ocr() reads a real image into positioned lines',
    ocr.ok && ocrLines.length >= 2 && /ORVEX CONTROL OCR 2026/.test(ocr.data.text) &&
      ocrLines.every((l) => typeof l.text === 'string' && typeof l.x === 'number' && typeof l.y === 'number' && l.w > 0 && l.h > 0) &&
      fs.existsSync(ocr.data.file) && /^orvex-media:\/\/source\//.test(String(ocr.data.url)),
    ocr.ok ? `${ocr.data.lines.length} lines (${ocr.data.width}x${ocr.data.height})` : ocr.error,
  );
  const live = await desk('ocr', {});
  check(
    'ocr() can capture and read the live screen',
    live.ok && live.data.width > 0 && live.data.height > 0 && Array.isArray(live.data.lines) && typeof live.data.text === 'string',
    live.ok ? `${live.data.lines.length} live line(s)` : live.error,
  );

  console.log('\n— windows and processes');
  const wins = await desk('windows', { limit: 20 });
  check(
    'windows() returns structured rows',
    wins.ok && wins.data.windows.length >= 1 &&
      wins.data.windows.every((w) => w.hwnd > 0 && w.pid > 0 && typeof w.title === 'string' && typeof w.state === 'string' && typeof w.cls === 'string'),
    wins.ok ? `${wins.data.windows.length} windows` : wins.error,
  );
  const procs = await desk('processes', { limit: 12, sort: 'name' });
  const rows = procs.ok ? procs.data.processes : [];
  const sortedByName = rows.every((p, i) => i === 0 || String(rows[i - 1].name).localeCompare(String(p.name)) <= 0);
  check(
    'processes() returns sorted structured rows',
    procs.ok && rows.length >= 1 && procs.data.sort === 'name' && sortedByName &&
      rows.every((p) => p.pid > 0 && typeof p.name === 'string' && typeof p.memMB === 'number'),
    procs.ok ? `${rows.length} processes, first ${rows[0] && rows[0].name}` : procs.error,
  );
  const coreKill = await desk('processKill', { pid: 4 });
  check('processKill() refuses core system pids', !coreKill.ok && /Refusing/.test(coreKill.error), coreKill.ok ? 'killed pid 4' : coreKill.error);

  console.log('\n— clipboard text and image');
  const clipBefore = await desk('clipboardRead');
  const originalClip = clipBefore.ok ? { kind: clipBefore.data.kind, text: clipBefore.data.text, file: clipBefore.data.file } : { kind: 'empty', text: '', file: null };
  const clipText = `orvex control clipboard ${Date.now()}`;
  const wroteText = await desk('clipboardWrite', { text: clipText });
  const readText = await desk('clipboardRead');
  check(
    'clipboard text round-trips',
    wroteText.ok && readText.ok && readText.data.kind === 'text' && readText.data.text === clipText && readText.data.formats.length >= 1,
    readText.ok ? `${readText.data.text.length} chars, ${readText.data.formats.join(', ')}` : readText.error,
  );
  const wroteImage = await desk('clipboardWrite', { imagePath: ocrImage });
  const readImage = await desk('clipboardRead');
  check(
    'clipboard image round-trips with a preview URL',
    wroteImage.ok && readImage.ok && readImage.data.kind === 'image' && readImage.data.width > 0 && readImage.data.height > 0 &&
      fs.existsSync(readImage.data.file) && /^orvex-media:\/\/source\//.test(String(readImage.data.url)),
    readImage.ok ? `${readImage.data.width}x${readImage.data.height}` : readImage.error,
  );
  const emptyWrite = await desk('clipboardWrite', { text: '' });
  check('clipboardWrite() refuses empty payloads', !emptyWrite.ok && /Nothing to copy/.test(emptyWrite.error), emptyWrite.ok ? 'accepted empty' : emptyWrite.error);
  if (originalClip.kind === 'text' && originalClip.text) await desk('clipboardWrite', { text: originalClip.text });
  if (originalClip.kind === 'image' && originalClip.file && fs.existsSync(originalClip.file)) {
    await desk('clipboardWrite', { imagePath: originalClip.file });
  }

  console.log('\n— screen recording lifecycle');
  const start = await desk('recordStart', { fps: 10, audio: 'none' });
  check(
    'recordStart() begins a real recording',
    start.ok && !!start.data.file && fs.existsSync(start.data.file) && start.data.display != null && /Recording display/.test(start.data.output),
    start.ok ? start.data.file : start.error,
  );
  await sleep(3200);
  let mid = await desk('recordStatus');
  if (!mid.ok || !(mid.data.bytes > 0)) {
    await sleep(2800);
    mid = await desk('recordStatus');
  }
  check(
    'recordStatus() reports live seconds and bytes',
    mid.ok && mid.data.active === true && mid.data.seconds >= 1 && mid.data.bytes > 0,
    mid.ok ? `${mid.data.seconds}s, ${mid.data.bytes} bytes` : mid.error,
  );
  const stopped = await desk('recordStop');
  const recFile = stopped.ok ? stopped.data.file : null;
  let recBytes = 0;
  try {
    recBytes = recFile ? fs.statSync(recFile).size : 0;
  } catch {
    /* handled by the check */
  }
  check(
    'recordStop() finalizes a playable .webm',
    stopped.ok && !!recFile && recBytes > 3000 && stopped.data.seconds >= 1 &&
      /^orvex-media:\/\/source\//.test(String(stopped.data.url || '')),
    stopped.ok ? `${recFile} (${recBytes} bytes)` : stopped.error,
  );
  const idle = await desk('recordStatus');
  check('recordStatus() returns to idle after stop', idle.ok && idle.data.active === false, idle.ok ? idle.data.output : idle.error);

  const source = await desk('source', ocrImage);
  check(
    'source() registers an authorised preview token',
    source.ok && /^orvex-media:\/\/source\/[0-9a-f-]+\//.test(source.data.url) &&
      source.data.bytes > 0 && source.data.mime === 'image/png',
    source.ok ? source.data.url.slice(0, 60) : source.error,
  );

  try {
    if (recFile) fs.rmSync(recFile, { force: true });
  } catch {
    /* best effort */
  }
  fs.rmSync(ocrImage, { force: true });

  const failed = results.filter((r) => !r.ok);
  cdp.ws.close();
  if (failed.length) {
    console.error(`\ncontrol smoke FAILED: ${failed.length}/${results.length} checks`);
    process.exit(1);
  }
  console.log(`\ncontrol smoke OK: ${results.length} checks`);
}

main().catch((err) => {
  console.error(`control smoke crashed: ${err && err.message ? err.message : err}`);
  process.exit(1);
});
