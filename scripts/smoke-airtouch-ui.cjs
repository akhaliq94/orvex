'use strict';

/**
 * Section 4 Air Touch UI smoke test over CDP.
 * Verifies the page renders, the loopback model host is reachable from the
 * renderer, MediaPipe actually initialises, and a missing camera is reported
 * honestly (this machine has no webcam).
 */

const PORT = Number(process.env.ORVEX_CDP_PORT || 9222);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

let pass = 0;
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`);
    pass++;
  } else {
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    process.exitCode = 1;
  }
}

async function main() {
  const list = await targets();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('No page target — is the ORVEX window open?');
  const cdp = connect(page.webSocketDebuggerUrl);
  await cdp.ready;

  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'evaluate failed');
    return r.result.value;
  };
  const until = async (expression, timeoutMs, label) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const v = await evaluate(expression);
      if (v) return v;
      await sleep(400);
    }
    throw new Error(`Timed out waiting for ${label}`);
  };

  await evaluate(`(() => {
    const item = [...document.querySelectorAll('.nav-item')].find((b) => b.textContent.includes('Air Touch'));
    if (item) item.click();
    return !!item;
  })()`);
  await until(`document.querySelector('.page-title')?.textContent === 'Air Touch'`, 10000, 'the Air Touch page');

  const shell = await evaluate(`(() => ({
    title: document.querySelector('.page-title')?.textContent,
    buttons: [...document.querySelectorAll('.air-btn')].map((b) => b.textContent.trim()),
    gestures: document.querySelector('.air-list')?.innerText || '',
    hasVideo: !!document.querySelector('video.air-video'),
    hasOverlay: !!document.querySelector('canvas.air-overlay'),
    chip: document.querySelector('.air-chip')?.textContent,
    emptyText: document.querySelector('.air-stage-empty')?.innerText || ''
  }))()`);
  check('Air Touch page opens from the sidebar', shell.title === 'Air Touch');
  check('start, stop and restart controls render', /Start/.test(shell.buttons.join('|')) && /Emergency stop/.test(shell.buttons.join('|')) && /Restart/.test(shell.buttons.join('|')), shell.buttons.join(', '));
  check('gesture guide and camera preview render', shell.hasVideo && shell.hasOverlay && /Pinch/.test(shell.gestures) && /Fist/.test(shell.gestures));
  check('page starts idle with a clear prompt', shell.chip === 'IDLE' && /Start Air Touch/.test(shell.emptyText), shell.chip);

  const assets = await evaluate(`window.orvex.media.assets().then((r) => r.ok ? r.data : { error: r.error })`);
  check('media asset host is a tokenised loopback URL', !!assets.baseUrl && /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{36}\/mediapipe$/.test(assets.baseUrl), assets.baseUrl || assets.error);

  if (assets.baseUrl) {
    const modelHead = await evaluate(`fetch(${JSON.stringify(assets.baseUrl + '/hand_landmarker.task')}, { method: 'HEAD' }).then((r) => ({ status: r.status, size: Number(r.headers.get('content-length')), cors: r.headers.get('access-control-allow-origin') }))`);
    check('renderer can read the bundled hand model', modelHead.status === 200 && modelHead.size > 5_000_000 && modelHead.cors === '*', JSON.stringify(modelHead));
    const wasmHead = await evaluate(`fetch(${JSON.stringify(assets.baseUrl + '/wasm/vision_wasm_internal.wasm')}, { method: 'HEAD' }).then((r) => ({ status: r.status, type: r.headers.get('content-type') }))`);
    check('renderer can read the MediaPipe wasm', wasmHead.status === 200 && wasmHead.type === 'application/wasm', JSON.stringify(wasmHead));
  }

  await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith('Test model'));
    if (b) b.click();
    return !!b;
  })()`);
  const note = await until(
    `(() => { const n = [...document.querySelectorAll('.air-note')].map((x) => x.textContent).join(' | '); return /Model OK|Model test failed/.test(n) ? n : ''; })()`,
    90000,
    'the model self-test',
  );
  check('MediaPipe loads the bundled wasm + model in the renderer', /Model OK/.test(note), note.slice(0, 180));

  await evaluate(`(() => {
    const b = [...document.querySelectorAll('.air-btn')].find((x) => x.textContent.trim() === 'Start');
    if (b) b.click();
    return !!b;
  })()`);
  const cameraState = await until(
    `(() => {
      const chip = document.querySelector('.air-chip')?.textContent || '';
      const text = document.querySelector('.air-stage-empty')?.innerText || '';
      return chip === 'ERROR' || chip === 'LIVE' ? chip + ' :: ' + text : '';
    })()`,
    30000,
    'the camera result',
  );
  check('a missing camera is reported instead of faking tracking', /ERROR/.test(cameraState) && /camera/i.test(cameraState), cameraState.replace(/\s+/g, ' ').slice(0, 200));

  console.log(`air touch UI smoke OK: ${pass} checks`);
  cdp.ws.close();
}

main().catch((err) => {
  console.error('air touch UI smoke FAILED:', err && err.message ? err.message : err);
  process.exit(1);
});
