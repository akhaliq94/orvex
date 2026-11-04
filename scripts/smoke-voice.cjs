'use strict';

/**
 * Section 5 Voice smoke test.
 * Unit-tests the deterministic voice engine (bundled from TypeScript with
 * esbuild): wake-word matching, streaming partial merging, barge-in timing,
 * microphone fallback, and the speaker fingerprint/identification maths.
 * No microphone is required.
 */

const path = require('node:path');
const os = require('node:os');
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
  const outfile = path.join(os.tmpdir(), `orvex-voice-engine-${process.pid}.cjs`);
  await esbuild.build({
    entryPoints: [path.join(root, 'src', 'voice', 'index.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    logLevel: 'silent',
  });
  return require(outfile);
}

/** Simple harmonic tone with a soft attack — enough for a stable spectrum. */
function tone(f0, seconds = 1.2, sampleRate = 16000) {
  const n = Math.floor(seconds * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const attack = Math.min(1, i / (0.02 * sampleRate));
    const release = Math.min(1, (n - i) / (0.05 * sampleRate));
    let v = 0;
    for (let k = 1; k <= 5; k++) v += Math.sin(2 * Math.PI * f0 * k * t) / k;
    out[i] = 0.3 * v * attack * release;
  }
  return out;
}

function noise(seconds = 1.0, sampleRate = 16000, seed = 1) {
  const n = Math.floor(seconds * sampleRate);
  const out = new Float32Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = ((s / 0x7fffffff) * 2 - 1) * 0.3;
  }
  return out;
}

(async () => {
  const V = await bundleEngine();

  /* ---------------------------------------------------------------- wake */
  check('wake phrase normalises punctuation and case', () => {
    assert.strictEqual(V.normalizeSpeech('  Hey,   ORVEX!!  '), 'hey orvex');
  });

  check('wake phrase matches and extracts the command', () => {
    const m = V.matchWake('Hey Orvex, open the browser', 'Hey Orvex');
    assert.strictEqual(m.matched, true);
    assert.strictEqual(m.command, 'open the browser');
  });

  check('a one-letter transcription slip still matches in fuzzy mode', () => {
    const m = V.matchWake('hey orwex open chrome', 'Hey Orvex', true);
    assert.strictEqual(m.matched, true);
    assert.strictEqual(m.command, 'open chrome');
  });

  check('strict mode rejects the slip', () => {
    assert.strictEqual(V.matchWake('hey orwex open chrome', 'Hey Orvex', false).matched, false);
  });

  check('unrelated speech does not fire the wake word', () => {
    assert.strictEqual(V.matchWake('hey what is the weather', 'Hey Orvex').matched, false);
    assert.strictEqual(V.matchWake('', 'Hey Orvex').matched, false);
  });

  check('wake gate fires once per cooldown and re-arms', () => {
    const gate = new V.WakeGate({ phrase: 'Hey Orvex', cooldownMs: 2500 });
    const first = gate.feed('hey orvex open chrome', 1000);
    assert.strictEqual(first.triggered, true);
    assert.strictEqual(first.command, 'open chrome');
    assert.strictEqual(gate.feed('hey orvex open chrome', 2000).triggered, false);
    assert.strictEqual(gate.feed('hey orvex open chrome', 4000).triggered, true);
  });

  /* ------------------------------------------------------------ streaming */
  check('partial transcripts merge on the growing prefix', () => {
    assert.strictEqual(V.mergePartial('the quick', 'the quick brown fox'), 'the quick brown fox');
    assert.strictEqual(V.mergePartial('the quick brown fox', 'the quick'), 'the quick brown fox');
  });

  check('overlapping partials are stitched without repetition', () => {
    assert.strictEqual(V.mergePartial('open the quick brown', 'brown fox and run'), 'open the quick brown fox and run');
  });

  check('dissimilar partials keep both halves', () => {
    assert.strictEqual(V.mergePartial('hello there', 'completely different words'), 'hello there completely different words');
  });

  check('streaming session waits for enough audio and the interval', () => {
    const s = new V.StreamingSession({ intervalMs: 900, minBytes: 6000 });
    s.noteChunk(3000, 1000);
    assert.strictEqual(s.shouldRequest(1900), false, 'too few bytes');
    s.noteChunk(4000, 1500);
    assert.strictEqual(s.shouldRequest(1800), false, 'interval not elapsed');
    assert.strictEqual(s.shouldRequest(2000), true);
    s.beginRequest(2000);
    assert.strictEqual(s.shouldRequest(4000), false, 'one upload at a time');
    s.applyPartial('hello world');
    assert.strictEqual(s.shouldRequest(2800), false);
    assert.strictEqual(s.shouldRequest(2900), true);
  });

  check('streaming session finalises with the merged transcript', () => {
    const s = new V.StreamingSession({ intervalMs: 100, minBytes: 100 });
    s.noteChunk(4000, 1000);
    assert.strictEqual(s.shouldRequest(1200), true);
    s.beginRequest(1200);
    assert.strictEqual(s.applyPartial('hey orvex open'), 'hey orvex open');
    assert.strictEqual(s.finalize('hey orvex open chrome'), 'hey orvex open chrome');
    s.reset();
    assert.strictEqual(s.transcript, '');
  });

  /* ------------------------------------------------------------- barge-in */
  check('barge-in needs sustained speech above the threshold', () => {
    const d = new V.BargeInDetector({ threshold: 0.2, holdMs: 260 });
    assert.strictEqual(d.feed(0.1, true, 1000), false);
    assert.strictEqual(d.feed(0.5, true, 1100), false);
    assert.strictEqual(d.feed(0.5, true, 1200), false);
    assert.strictEqual(d.feed(0.5, true, 1300), false);
    assert.strictEqual(d.feed(0.5, true, 1400), true);
    assert.strictEqual(d.feed(0.5, true, 1500), false, 'fires once');
  });

  check('barge-in re-arms after the microphone goes quiet', () => {
    const d = new V.BargeInDetector({ threshold: 0.2, holdMs: 200, releaseMs: 500 });
    assert.strictEqual(d.feed(0.6, true, 1000), false);
    assert.strictEqual(d.feed(0.6, true, 1250), true);
    assert.strictEqual(d.feed(0.05, true, 1300), false);
    assert.strictEqual(d.feed(0.05, true, 1850), false, 'quiet for the release window');
    assert.strictEqual(d.feed(0.6, true, 1900), false);
    assert.strictEqual(d.feed(0.6, true, 2150), true);
  });

  check('barge-in never fires while disabled', () => {
    const d = new V.BargeInDetector({ threshold: 0.1, holdMs: 100 });
    for (let t = 1000; t < 3000; t += 100) assert.strictEqual(d.feed(0.9, false, t), false);
  });

  /* -------------------------------------------------------------- devices */
  check('selected microphone falls back to the default when missing', () => {
    const devices = [
      { id: 'mic-a', label: 'A', isDefault: true },
      { id: 'mic-b', label: 'B', isDefault: false },
    ];
    assert.strictEqual(V.resolveMic(devices, 'mic-b'), 'mic-b');
    assert.strictEqual(V.resolveMic(devices, 'gone'), 'mic-a');
    assert.strictEqual(V.resolveMic([], 'mic-a'), null);
  });

  check('microphone constraints carry the chosen device and processing flags', () => {
    const c = V.micConstraints('mic-b', { echoCancellation: true, noiseSuppression: false, autoGainControl: true });
    assert.deepStrictEqual(c.audio.deviceId, { exact: 'mic-b' });
    assert.strictEqual(c.audio.echoCancellation, true);
    assert.strictEqual(c.audio.noiseSuppression, false);
    assert.strictEqual(V.micConstraints(null, { echoCancellation: true, noiseSuppression: true, autoGainControl: true }).audio.deviceId, undefined);
  });

  /* ------------------------------------------------------------- speaker */
  check('silent audio produces no voice fingerprint', () => {
    assert.deepStrictEqual(V.extractFeatures(new Float32Array(32000), 16000), []);
  });

  check('voice fingerprints are stable for the same voice', () => {
    const a = V.extractFeatures(tone(120), 16000);
    const b = V.extractFeatures(tone(120), 16000);
    assert.ok(a.length === 50, `expected 50 dims, got ${a.length}`);
    assert.ok(V.cosine(a, b) > 0.999);
  });

  check('different voices produce clearly different fingerprints', () => {
    const low = V.extractFeatures(tone(110), 16000);
    const high = V.extractFeatures(tone(260), 16000);
    assert.ok(V.cosine(low, high) < 0.8, `similarity ${V.cosine(low, high).toFixed(3)}`);
  });

  check('speaker identification picks the enrolled profile', () => {
    const low = V.extractFeatures(tone(110), 16000);
    const high = V.extractFeatures(tone(260), 16000);
    const profiles = [
      { id: 'p1', name: 'Low', vector: low, createdAt: 1, clips: 1 },
      { id: 'p2', name: 'High', vector: high, createdAt: 2, clips: 1 },
    ];
    const hit = V.identify(V.extractFeatures(tone(110, 0.9), 16000), profiles, 0.8);
    assert.ok(hit && hit.profile.id === 'p1', 'expected the low-voice profile');
    assert.ok(hit.score > 0.9);
  });

  check('speaker identification rejects an unknown voice', () => {
    const low = V.extractFeatures(tone(110), 16000);
    const profiles = [{ id: 'p1', name: 'Low', vector: low, createdAt: 1, clips: 1 }];
    assert.strictEqual(V.identify(V.extractFeatures(noise(1.0, 16000, 7), 16000), profiles, 0.9), null);
  });

  check('profile merging keeps a normalised vector of the same shape', () => {
    const a = V.extractFeatures(tone(140), 16000);
    const b = V.extractFeatures(tone(150), 16000);
    const mixed = V.mergeVector(a, b, 2);
    assert.strictEqual(mixed.length, a.length);
    const norm = Math.sqrt(mixed.reduce((s, x) => s + x * x, 0));
    assert.ok(Math.abs(norm - 1) < 1e-6, `norm ${norm}`);
    assert.ok(V.cosine(mixed, a) > 0.95);
  });

  console.log(`voice smoke OK: ${pass} checks`);
})().catch((err) => {
  console.error('voice smoke FAILED:', err && err.message ? err.message : err);
  process.exit(1);
});
