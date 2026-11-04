'use strict';

/**
 * Game Pilot — plays a named game window with keyboard input.
 *
 * Safety is structural rather than advisory:
 *  - keys are only sent while the configured window is the foreground window;
 *  - only keys listed in the profile are ever pressed;
 *  - every run has an interval, a hard time limit and a global stop shortcut;
 *  - a run that loses the window, the screen or the keyboard stops itself.
 *
 * The loop itself is honest about speed: a vision tick costs a screenshot plus
 * a model call, so this is built for turn-based, puzzle, management and
 * grinding loops — not twitch shooters.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const db = require('./db.cjs');
const core = require('./game-core.cjs');

const PROFILES_KEY = 'gamepilot.profiles';
const STOP_ACCEL = 'CommandOrControl+Alt+Shift+G';
const HISTORY_LIMIT = 20;
const MAX_WINDOW_MISSES = 10;
const MAX_FAILURES = 3;
const MAX_IDLE_REPEATS = 1200;

let ctx = {
  now: () => Date.now(),
  platform: process.platform,
  emit: () => {},
};
let activeRun = null;
let lastRun = null;

function msg(err) {
  return err && err.message ? err.message : String(err);
}

function init(opts = {}) {
  ctx = { ...ctx, ...opts };
  return { hotkey: STOP_ACCEL };
}

function now() {
  return Number(ctx.now()) || Date.now();
}

function emit(event) {
  try {
    ctx.emit({ ...event, at: now() });
  } catch {
    /* the window may be gone */
  }
}

/* ------------------------------------------------------------------ profiles */

function readProfiles() {
  const saved = db.getSetting(PROFILES_KEY, []);
  if (!Array.isArray(saved)) return [];
  const out = [];
  for (const entry of saved) {
    try {
      out.push(core.normalizeProfile(entry));
    } catch {
      /* a profile that no longer validates is skipped, not silently repaired */
    }
  }
  return out;
}

function writeProfiles(profiles) {
  db.setSetting(PROFILES_KEY, profiles.map(core.publicProfile));
}

function listProfiles() {
  return readProfiles().map(core.publicProfile);
}

function saveProfile(input = {}) {
  const profiles = readProfiles();
  const normalized = core.normalizeProfile(input);
  const index = profiles.findIndex((p) => p.id === normalized.id);
  if (index >= 0) {
    normalized.createdAt = profiles[index].createdAt;
    normalized.updatedAt = now();
    profiles[index] = normalized;
  } else {
    if (profiles.length >= core.MAX_PROFILES) {
      throw new Error(`Only ${core.MAX_PROFILES} pilot profiles are kept. Delete one first.`);
    }
    normalized.createdAt = now();
    normalized.updatedAt = now();
    profiles.push(normalized);
  }
  writeProfiles(profiles);
  return core.publicProfile(normalized);
}

function deleteProfile(id) {
  const target = String(id || '');
  if (activeRun && activeRun.profile.id === target) throw new Error('Stop the running pilot before deleting its profile.');
  const profiles = readProfiles();
  const next = profiles.filter((p) => p.id !== target);
  if (next.length === profiles.length) throw new Error('No profile matches that id.');
  writeProfiles(next);
  return { removed: target };
}

/* -------------------------------------------------------------------- status */

function snapshot(run) {
  const profile = run.profile;
  return {
    running: true,
    runId: run.id,
    profileId: profile.id,
    name: profile.name,
    goal: profile.goal,
    policy: profile.policy,
    startedAt: run.startedAt,
    endsAt: run.deadline,
    ticks: run.ticks,
    reused: run.reused,
    bestScore: run.bestScore,
    lastScore: run.lastScore,
    targetScore: profile.targetScore,
    lastAction: run.lastAction,
    lastNote: run.lastNote,
    stopReason: run.stopReason,
    stopReasonLabel: run.stopReason ? core.stopReasonLabel(run.stopReason) : '',
    error: run.error,
    window: run.window,
    history: run.history.slice(-HISTORY_LIMIT),
    hotkey: STOP_ACCEL,
    hotkeyRegistered: run.hotkeyRegistered !== false,
    nextTickAt: run.nextTickAt,
  };
}

function status() {
  if (activeRun) return snapshot(activeRun);
  return {
    running: false,
    hotkey: STOP_ACCEL,
    hotkeyRegistered: false,
    ...(lastRun || {}),
  };
}

function pushHistory(run, action, note, score) {
  run.history.push({
    at: now(),
    tick: run.ticks,
    score: score === undefined ? run.lastScore : score,
    action: action || '',
    note: String(note || '').slice(0, 200),
  });
  if (run.history.length > HISTORY_LIMIT * 2) run.history.splice(0, run.history.length - HISTORY_LIMIT);
}

function emitTick(run) {
  emit({ type: 'tick', ...snapshot(run) });
}

/* ---------------------------------------------------------------------- loop */

function pause(run, ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0));
  const end = now() + total;
  return new Promise((resolve) => {
    const step = () => {
      if (run.stopRequested || now() >= end) {
        resolve();
        return;
      }
      setTimeout(step, Math.min(250, Math.max(1, end - now())));
    };
    step();
  });
}

function captureArgs(profile) {
  const args = {};
  if (profile.region) args.region = profile.region;
  if (profile.display) args.display = profile.display;
  return args;
}

async function findGameWindow(run) {
  const profile = run.profile;
  const list = await ctx.desktop.windowList({ filter: profile.windowTitle, visibleOnly: true, limit: 80 });
  if (!list || list.ok === false) return null;
  const needle = profile.windowTitle.toLowerCase();
  const matches = (Array.isArray(list.windows) ? list.windows : []).filter(
    (w) => w && String(w.title).toLowerCase().includes(needle),
  );
  if (!matches.length) return null;
  const exact = matches.find((w) => String(w.title).toLowerCase() === needle);
  const pick = matches.find((w) => w.foreground) || exact || matches[0];
  if (pick.foreground) return pick;
  if (!profile.autoFocus || typeof ctx.desktop.windowAction !== 'function') return null;
  try {
    await ctx.desktop.windowAction({ action: 'focus', handle: pick.hwnd });
  } catch {
    return null;
  }
  await pause(run, 400);
  const again = await ctx.desktop.windowList({ filter: profile.windowTitle, visibleOnly: true, limit: 80 });
  const hit = (Array.isArray(again && again.windows) ? again.windows : []).find(
    (w) => w.hwnd === pick.hwnd && w.foreground,
  );
  return hit || null;
}

function frameSignature(shot) {
  try {
    const file = shot && (shot.file || shot.image);
    if (!file || typeof file !== 'string' || file.startsWith('data:')) return '';
    return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return '';
  }
}

async function readScore(run, shot) {
  const profile = run.profile;
  if (!profile.scoreRegex && !profile.scoreRegion) return null;
  let source = shot;
  if (profile.scoreRegion) {
    const args = { ...captureArgs(profile), region: profile.scoreRegion };
    const crop = await ctx.desktop.screenCapture(args);
    if (!crop || crop.ok === false) return run.lastScore;
    source = crop;
  }
  const file = source.file || source.image;
  if (!file) return run.lastScore;
  const ocr = await ctx.ocr({ path: file });
  if (!ocr || ocr.ok === false) return run.lastScore;
  return core.parseScore(ocr.text || '', profile.scoreRegex);
}

async function decide(run, shot) {
  const profile = run.profile;
  if (profile.policy === 'macro') {
    const picked = core.nextMacroStep(profile, run.macroIndex);
    run.macroIndex = picked.index + 1;
    return { type: 'key', key: picked.step.keys, waitMs: picked.step.waitMs, note: `macro step ${picked.index + 1}/${profile.macro.length}` };
  }
  const reply = await ctx.ask({
    profile: core.publicProfile(profile),
    shot,
    score: run.lastScore,
    bestScore: run.bestScore,
    history: run.history.slice(-8),
    tick: run.ticks + 1,
  });
  return core.parseBatch(reply, profile.actions.map((a) => a.key), { actMs: profile.actMs });
}

async function stillForeground(run) {
  if (typeof ctx.foregroundOk !== 'function') return true;
  try {
    return !!(await ctx.foregroundOk(run.profile.windowTitle, run.window));
  } catch {
    return false;
  }
}

async function loop(run) {
  const profile = run.profile;
  try {
    while (!run.stopRequested) {
      if (typeof ctx.isStopped === 'function' && ctx.isStopped()) {
        run.stopReason = 'security';
        break;
      }
      if (now() >= run.deadline) {
        run.stopReason = 'time';
        break;
      }

      let win = null;
      try {
        win = await findGameWindow(run);
      } catch (err) {
        run.lastNote = `Window check failed: ${msg(err)}`;
      }
      if (run.stopRequested) break;
      if (!win) {
        run.misses += 1;
        run.lastNote = `Waiting for "${profile.windowTitle}" to be in front (${run.misses}/${MAX_WINDOW_MISSES}).`;
        emitTick(run);
        if (run.misses >= MAX_WINDOW_MISSES) {
          run.stopReason = 'window';
          break;
        }
        await pause(run, Math.max(600, profile.intervalMs));
        continue;
      }
      run.misses = 0;
      run.window = { title: win.title, hwnd: win.hwnd, pid: win.pid };

      let shot = null;
      try {
        shot = await ctx.desktop.screenCapture(captureArgs(profile));
      } catch (err) {
        shot = { ok: false, error: msg(err) };
      }
      if (!shot || shot.ok === false) {
        run.captureErrors += 1;
        run.lastNote = `Screen capture failed: ${(shot && shot.error) || 'unknown error'}`;
        emitTick(run);
        if (run.captureErrors >= MAX_FAILURES) {
          run.stopReason = 'capture';
          run.error = run.lastNote;
          break;
        }
        await pause(run, Math.max(600, profile.intervalMs));
        continue;
      }
      run.captureErrors = 0;

      const score = await readScore(run, shot);
      if (score !== null) {
        run.lastScore = score;
        if (run.bestScore === null || score > run.bestScore) run.bestScore = score;
        if (profile.targetScore !== null && run.bestScore >= profile.targetScore) {
          run.lastNote = `Target score ${profile.targetScore} reached.`;
          run.stopReason = 'target';
          break;
        }
      }

      const signature = frameSignature(shot);
      const replay =
        profile.policy === 'vision' &&
        profile.reuseOnIdle &&
        signature &&
        run.lastBatch &&
        signature === run.lastSig &&
        run.idleRepeats < MAX_IDLE_REPEATS;

      let decision = null;
      if (replay) {
        decision = { type: 'batch', actions: run.lastBatch, reused: true };
        run.idleRepeats += 1;
        run.reused += 1;
        run.lastNote = 'Screen unchanged — reusing the last actions without a model call.';
      } else {
        try {
          decision = await decide(run, shot);
        } catch (err) {
          run.error = msg(err);
          run.stopReason = 'error';
          run.lastNote = `Decision failed: ${run.error}`;
          pushHistory(run, '', run.lastNote, score);
          break;
        }
        run.lastSig = signature;
        run.idleRepeats = 0;
        if (decision && decision.type === 'batch' && profile.policy === 'vision') run.lastBatch = decision.actions;
      }

      if (!decision) {
        run.ticks += 1;
        run.lastNote = profile.policy === 'vision'
          ? 'The model did not return an allowed key — no key was pressed.'
          : 'No macro step was available.';
        pushHistory(run, '', run.lastNote, score);
        emitTick(run);
        await pause(run, profile.intervalMs);
        continue;
      }
      if (decision.type === 'stop') {
        run.stopReason = 'model';
        run.lastNote = decision.reason || 'The model stopped the run.';
        pushHistory(run, 'stop', run.lastNote, score);
        break;
      }

      const batch = decision.type === 'batch' ? decision.actions : [decision];
      let stopNow = false;
      for (const action of batch) {
        if (run.stopRequested) break;
        if (now() >= run.deadline) {
          run.stopReason = 'time';
          stopNow = true;
          break;
        }
        if (typeof ctx.isStopped === 'function' && ctx.isStopped()) {
          run.stopReason = 'security';
          stopNow = true;
          break;
        }
        if (action.type === 'stop') {
          run.stopReason = 'model';
          run.lastNote = action.reason || 'The model stopped the run.';
          pushHistory(run, 'stop', run.lastNote, score);
          stopNow = true;
          break;
        }

        run.ticks += 1;
        if (action.type === 'key') {
          if (!(await stillForeground(run))) {
            run.lastNote = 'The game window is no longer in front — no key was pressed.';
            pushHistory(run, '', run.lastNote, score);
            emitTick(run);
            break;
          }
          let result;
          try {
            result = await ctx.desktop.keyPress({ keys: action.key });
          } catch (err) {
            result = { ok: false, error: msg(err) };
          }
          if (!result || result.ok === false) {
            run.inputErrors += 1;
            run.lastNote = `${action.key} failed: ${(result && result.error) || 'unknown error'}`;
            pushHistory(run, action.key, run.lastNote, score);
            if (run.inputErrors >= MAX_FAILURES) {
              run.stopReason = 'input';
              run.error = run.lastNote;
              stopNow = true;
              break;
            }
          } else {
            run.inputErrors = 0;
            run.lastAction = action.key;
            run.lastNote = action.note || `Pressed ${action.key}`;
            pushHistory(run, action.key, run.lastNote, score);
            await pause(run, action.waitMs === undefined ? profile.actMs : action.waitMs);
          }
        } else if (action.type === 'wait') {
          run.lastAction = `wait ${action.ms} ms`;
          run.lastNote = action.note || `Waiting ${action.ms} ms`;
          pushHistory(run, 'wait', run.lastNote, score);
          await pause(run, action.ms);
        }
        emitTick(run);
      }
      if (stopNow) break;
      if (decision.stopAfter) {
        run.stopReason = 'model';
        run.lastNote = decision.reason || 'The model ended the run.';
        break;
      }
      run.nextTickAt = now() + profile.intervalMs;
      await pause(run, profile.intervalMs);
    }
  } catch (err) {
    run.stopReason = 'error';
    run.error = msg(err);
  }
  await finish(run);
}

async function finish(run) {
  if (run.finished) return;
  run.finished = true;
  const profile = run.profile;
  const endedAt = now();
  if (activeRun === run) activeRun = null;
  run.stopReason = run.stopReason || 'user';
  try {
    if (typeof ctx.unregisterHotkey === 'function') ctx.unregisterHotkey(STOP_ACCEL);
  } catch {
    /* the shortcut may already be gone */
  }
  const status = run.stopReason === 'user'
    ? 'cancelled'
    : ['error', 'capture', 'input'].includes(run.stopReason) ? 'failed' : 'done';
  const score = profile.targetScore && profile.targetScore > 0
    ? Math.max(0, Math.min(1, (run.bestScore || 0) / profile.targetScore))
    : null;
  const summary = {
    ...snapshot({ ...run }),
    running: false,
    endedAt,
    stopReason: run.stopReason,
    stopReasonLabel: core.stopReasonLabel(run.stopReason),
    recorded: false,
  };
  activeRun = null;
  run.stopRequested = true;
  try {
    if (typeof ctx.record === 'function') {
      await ctx.record({
        kind: 'manual',
        goal: `Game Pilot — ${profile.name}${profile.goal ? `: ${profile.goal}` : ''}`,
        status,
        score,
        steps: run.ticks,
        ms: endedAt - run.startedAt,
        plan: {
          profileId: profile.id,
          policy: profile.policy,
          intervalMs: profile.intervalMs,
          actMs: profile.actMs,
          reuseOnIdle: profile.reuseOnIdle,
          reused: run.reused,
          maxMinutes: profile.maxMinutes,
          targetScore: profile.targetScore,
          region: profile.region,
          scoreRegion: profile.scoreRegion,
          scoreRegex: profile.scoreRegex,
          actions: profile.actions,
          macro: profile.macro,
        },
        actions: run.history,
        outcome: {
          bestScore: run.bestScore,
          lastScore: run.lastScore,
          targetScore: profile.targetScore,
          stopReason: run.stopReason,
          stopReasonLabel: core.stopReasonLabel(run.stopReason),
          window: run.window,
          ticks: run.ticks,
          error: run.error,
        },
        error: run.error || undefined,
      });
      summary.recorded = true;
    }
  } catch (err) {
    summary.recordError = msg(err);
  }
  lastRun = summary;
  emit({ type: 'finished', ...summary });
}

/* --------------------------------------------------------------------- start */

function start(profileId) {
  if (activeRun) throw new Error('A Game Pilot run is already active. Stop it first.');
  if (ctx.platform !== 'win32') throw new Error('Game Pilot sends keyboard input through Windows only.');
  if (!ctx.desktop || typeof ctx.desktop.screenCapture !== 'function' || typeof ctx.desktop.keyPress !== 'function') {
    throw new Error('Game Pilot needs the desktop bridge, which is only available inside the ORVEX app.');
  }
  const profile = readProfiles().find((p) => p.id === String(profileId));
  if (!profile) throw new Error('No pilot profile matches that id.');
  if (profile.policy === 'vision') {
    if (typeof ctx.visionProblem === 'function') {
      const problem = ctx.visionProblem();
      if (problem) throw new Error(problem);
    }
    if (typeof ctx.ask !== 'function') throw new Error('Vision profiling needs a model callback.');
  }
  if (typeof ctx.isStopped === 'function' && ctx.isStopped()) {
    throw new Error('Emergency stop is active. Clear it before starting a pilot run.');
  }

  const startedAt = now();
  const run = {
    id: `run_${startedAt.toString(36)}`,
    profile,
    startedAt,
    deadline: startedAt + profile.maxMinutes * 60_000,
    ticks: 0,
    bestScore: null,
    lastScore: null,
    targetScore: profile.targetScore,
    lastAction: '',
    lastNote: 'Starting…',
    stopReason: null,
    stopRequested: false,
    error: null,
    window: null,
    history: [],
    lastSig: '',
    lastBatch: null,
    idleRepeats: 0,
    reused: 0,
    macroIndex: 0,
    misses: 0,
    captureErrors: 0,
    inputErrors: 0,
    nextTickAt: startedAt,
    hotkeyRegistered: false,
    finished: false,
  };
  activeRun = run;
  try {
    if (typeof ctx.registerHotkey === 'function') {
      run.hotkeyRegistered = !!ctx.registerHotkey(STOP_ACCEL, () => stop());
    }
  } catch {
    run.hotkeyRegistered = false;
  }
  emit({ type: 'started', ...snapshot(run) });
  setTimeout(() => {
    void loop(run);
  }, 0);
  return status();
}

function stop() {
  if (!activeRun) return { stopping: false };
  activeRun.stopRequested = true;
  activeRun.stopReason = activeRun.stopReason || 'user';
  activeRun.lastNote = 'Stopping…';
  emitTick(activeRun);
  return { stopping: true };
}

function shutdown() {
  if (activeRun) {
    activeRun.stopRequested = true;
    activeRun.stopReason = 'user';
  }
  try {
    if (typeof ctx.unregisterHotkey === 'function') ctx.unregisterHotkey(STOP_ACCEL);
  } catch {
    /* the app is quitting anyway */
  }
}

module.exports = {
  init,
  listProfiles,
  saveProfile,
  deleteProfile,
  status,
  start,
  stop,
  shutdown,
  STOP_ACCEL,
  GAME_SYSTEM: core.GAME_SYSTEM,
  _internals: {
    readProfiles,
    loop,
  },
};
