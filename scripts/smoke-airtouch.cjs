'use strict';

/**
 * Section 4 Air Touch smoke test.
 * Unit-tests the pure hand engine (bundled from TypeScript with esbuild) and
 * verifies the packaged camera assets exist and the desktop tool surface is
 * wired. No camera is required for these checks.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

const root = path.resolve(__dirname, '..');
let pass = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
    pass++;
  } catch (err) {
    console.log(`FAIL ${name} — ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
  }
}

async function bundleEngine() {
  const esbuild = require('esbuild');
  const outfile = path.join(os.tmpdir(), `orvex-air-engine-${process.pid}.cjs`);
  await esbuild.build({
    entryPoints: [path.join(root, 'src', 'airtouch', 'engine.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    logLevel: 'silent',
  });
  return require(outfile);
}

function hand({ index = 'up', middle = 'up', ring = 'up', pinky = 'up', pinch = false } = {}) {
  const lm = new Array(21).fill(null).map(() => ({ x: 0.5, y: 0.5 }));
  lm[0] = { x: 0.5, y: 0.9 }; // wrist
  lm[9] = { x: 0.5, y: 0.6 }; // middle MCP (scale 0.3)
  const fingers = {
    index: { mcp: 5, pip: 6, tip: 8, x: 0.44, pipY: 0.45, upY: 0.32, downY: 0.66 },
    middle: { mcp: 9, pip: 10, tip: 12, x: 0.5, pipY: 0.45, upY: 0.28, downY: 0.66 },
    ring: { mcp: 13, pip: 14, tip: 16, x: 0.56, pipY: 0.47, upY: 0.34, downY: 0.67 },
    pinky: { mcp: 17, pip: 18, tip: 20, x: 0.62, pipY: 0.52, upY: 0.4, downY: 0.7 },
  };
  const state = { index, middle, ring, pinky };
  for (const [name, f] of Object.entries(fingers)) {
    lm[f.mcp] = { x: f.x, y: 0.62 };
    lm[f.pip] = { x: f.x, y: f.pipY };
    lm[f.tip] = { x: f.x, y: state[name] === 'up' ? f.upY : f.downY };
  }
  lm[2] = { x: 0.42, y: 0.82 };
  lm[3] = { x: 0.38, y: 0.78 };
  lm[4] = pinch ? { x: lm[8].x, y: lm[8].y } : { x: 0.34, y: 0.74 };
  return lm;
}

(async () => {
  const E = await bundleEngine();
  const base = {
    sensitivity: 0.55,
    dwellMs: 300,
    dwellRadius: 10,
    dragMs: 550,
    doublePinchMs: 380,
    mirror: true,
    activeX: [0.1, 0.9],
    activeY: [0.1, 0.9],
  };

  check('detects an open palm', () => {
    assert.strictEqual(E.classifyGesture(hand(), false), 'open');
  });

  check('detects a fist', () => {
    assert.strictEqual(E.classifyGesture(hand({ index: 'down', middle: 'down', ring: 'down', pinky: 'down' }), false), 'fist');
  });

  check('detects a pointing hand', () => {
    assert.strictEqual(E.classifyGesture(hand({ middle: 'down', ring: 'down', pinky: 'down' }), false), 'point');
  });

  check('detects a peace sign', () => {
    assert.strictEqual(E.classifyGesture(hand({ ring: 'down', pinky: 'down' }), false), 'peace');
  });

  check('pinch ratio collapses when thumb meets index', () => {
    const far = E.pinchRatio(hand());
    const near = E.pinchRatio(hand({ pinch: true }));
    assert.ok(far > 0.9, `far ratio ${far}`);
    assert.ok(near < 0.05, `near ratio ${near}`);
    assert.strictEqual(E.classifyGesture(hand({ pinch: true }), false), 'pinch');
  });

  check('maps the hand into screen pixels with mirroring', () => {
    const p = E.mapToScreen({ x: 0.2, y: 0.2 }, { x: 0, y: 0, w: 1000, h: 500 }, base);
    assert.strictEqual(p.x, 874);
    assert.strictEqual(p.y, 62);
    const edge = E.mapToScreen({ x: 2, y: -1 }, { x: 10, y: 20, w: 1000, h: 500 }, base);
    assert.strictEqual(edge.x, 10);
    assert.strictEqual(edge.y, 20);
  });

  check('smoothing converges toward the new point', () => {
    let p = { x: 0, y: 0 };
    for (let i = 0; i < 30; i++) p = E.smoothPoint(p, { x: 100, y: 50 }, 0.8);
    assert.ok(Math.abs(p.x - 100) < 1 && Math.abs(p.y - 50) < 1, JSON.stringify(p));
  });

  check('dwell fires once and re-arms after moving away', () => {
    const d = new E.DwellTracker(base);
    let fired = 0;
    for (let t = 1000; t <= 1300; t += 50) {
      if (d.update(500, 500, t, true).fire) fired++;
    }
    assert.strictEqual(fired, 1);
    for (let t = 1350; t <= 1600; t += 50) {
      if (d.update(500, 500, t, true).fire) fired++;
    }
    assert.strictEqual(fired, 1, 'must not refire while still hovering');
    d.update(560, 500, 1650, true);
    for (let t = 1700; t <= 2100; t += 50) {
      if (d.update(560, 500, t, true).fire) fired++;
    }
    assert.strictEqual(fired, 2, 'must re-arm after moving out of the radius');
  });

  check('dwell progress rises and resets on movement', () => {
    const d = new E.DwellTracker(base);
    d.update(0, 0, 1000, true);
    const half = d.update(0, 0, 1150, true);
    assert.ok(half.progress > 0.4 && half.progress < 0.6, String(half.progress));
    const moved = d.update(50, 50, 1200, true);
    assert.strictEqual(moved.progress, 0);
  });

  check('pinch click waits one double-click window', () => {
    const p = new E.PinchTracker(base);
    p.update(0.1, 1000, true);
    assert.strictEqual(p.update(1.2, 1100, true).event, null);
    assert.strictEqual(p.update(1.2, 1200, true).event, null);
    assert.strictEqual(p.update(1.2, 1500, true).event, 'click');
  });

  check('double pinch produces a double-click, not two singles', () => {
    const p = new E.PinchTracker(base);
    p.update(0.1, 1000, true);
    p.update(1.2, 1100, true);
    p.update(0.1, 1150, true);
    const ev = p.update(1.2, 1250, true);
    assert.strictEqual(ev.event, 'double-click');
    assert.strictEqual(p.update(1.2, 1800, true).event, null);
  });

  check('pinch and hold turns into a drag', () => {
    const p = new E.PinchTracker(base);
    p.update(0.1, 1000, true);
    assert.strictEqual(p.update(0.1, 1300, true).event, null);
    assert.strictEqual(p.update(0.1, 1600, true).event, 'drag-start');
    assert.strictEqual(p.update(0.1, 1800, true).event, null);
    assert.strictEqual(p.update(1.2, 2000, true).event, 'drag-end');
  });

  check('disabling tracking cancels a drag and pending click', () => {
    const p = new E.PinchTracker(base);
    p.update(0.1, 1000, true);
    p.update(0.1, 1600, true);
    const off = p.update(1.2, 1700, false);
    assert.strictEqual(off.event, 'drag-end');
    assert.strictEqual(p.update(1.2, 2200, true).event, null);
  });

  check('gesture hold tracks how long a pose is held', () => {
    const h = new E.GestureHold();
    h.update('open', 1000);
    const held = h.update('open', 1700);
    assert.strictEqual(held.gesture, 'open');
    assert.ok(held.heldMs >= 700 && held.since === 1000);
    const changed = h.update('point', 2000);
    assert.strictEqual(changed.heldMs, 0);
  });

  check('media assets are bundled with the app', () => {
    const model = path.join(root, 'public', 'mediapipe', 'hand_landmarker.task');
    assert.ok(fs.existsSync(model), 'hand_landmarker.task is missing');
    assert.ok(fs.statSync(model).size > 5_000_000, 'model looks truncated');
    for (const f of ['vision_wasm_internal.js', 'vision_wasm_internal.wasm', 'vision_wasm_nosimd_internal.js', 'vision_wasm_nosimd_internal.wasm']) {
      assert.ok(fs.existsSync(path.join(root, 'public', 'mediapipe', 'wasm', f)), `${f} is missing`);
    }
  });

  check('media asset server refuses traversal and unknown files', () => {
    const server = require(path.join(root, 'electron', 'media-server.cjs'));
    assert.strictEqual(server.isSafeRel('../secrets.json'), false);
    assert.strictEqual(server.isSafeRel('wasm/../../secrets.json'), false);
    assert.strictEqual(server.isSafeRel('wasm/vision_wasm_internal.wasm'), true);
    assert.ok(typeof server.start === 'function' && typeof server.stop === 'function');
  });

  const server = require(path.join(root, 'electron', 'media-server.cjs'));
  try {
    const info = await server.start({ dirs: [path.join(root, 'public', 'mediapipe')] });
    const head = await fetch(`${info.baseUrl}/hand_landmarker.task`, { method: 'HEAD' });
    assert.strictEqual(head.status, 200, `model HEAD ${head.status}`);
    assert.strictEqual(Number(head.headers.get('content-length')), fs.statSync(path.join(root, 'public', 'mediapipe', 'hand_landmarker.task')).size);
    assert.strictEqual(head.headers.get('access-control-allow-origin'), '*');
    const wasmHead = await fetch(`${info.baseUrl}/wasm/vision_wasm_internal.wasm`, { method: 'HEAD' });
    assert.strictEqual(wasmHead.status, 200, `wasm HEAD ${wasmHead.status}`);
    assert.strictEqual(wasmHead.headers.get('content-type'), 'application/wasm');
    const missing = await fetch(`${info.baseUrl}/nope.task`);
    assert.strictEqual(missing.status, 404);
    const traversal = await fetch(`${info.baseUrl}/%2e%2e%2fsecrets.json`);
    assert.strictEqual(traversal.status, 404);
    const noToken = await fetch(info.baseUrl.replace(/\/[0-9a-f]{36}\//, '/000000000000000000000000000000000000/') + '/hand_landmarker.task');
    assert.strictEqual(noToken.status, 404);
    console.log('PASS media server serves the bundled model and wasm over 127.0.0.1');
    pass++;
  } catch (err) {
    console.log(`FAIL media server HTTP behavior — ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
  } finally {
    server.stop();
  }

  console.log(pass + ' air-touch checks passed');
})().catch((err) => {
  console.error('air-touch smoke crashed:', err);
  process.exit(1);
});
