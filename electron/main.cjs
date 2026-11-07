'use strict';

/** ORVEX desktop shell — real OS access lives here, the renderer only gets an allowlisted bridge. */

const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  protocol,
  session,
  shell,
  Notification,
  Tray,
  Menu,
  globalShortcut,
  nativeImage,
  powerMonitor,
  net,
} = require('electron');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { Readable } = require('node:stream');
const { fileURLToPath } = require('node:url');

const tools = require('./tools.cjs');
const browser = require('./browser.cjs');
const desktop = require('./desktop.cjs');
const mcp = require('./mcp.cjs');
const db = require('./db.cjs');
const mediaServer = require('./media-server.cjs');
const gateway = require('./model-gateway.cjs');
const code = require('./code.cjs');
const documents = require('./documents.cjs');
const research = require('./research.cjs');
const memoryStore = require('./memory.cjs');
const filesStore = require('./files.cjs');
const creative = require('./creative.cjs');
const sttProxy = require('./stt-proxy.cjs');
const modelCatalog = require('./model-catalog.cjs');
const elevenTts = require('./eleven-tts.cjs');
const elevenRealtime = require('./eleven-realtime.cjs');
const guardrails = require('./guardrails.cjs');
const vault = require('./vault.cjs');
const permissions = require('./permissions.cjs');
const integrations = require('./integrations.cjs');
const connectors = require('./connectors.cjs');
const oauth = require('./oauth.cjs');
const mcpServer = require('./mcp-server.cjs');
const workflows = require('./workflows.cjs');
const security = require('./security.cjs');
const monitor = require('./monitor.cjs');
const productivity = require('./productivity.cjs');
const advanced = require('./advanced.cjs');
const collab = require('./collab.cjs');
const vision = require('./vision.cjs');
const hands = require('./hands.cjs');
const plugins = require('./plugins.cjs');
const devices = require('./devices.cjs');
const a2a = require('./a2a.cjs');
const training = require('./training.cjs');
const localBrain = require('./local-brain.cjs');
const whisperLocal = require('./whisper-local.cjs');
const sttKeys = require('./stt-keys.cjs');
const learner = require('./learner.cjs');
const workforce = require('./workforce.cjs');
const maker = require('./maker.cjs');
const advisor = require('./advisor.cjs');
const updater = require('./updater.cjs');
const gamePilot = require('./game-pilot.cjs');
const { runAgent } = require('./agent.cjs');
const planTodos = require('./plan-todos.cjs');
const delegates = require('./delegates.cjs');
const approvalAdvisor = require('./approval-advisor.cjs');
const { runOrchestrator } = require('./orchestrator.cjs');
const runRecovery = require('./run-recovery.cjs');

const DEV_URL = process.env.VITE_DEV_URL || '';
// Same profile in dev and in the installed build (%APPDATA%\orvex).
app.setName('orvex');
// Isolated profile for automated runs so tests never touch a real library.
if (process.env.ORVEX_USER_DATA_DIR) app.setPath('userData', path.resolve(process.env.ORVEX_USER_DATA_DIR));
// The portable build keeps its profile beside the executable instead of
// writing into %APPDATA%, so carrying the .exe carries the library too.
else if (process.env.PORTABLE_EXECUTABLE_DIR) {
  app.setPath('userData', path.join(path.resolve(process.env.PORTABLE_EXECUTABLE_DIR), 'ORVEX-data'));
}
const AUDIT_FILE = path.join(app.getPath('userData'), 'audit.jsonl');
const MEMORY_FILE = path.join(app.getPath('userData'), 'memory.md');
const SECRETS_FILE = path.join(app.getPath('userData'), 'secrets.json');
const DB_FILE = path.join(app.getPath('userData'), 'orvex.db');
const HOTKEY = 'CommandOrControl+Shift+O';
const APPROVAL_TIMEOUT_MS = 120000;
const AUTO_RESUME_SETTING = 'engine.autoResume';
/** Session clock for the dashboard usage meter. */
const STARTED_AT = Date.now();

const DATA_DIR = app.getPath('userData');
const PREFS_FILE = path.join(DATA_DIR, 'prefs.json');
const prefs = { closeToTray: true };

try {
  Object.assign(prefs, JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')));
} catch {
  /* first run — defaults */
}

function savePrefs() {
  try {
    fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2));
  } catch {
    /* the disk is full or read-only — the session still works */
  }
}

function sendToWindow(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function sendToMini(channel, payload) {
  if (mini && !mini.isDestroyed()) mini.webContents.send(channel, payload);
}

function isAppFileUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'file:') return false;
    const dist = path.resolve(__dirname, '..', 'dist');
    const target = path.resolve(fileURLToPath(parsed));
    return target === path.join(dist, 'index.html') || target.startsWith(dist + path.sep);
  } catch {
    return false;
  }
}

let win = null;
let mini = null;
let tray = null;
let activeRun = null;
let quitting = false;
let hidToTrayNoticeShown = false;
let registeredHotkey = null;
let securityTimer = null;
let handsController = null;
const pendingApprovals = new Map();
const pendingAdvancedApprovals = new Map();

/** Advanced jobs ask here before a mutating step; the renderer answers on orvex:advanced:approve. */
function requestAdvancedApproval(req = {}) {
  return new Promise((resolve) => {
    const id = String(req.id || '');
    const done = (allowed) => {
      const entry = pendingAdvancedApprovals.get(id);
      if (!entry) return;
      pendingAdvancedApprovals.delete(id);
      clearTimeout(entry.timer);
      resolve(!!allowed);
    };
    const timer = setTimeout(() => done(false), APPROVAL_TIMEOUT_MS);
    pendingAdvancedApprovals.set(id, { done, timer });
    sendToWindow('orvex:notify', {
      title: 'ORVEX needs your approval',
      body: String(req.reason || req.name || 'A long-running job wants to change the machine.').slice(0, 160),
      kind: 'advanced',
      target: 'advanced',
      at: Date.now(),
    });
    if (win && !win.isDestroyed() && !win.isFocused()) {
      try {
        win.flashFrame(true);
      } catch {
        /* some platforms have no frame */
      }
    }
  });
}

function notifyAdvanced({ title, body } = {}) {
  const clean = { title: String(title || 'ORVEX'), body: String(body || '') };
  sendToWindow('orvex:notify', { ...clean, kind: 'advanced', target: 'advanced', at: Date.now() });
  if (!Notification.isSupported()) return;
  try {
    const note = new Notification(clean);
    note.on('click', () => showWindow(true));
    note.show();
  } catch {
    /* notifications unavailable */
  }
}

/** Windows OCR through the desktop bridge, with the same parsing the documents module uses. */
async function ocrTextFor(args = {}) {
  const result = await desktop.handlers.screen_ocr(args || {});
  if (!result || result.ok === false) return { ok: false, error: (result && result.error) || 'OCR failed.' };
  if (result.text != null) return { ok: true, ...result };
  const output = String(result.output || '');
  const match = /Full text:\n([\s\S]*)$/.exec(output);
  const text = match ? match[1].trim() : /No text was recognised/i.test(output) ? '' : output.trim();
  return { ok: true, ...result, text };
}

function sourceUrlFor(file) {
  if (!file) return '';
  try {
    return creative.registerSource({ path: file }).url || '';
  } catch {
    return '';
  }
}

/** Emergency stop: abort every autonomous thing ORVEX is doing right now. */
function haltEverything(reason) {
  try {
    if (activeRun) {
      activeRun.controller.abort();
      if (typeof activeRun.releaseWaiters === 'function') activeRun.releaseWaiters();
      activeRun = null;
    }
  } catch {
    /* the run may have finished between the check and the abort */
  }
  for (const controller of llmStreams.values()) {
    try {
      controller.abort();
    } catch {
      /* already closed */
    }
  }
  llmStreams.clear();
  for (const entry of speechStreams.values()) entry.controller.abort();
  speechStreams.clear();
  try {
    collab.stopAll(`Emergency stop: ${reason}`);
  } catch {
    /* collaboration sessions are best-effort */
  }
  try {
    advanced.cancelAllJobs(`Emergency stop: ${reason}`);
  } catch {
    /* background jobs are best-effort */
  }
  try {
    advanced.stopRules();
  } catch {
    /* the rule engine must never block the stop */
  }
  try {
    for (const run of workflows.list().runs || []) {
      if (['queued', 'running', 'awaiting_approval', 'interrupted'].includes(run.status)) {
        try {
          workflows.cancel(run.id);
        } catch {
          /* one stuck run must not keep the rest alive */
        }
      }
    }
  } catch {
    /* the workflow store is unavailable */
  }
  try {
    tools.audit({ kind: 'emergency', ok: false, error: `Halted: ${reason}` });
  } catch {
    /* auditing must never block the stop */
  }
}

/** Privacy controls: delete one class of local data, for real, and report counts. */
async function privacyClear({ what } = {}) {
  const target = String(what || '');
  const known = ['audit', 'runs', 'usage', 'memory', 'media', 'research', 'workflows'];
  if (!known.includes(target)) throw new Error(`what must be one of: ${known.join(', ')}.`);
  let removed = {};
  if (target === 'audit') {
    const raw = db.raw();
    const count = raw ? raw.prepare('SELECT COUNT(*) AS c FROM audit').get().c : 0;
    if (raw) raw.exec('DELETE FROM audit');
    await fsp.writeFile(AUDIT_FILE, '', 'utf8').catch(() => {});
    removed = { auditRows: count };
  } else if (target === 'runs') {
    const raw = db.raw();
    const count = raw ? raw.prepare('SELECT COUNT(*) AS c FROM runs').get().c : 0;
    if (raw) raw.exec('DELETE FROM run_steps; DELETE FROM runs;');
    removed = { runs: count };
  } else if (target === 'usage') {
    const raw = db.raw();
    const count = raw ? raw.prepare('SELECT COUNT(*) AS c FROM usage').get().c : 0;
    db.clearUsage();
    removed = { usageRows: count };
  } else if (target === 'memory') {
    removed = memoryStore.clearAll();
  } else if (target === 'media') {
    removed = await creative.clearLibrary();
  } else if (target === 'research') {
    const reports = await research.list();
    for (const report of reports) {
      try {
        await research.remove(report.id);
      } catch {
        /* keep deleting the rest */
      }
    }
    removed = { reports: reports.length };
  } else if (target === 'workflows') {
    removed = workflows.clearRuns();
  }
  try {
    tools.audit({ kind: 'privacy-clear', ok: true, args: JSON.stringify({ what: target, removed }) });
  } catch {
    /* clearing must succeed even if the trail write fails */
  }
  return { what: target, removed, at: Date.now() };
}

vault.init({ file: SECRETS_FILE });
security.init({
  dataDir: DATA_DIR,
  emit: (event) => sendToWindow('orvex:security:changed', event),
  snapshotDb: (destination) => db.raw().backup(destination),
  onEmergency: (state) => haltEverything(state && state.reason ? state.reason : 'emergency stop'),
});
const restoredOnBoot = security.applyPendingRestoreSync();
tools.init({ auditFile: AUDIT_FILE, memoryFile: MEMORY_FILE, outputDir: path.join(DATA_DIR, 'tool-outputs') });
if (restoredOnBoot) {
  tools.audit({ kind: 'backup-restored', ok: true, error: null, args: JSON.stringify({ files: restoredOnBoot.applied.length, preRestore: path.basename(restoredOnBoot.preRestore || '') }) });
}
void vault
  .load()
  .then((map) => security.setSecretValues(Object.values(map || {})))
  .catch(() => {});
db.init({ file: DB_FILE });
approvalAdvisor.init({ dataDir: DATA_DIR, auditTail: (limit) => db.auditTail(limit) });
browser.init({ dataDir: DATA_DIR });
desktop.init({ dataDir: DATA_DIR });
mcp.init({ dataDir: DATA_DIR });
permissions.init({ dataDir: DATA_DIR, registry: () => tools.definitions });
oauth.init({
  dataDir: DATA_DIR,
  emit: (event) => sendToWindow('orvex:oauth:changed', event),
  openExternal: (url) => shell.openExternal(url),
});
integrations.init({
  dataDir: DATA_DIR,
  emit: (event) => sendToWindow('orvex:integrations:changed', event),
  oauthToken: (accountId) => oauth.tokenFor(accountId),
});
connectors.init({
  dataDir: DATA_DIR,
  emit: (event) => sendToWindow('orvex:connectors:changed', event),
});
maker.init({
  dataDir: DATA_DIR,
  emit: (event) => sendToWindow('orvex:maker:changed', event),
});
mcpServer.init({
  dataDir: DATA_DIR,
  emit: (event) => sendToWindow('orvex:mcp-server:changed', event),
  bridge: {
    definitions: () => tools.definitions,
    runTool: (name, args, ctx) => tools.runTool(name, args, ctx),
    approvalReason: (name, args) => tools.approvalReason(name, args) || tools.escalationReason(name, args),
  },
});
workflows.init({
  dataDir: DATA_DIR,
  emit: (event) => sendToWindow('orvex:workflows:changed', event),
  notify: ({ title, body }) => {
    const clean = { title: String(title || 'ORVEX workflow'), body: String(body || '') };
    sendToWindow('orvex:notify', { ...clean, kind: 'job', target: 'automation', at: Date.now() });
    if (!Notification.isSupported()) return;
    try {
      const note = new Notification(clean);
      note.on('click', () => showWindow(true));
      note.show();
    } catch {
      /* the tray is gone */
    }
  },
  runTool: (name, args, ctx) => tools.runTool(name, args, ctx),
  approvalReason: (name, args) => tools.approvalReason(name, args) || tools.escalationReason(name, args),
  toolExists: (name) => tools.definitions.some((d) => d.name === name),
  onRunFinish: (run) => recordWorkflowFinished(run),
});
code.init({
  dataDir: app.getPath('userData'),
  emit: (event) => {
    if (win && !win.isDestroyed()) win.webContents.send('orvex:code:output', event);
  },
});
documents.init({
  ocr: async (file) => {
    const result = await ocrTextFor({ path: file });
    if (!result.ok) return { error: result.error };
    return { text: String(result.text || '').trim() };
  },
});
research.init({
  dataDir: app.getPath('userData'),
  emit: (event) => {
    if (win && !win.isDestroyed()) win.webContents.send('orvex:research:event', event);
  },
});
memoryStore.init({
  dataDir: app.getPath('userData'),
  legacyFile: MEMORY_FILE,
  gateway,
});
delegates.init({
  spawn: async ({ goal, agent, childRunId, chain, signal, emit }) => {
    const emergency = security.status().emergency;
    if (emergency && emergency.stopped) {
      throw new Error(`Emergency stop is active${emergency.reason ? ` (${emergency.reason})` : ''}. A sub-agent cannot start.`);
    }
    let memory = '';
    try {
      memory = memoryStore.context({ goal, limit: 3, maxChars: 1200 });
    } catch {
      /* memory stays empty rather than blocking the child */
    }
    return runAgent({
      goal,
      candidates: chain,
      memory,
      emit,
      signal,
      gate: async () => {},
      approve: null,
      maxSteps: 20,
      autoApprove: false,
      runId: childRunId,
      task: 'agent',
      unattended: true,
      allowDelegation: false,
      systemAppend: `You are ${agent}, a background sub-agent working for the main ORVEX run. Complete only this task, use tools, and finish with a concise factual result. You cannot ask the user for approval; risky actions are refused.`,
    });
  },
  store: {
    save: (task) => db.delegationSave(task),
    get: (id) => db.delegationGet(id),
    list: (limit) => db.delegationsRecent(limit),
    markResumed: (id, resumedAs) => db.delegationMarkResumed(id, resumedAs),
    interruptOpen: () => db.delegationsInterruptOpen(),
    prune: (keep) => db.delegationPrune(keep),
  },
});
filesStore.init({
  dataDir: app.getPath('userData'),
  roots: [
    { label: 'Home', path: app.getPath('home') },
    { label: 'Desktop', path: app.getPath('desktop') },
    { label: 'Documents', path: app.getPath('documents') },
    { label: 'Downloads', path: app.getPath('downloads') },
    { label: 'Pictures', path: app.getPath('pictures') },
    { label: 'Music', path: app.getPath('music') },
    { label: 'Videos', path: app.getPath('videos') },
  ],
  emit: (event) => {
    if (win && !win.isDestroyed()) win.webContents.send('orvex:files:changed', event);
  },
});
creative.init({
  dataDir: app.getPath('userData'),
  gateway,
  emit: (event) => {
    if (win && !win.isDestroyed()) win.webContents.send('orvex:media:changed', event);
  },
});
monitor.init({
  dataDir: DATA_DIR,
  dbFile: DB_FILE,
  metrics: () => desktop.handlers.system_metrics({}),
  appMetrics: () => app.getAppMetrics(),
  gateway,
  securityState: () => security.status(),
  workflowsState: () => workflows.list(),
  backups: () => security.listBackups(),
  vaultAvailable: () => vault.available(),
  version: () => app.getVersion(),
});
productivity.init({
  dataDir: DATA_DIR,
  db: db.raw(),
  gateway,
  memory: memoryStore,
  creative,
  documents,
  files: filesStore,
});

/* ------------------------------------------------- Section 19 — advanced */

advanced.init({
  gateway,
  runTool: (name, args, options) => tools.runTool(name, args, options),
  toolDefinitions: () => tools.definitions,
  approvalReason: (name, args) => tools.approvalReason(name, args) || tools.escalationReason(name, args),
  approve: (req) => requestAdvancedApproval(req),
  emit: (event) => {
    sendToWindow('orvex:advanced:event', event);
    if (event && event.type === 'job-end') recordJobFinished(event);
  },
  notify: (note) => notifyAdvanced(note),
  metrics: () => desktop.handlers.system_metrics({}),
  clipboard: () => desktop.handlers.clipboard_read({}),
  idleSeconds: () => powerMonitor.getSystemIdleTime(),
  ocr: (args) => ocrTextFor(args),
  screenshot: async (args) => {
    const result = await desktop.handlers.screen_capture(args || {});
    if (!result || result.ok === false) return result;
    const file = result.file || result.image || '';
    return { ...result, file, url: sourceUrlFor(file) };
  },
  windowList: (args) => desktop.handlers.window_list(args || {}),
  crashes: (limit) => monitor.crashes(limit),
  resumeRun: (payload) => startEngine(payload, payload && payload.mode === 'orchestrator' ? 'orchestrator' : 'agent', { resume: true }),
  resumeWorkflow: (id) => workflows.resume(String(id)),
  runWorkflow: (id, input) => workflows.runNow(String(id), input || {}),
  online: () => {
    try {
      return net.isOnline();
    } catch {
      return true;
    }
  },
  version: () => app.getVersion(),
});
collab.init({
  gateway,
  emit: (event) => sendToWindow('orvex:advanced:event', event),
  planCandidates: (list, opts) => advanced.planCandidates(list, opts),
  version: () => app.getVersion(),
});
vision.init({
  gateway,
  screenshot: async (args) => {
    const result = await desktop.handlers.screen_capture(args || {});
    if (!result || result.ok === false) return result;
    const file = result.file || result.image || '';
    return { ...result, file, url: sourceUrlFor(file) };
  },
  ocr: (args) => ocrTextFor(args),
  planCandidates: (list, opts) => advanced.planCandidates(list, opts),
});
hands.init({
  desktop: {
    screenCapture: (args) => desktop.handlers.screen_capture(args || {}),
    mouseClick: (args) => desktop.handlers.mouse_click(args || {}),
    keyType: (args) => desktop.handlers.key_type(args || {}),
    keyPress: (args) => desktop.handlers.key_press(args || {}),
    mouseScroll: (args) => desktop.handlers.mouse_scroll(args || {}),
    waitFor: (args) => desktop.handlers.wait(args || {}),
    screenClickText: (args) => desktop.handlers.screen_click_text(args || {}),
    appLaunch: (args) => desktop.handlers.app_launch(args || {}),
    uiTree: (args) => desktop.handlers.ui_tree(args || {}),
    uiAction: (args) => desktop.handlers.ui_action(args || {}),
  },
  ask: async ({ goal, step, maxSteps, shot, tree, history }) => {
    const trail = history && history.length ? `Actions already tried:\n${history.join('\n')}\n` : '';
    if (tree) {
      // Tree steps are text-only: no screenshot, no vision tokens.
      const candidates = configuredChain({ task: 'chat' });
      if (!candidates.length) throw new Error(unavailableModelMessage({ task: 'chat', goal }));
      const reply = await gateway.chat({
        candidates,
        system: hands.HANDS_SYSTEM,
        history: [
          {
            role: 'user',
            text: `Goal: ${goal}\nStep ${step} of ${maxSteps}.\n${trail}\nAccessibility tree — use an exact path from it:\n${tree}\n\nReturn exactly one JSON action.`,
          },
        ],
        task: 'chat',
        temperature: 0,
        maxTokens: 400,
      });
      return reply.text;
    }
    const candidates = configuredChain({ task: 'vision' });
    if (!candidates.length) throw new Error(unavailableModelMessage({ task: 'vision' }));
    const file = shot.file || shot.image;
    if (!file) throw new Error('The screen capture did not produce an image file.');
    const image = vision.readImageFile(file);
    const reply = await gateway.chat({
      candidates,
      system: hands.HANDS_SYSTEM,
      history: [
        {
          role: 'user',
          text: `Goal: ${goal}\nStep ${step} of ${maxSteps}. The screenshot is ${shot.width || '?'}x${shot.height || '?'} screen pixels.\n${trail}\nReturn exactly one JSON action.`,
          images: [{ mime: image.mime, data: image.data }],
        },
      ],
      task: 'vision',
      temperature: 0,
      maxTokens: 500,
    });
    return reply.text;
  },
  emit: (event) => sendToWindow('orvex:hands:event', event),
  isStopped: (signal) => {
    if (signal && signal.aborted) return true;
    try {
      return !!security.status().emergency.stopped;
    } catch {
      return false;
    }
  },
});
gamePilot.init({
  platform: process.platform,
  desktop: {
    screenCapture: (args) => desktop.handlers.screen_capture(args || {}),
    keyPress: (args) => desktop.handlers.key_press(args || {}),
    windowList: (args) => desktop.handlers.window_list(args || {}),
    windowAction: (args) => desktop.handlers.window_action(args || {}),
  },
  ocr: (args) => ocrTextFor(args || {}),
  foregroundOk: async (title, win) => {
    const result = await desktop.handlers.window_list({ filter: title, visibleOnly: true, limit: 40 });
    if (!result || result.ok === false) return false;
    const needle = String(title || '').toLowerCase();
    return (Array.isArray(result.windows) ? result.windows : []).some(
      (w) =>
        w &&
        w.foreground &&
        String(w.title || '').toLowerCase().includes(needle) &&
        (!win || !win.hwnd || w.hwnd === win.hwnd),
    );
  },
  visionProblem: () =>
    configuredChain({ task: 'vision' }).length
      ? null
      : unavailableModelMessage({ task: 'vision', goal: 'Game Pilot needs a vision-capable model to read the game screen.' }),
  ask: async ({ profile, shot, score, bestScore, history, tick }) => {
    const candidates = configuredChain({ task: 'vision' });
    if (!candidates.length) {
      throw new Error(unavailableModelMessage({ task: 'vision', goal: profile.goal || profile.name }));
    }
    const file = shot.file || shot.image;
    if (!file) throw new Error('The screen capture did not produce an image file.');
    const image = vision.readImageFile(file);
    const allowed = profile.actions.map((a) => a.key).join(', ');
    const trail = Array.isArray(history) && history.length
      ? history
          .map((h) => `${h.action ? `[${h.action}]` : '[no key]'} ${h.note || ''}${h.score !== null && h.score !== undefined ? ` (score ${h.score})` : ''}`)
          .join('\n')
      : 'none yet';
    const reply = await gateway.chat({
      candidates,
      system: gamePilot.GAME_SYSTEM,
      history: [
        {
          role: 'user',
          text: [
            `Game: ${profile.name}`,
            `Goal: ${profile.goal || 'Play well and raise the score.'}`,
            `Tick ${tick} | score ${score ?? 'not readable'} | best ${bestScore ?? 'none yet'} | target ${profile.targetScore ?? 'none'}`,
            `Allowed keys: ${allowed}`,
            `Recent actions:\n${trail}`,
            `The screenshot is ${shot.width || '?'}x${shot.height || '?'} pixels.`,
            'Return exactly one JSON object. Prefer an ordered {"actions":[...]} batch of 1-6 keys with waitMs between them, limited to what this screenshot justifies.',
          ].join('\n'),
          images: [{ mime: image.mime, data: image.data }],
        },
      ],
      task: 'vision',
      temperature: 0,
      maxTokens: 400,
    });
    return reply.text;
  },
  record: (payload) => training.appendEpisode(payload),
  emit: (event) => sendToWindow('orvex:gamepilot:event', event),
  registerHotkey: (accel, fn) => {
    try {
      return globalShortcut.register(accel, fn);
    } catch {
      return false;
    }
  },
  unregisterHotkey: (accel) => {
    try {
      globalShortcut.unregister(accel);
    } catch {
      /* the shortcut may already be gone */
    }
  },
  isStopped: () => {
    try {
      return !!security.status().emergency.stopped;
    } catch {
      return false;
    }
  },
});
void plugins.init({
  dataDir: DATA_DIR,
  emit: (event) => sendToWindow('orvex:advanced:event', { scope: 'plugins', ...event }),
  toolsChanged: () => {
    tools.applyPlugins(plugins.toolDefinitions(), plugins.callTool);
    try {
      mcpServer.notifyToolsChanged();
    } catch {
      /* the MCP server may be stopped */
    }
  },
});
try {
  tools.applyPlugins(plugins.toolDefinitions(), plugins.callTool);
} catch {
  /* no installed plugins yet */
}
devices.init({
  emit: (event) => sendToWindow('orvex:advanced:event', { scope: 'devices', ...event }),
  version: () => app.getVersion(),
});
a2a.init({
  version: () => app.getVersion(),
  emit: (event) => sendToWindow('orvex:advanced:event', event),
  run: async ({ goal, signal }) => {
    const candidates = configuredChain({ task: 'chat', goal });
    if (!candidates.length) throw new Error(unavailableModelMessage({ task: 'chat', goal }));
    const reply = await gateway.chat({
      candidates,
      system: a2a.SYSTEM_PROMPT,
      history: [{ role: 'user', text: goal }],
      task: 'chat',
      temperature: 0.2,
      maxTokens: 1200,
      signal,
    });
    return reply.text;
  },
});
training.init({
  dataDir: app.getPath('userData'),
  emit: (event) => sendToWindow('orvex:training:changed', event),
});
localBrain.init({
  dataDir: app.getPath('userData'),
  version: () => app.getVersion(),
  emit: (event) => sendToWindow('orvex:localbrain:changed', event),
});
learner.init({
  dataDir: app.getPath('userData'),
  version: app.getVersion(),
  emit: (event) => sendToWindow('orvex:learner:changed', event),
  providerSecret: (id, baseUrl) => (providerKeyAllowed(id, baseUrl) ? vault.peek(id) || '' : ''),
});
workforce.init({
  dataDir: app.getPath('userData'),
  emit: (event) => sendToWindow('orvex:workforce:changed', event),
  notify: (note) => sendToWindow('orvex:notify', note),
  runShift: runWorkforceShift,
  isEngineBusy: () => !!activeRun,
});
advisor.init({
  version: () => app.getVersion(),
  providers: {
    model: () => ({
      chat: configuredChain({ task: 'chat' }).length > 0,
      vision: configuredChain({ task: 'vision' }).length > 0,
    }),
    monitor: () => monitor.overview(),
    training: () => training.status(),
    brain: () => localBrain.status(),
    learner: () => learner.status(),
    advanced: () => advanced.status(),
    workforce: () => workforce.status(),
    backups: () => security.listBackups(),
    crashes: () => monitor.crashes(20),
  },
});
updater.init({
  dataDir: app.getPath('userData'),
  version: () => app.getVersion(),
  isPackaged: app.isPackaged,
  portable: !!process.env.PORTABLE_EXECUTABLE_DIR,
  fetchImpl: (input, options) => net.fetch(input, options),
  emit: (event) => sendToWindow('orvex:updater:event', event),
  shell,
  spawn: require('node:child_process').spawn,
  quit: () => app.quit(),
});
// Adaptive routing reads the outcome of every real model call.
gateway.setRouteObserver(({ task, providerId, model, ok, ms }) => {
  try {
    advanced.recordOutcome({ task: task || 'chat', providerId, model, ok, ms });
  } catch {
    /* outcome history is best-effort */
  }
});

// Generated media streams from the app's own library through a private scheme,
// so <img>/<audio>/<video> work from both the dev server and the file:// build.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'orvex-media',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  },
]);

async function connectMcp() {
  const result = await mcp.connectAll();
  tools.applyMcp(result.definitions, mcp.callMcpTool);
  mcpServer.notifyToolsChanged();
  return result.status;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1080,
    minHeight: 720,
    backgroundColor: '#05070d',
    title: 'ORVEX',
    icon: trayIcon(),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    const allowed = DEV_URL ? url.startsWith(DEV_URL) : isAppFileUrl(url);
    if (!allowed) {
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  if (DEV_URL) {
    win.loadURL(DEV_URL);
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  win.on('close', (event) => {
    if (quitting) return;
    if (!prefs.closeToTray) {
      quitting = true;
      app.quit();
      return;
    }
    event.preventDefault();
    win.hide();
    if (!hidToTrayNoticeShown) {
      hidToTrayNoticeShown = true;
      try {
        const note = new Notification({
          title: 'ORVEX is still running',
          body: `Runs keep going in the background. Click the tray icon or press ${HOTKEY.replace('CommandOrControl', 'Ctrl')} to bring it back.`,
        });
        note.on('click', () => showWindow(true));
        note.show();
      } catch {
        /* notifications unavailable */
      }
    }
  });

  win.on('closed', () => {
    win = null;
    emitWindowState();
  });

  for (const evt of ['maximize', 'unmaximize', 'minimize', 'restore', 'show', 'hide', 'focus', 'blur', 'enter-full-screen', 'leave-full-screen']) {
    win.on(evt, emitWindowState);
  }
}

/** Snapshot of the real Electron window state — never inferred in the renderer. */
function windowState() {
  const main = win && !win.isDestroyed() ? win : null;
  return {
    available: !!main,
    visible: main ? main.isVisible() : false,
    focused: main ? main.isFocused() : false,
    minimized: main ? main.isMinimized() : false,
    maximized: main ? main.isMaximized() : false,
    fullscreen: main ? main.isFullScreen() : false,
    alwaysOnTop: main ? main.isAlwaysOnTop() : false,
    miniOpen: !!(mini && !mini.isDestroyed()),
    miniVisible: mini && !mini.isDestroyed() ? mini.isVisible() : false,
    hotkey: registeredHotkey,
    closeToTray: !!prefs.closeToTray,
  };
}

function emitWindowState() {
  const state = windowState();
  sendToWindow('orvex:window:state', state);
  sendToMini('orvex:window:state', state);
}

/** Compact always-on-top companion window rendered by the same bundle at #mini. */
function createMiniWindow() {
  if (mini && !mini.isDestroyed()) {
    mini.show();
    mini.focus();
    return mini;
  }
  mini = new BrowserWindow({
    width: 380,
    height: 330,
    minWidth: 330,
    minHeight: 260,
    maxWidth: 560,
    maxHeight: 620,
    frame: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#05070d',
    title: 'ORVEX Mini',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  if (DEV_URL) mini.loadURL(`${DEV_URL}#mini`);
  else mini.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { hash: 'mini' });
  mini.once('ready-to-show', () => {
    if (mini && !mini.isDestroyed()) {
      mini.show();
      mini.focus();
    }
  });
  mini.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mini.webContents.on('will-navigate', (event) => event.preventDefault());
  mini.on('closed', () => {
    mini = null;
    emitWindowState();
  });
  for (const evt of ['show', 'hide', 'focus', 'blur']) mini.on(evt, emitWindowState);
  emitWindowState();
  return mini;
}

function toggleMiniWindow() {
  if (mini && !mini.isDestroyed() && mini.isVisible()) {
    mini.hide();
    return false;
  }
  createMiniWindow();
  return true;
}

/** 32px "ring" mark drawn as raw pixels — no binary icon file needed for the tray. */
function trayIcon() {
  const size = 32;
  const buf = Buffer.alloc(size * size * 4);
  const cx = 15.5;
  const cy = 15.5;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const d = Math.hypot(x - cx, y - cy);
      const ring = Math.abs(d - 11) <= 2.1;
      const core = d <= 3.6;
      if (!ring && !core) continue;
      const i = (y * size + x) * 4;
      // BGRA — cyan ring, pale core, soft edge fade.
      const edge = ring ? Math.min(1, (2.1 - Math.abs(d - 11)) / 1.1) : Math.min(1, (3.6 - d) / 1.2);
      buf[i] = Math.round(255 * edge);
      buf[i + 1] = Math.round(225 * edge);
      buf[i + 2] = Math.round(80 * edge);
      buf[i + 3] = Math.round(255 * edge);
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function showWindow(wake = false) {
  if (!win) {
    createWindow();
    win.webContents.once('did-finish-load', () => {
      if (wake) win.webContents.send('orvex:wake');
    });
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (wake) win.webContents.send('orvex:wake');
}

function toggleWindow() {
  if (win && win.isVisible() && win.isFocused()) {
    win.hide();
    return;
  }
  showWindow(true);
}

function setupTray() {
  try {
    tray = new Tray(trayIcon());
  } catch {
    return;
  }
  tray.setToolTip('ORVEX — idle');
  tray.on('click', () => toggleWindow());
  tray.on('double-click', () => showWindow(true));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open ORVEX', click: () => showWindow(true) },
      { label: 'Open mini window', click: () => createMiniWindow() },
      { label: `Toggle window (${HOTKEY.replace('CommandOrControl', 'Ctrl')})`, click: () => toggleWindow() },
      { type: 'separator' },
      {
        label: 'Quit ORVEX',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

function setupHotkey() {
  for (const accel of [HOTKEY, 'CommandOrControl+Alt+O']) {
    try {
      if (globalShortcut.register(accel, () => toggleWindow())) {
        registeredHotkey = accel;
        break;
      }
    } catch {
      /* try the next accelerator */
    }
  }
}

const AIR_STOP_ACCEL = 'CommandOrControl+Alt+Shift+X';

function setupAirStopHotkey() {
  try {
    const ok = globalShortcut.register(AIR_STOP_ACCEL, () => {
      if (win && !win.isDestroyed()) win.webContents.send('orvex:air-stop');
    });
    if (!ok) console.warn(`Could not register the air-touch emergency shortcut ${AIR_STOP_ACCEL}.`);
  } catch (err) {
    console.warn('Air-touch emergency shortcut failed:', err && err.message ? err.message : err);
  }
}

/** The app's own windows only need camera/microphone/screen capture; everything else stays denied. */
function setupMediaPermissions() {
  const ses = session.defaultSession;
  const ours = (wc) =>
    !!wc && BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.webContents === wc);
  ses.setPermissionRequestHandler((wc, permission, callback) => {
    callback(permission === 'media' && ours(wc));
  });
  ses.setPermissionCheckHandler((wc, permission) => permission === 'media' && ours(wc));
}

function ok(data) {
  return { ok: true, data };
}

function fail(error) {
  return { ok: false, error: error && error.message ? error.message : String(error) };
}

function localEndpoint(baseUrl) {
  try {
    const host = new URL(String(baseUrl)).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host === '::1' || host.endsWith('.local')) return true;
    if (/^127\./.test(host)) return true;
    if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Cheap reachability + model check before a run starts. A dead local server or
 * an unpulled tag used to surface as a 3-minute model timeout; now the reply is
 * immediate and says what to fix. Hosted APIs are not probed: their /models
 * call is an extra round trip on every Start, and the run already surfaces a
 * real error from its first model call.
 */
async function preflightProvider(provider) {
  const base = String((provider && provider.baseUrl) || '').replace(/\/+$/, '');
  if (!base || provider.api === 'anthropic' || !localEndpoint(base)) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  const headers = provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {};
  let res;
  try {
    res = await fetch(`${base}/models`, { headers, signal: controller.signal });
  } catch {
    return `Cannot reach ${provider.name || 'the model server'} at ${base}. Start it (for Ollama: run "ollama serve"), then try again.`;
  } finally {
    clearTimeout(timer);
  }

  // Keys, gateways and hosted APIs may refuse or omit the list — only the
  // local-server case can be judged from it.
  if (!res.ok) return null;
  let ids = [];
  try {
    const data = await res.json();
    const list = Array.isArray(data && data.data) ? data.data : Array.isArray(data && data.models) ? data.models : [];
    ids = list.map((m) => String((m && (m.id || m.name || m.model)) || '')).filter(Boolean);
  } catch {
    return null;
  }
  if (!ids.length) return null;
  const want = String(provider.model);
  const found = ids.some((id) => id === want || id.split(':')[0] === want);
  if (found) return null;
  return `Model "${want}" is not installed on ${provider.name || base}. Installed: ${ids.slice(0, 6).join(', ')}. Pick one of those in Settings → Providers.`;
}

/** Tasks the routing editor can assign model chains to. */
const ROUTING_TASKS = ['agent', 'chat', 'code', 'research', 'memory', 'summarize', 'vision', 'plan', 'media'];
const llmStreams = new Map();
/** Live HeyGen speech streams keyed by window and request id. */
const speechStreams = new Map();
const SPEECH_STREAMS_PER_WINDOW = 4;
const speechKey = (senderId, id) => `${senderId}:${id}`;
/** One live microphone session per window; the socket and its key stay here. */
const realtimeSessions = new Map();

function uniqueCandidates(list) {
  const out = [];
  const seen = new Set();
  for (const c of Array.isArray(list) ? list : []) {
    if (!c || !c.baseUrl || !c.model) continue;
    const key = `${String(c.id || c.presetId || c.baseUrl)}|${String(c.model)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/**
 * Build the ordered candidate chain for one request: the renderer's active
 * provider first, then any extra candidates, re-ordered by the saved routing
 * chain for this task when one exists. Routing entries only reference models
 * the renderer already sent, so a stale entry can never invent a provider.
 */
/**
 * Stored provider keys never reach the renderer. Main adds them to a candidate
 * only when the candidate's endpoint matches the binding saved with the key (or
 * the provider's well-known host), so a forged base URL cannot exfiltrate one.
 */
const PROVIDER_KEY_HOSTS = {
  openai: 'api.openai.com',
  anthropic: 'api.anthropic.com',
  google: 'generativelanguage.googleapis.com',
  groq: 'api.groq.com',
  mistral: 'api.mistral.ai',
  deepseek: 'api.deepseek.com',
  xai: 'api.x.ai',
  openrouter: 'openrouter.ai',
  together: 'api.together.xyz',
  cerebras: 'api.cerebras.ai',
};
const PROVIDER_BINDINGS_SETTING = 'providers.keyBindings';

function originOf(url) {
  try {
    const u = new URL(String(url));
    return `${u.protocol}//${u.host}`.toLowerCase();
  } catch {
    return '';
  }
}

function providerBindings() {
  const saved = db.getSetting(PROVIDER_BINDINGS_SETTING, {});
  return saved && typeof saved === 'object' ? saved : {};
}

function saveProviderBinding(id, baseUrl) {
  const map = { ...providerBindings() };
  if (baseUrl) map[id] = String(baseUrl).slice(0, 400);
  else delete map[id];
  db.setSetting(PROVIDER_BINDINGS_SETTING, map);
}

function providerKeyAllowed(id, baseUrl) {
  const wanted = originOf(baseUrl);
  if (!wanted) return false;
  const bound = providerBindings()[id];
  if (bound && originOf(bound) === wanted) return true;
  let host = '';
  try {
    host = new URL(String(baseUrl)).host.toLowerCase();
  } catch {
    return false;
  }
  return !!PROVIDER_KEY_HOSTS[id] && PROVIDER_KEY_HOSTS[id] === host;
}

function withProviderKey(candidate) {
  if (!candidate || candidate.apiKey) return candidate;
  for (const raw of [candidate.presetId, candidate.id]) {
    const id = String(raw || '');
    if (!/^[a-z0-9._:-]{1,80}$/i.test(id)) continue;
    if (!providerKeyAllowed(id, candidate.baseUrl)) continue;
    const key = vault.peek(id);
    if (key) return { ...candidate, apiKey: key };
  }
  return candidate;
}

/** Add stored provider keys to payload.provider / payload.candidates, never to the renderer. */
function hydrateProviderPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const next = { ...payload };
  if (next.provider && typeof next.provider === 'object') next.provider = withProviderKey({ ...next.provider });
  if (Array.isArray(next.candidates)) {
    next.candidates = next.candidates.map((c) => (c && typeof c === 'object' ? withProviderKey({ ...c }) : c));
  }
  return next;
}

/**
 * Endpoint-bound secrets (speech, music) are only attached when the request
 * goes to the origin they were saved with.
 */
function boundSecretOrEmpty(id, url) {
  const bound = providerBindings()[id];
  if (!bound) {
    if (vault.has(id)) {
      throw new Error(`The saved ${id} key is not linked to an endpoint yet. Save it again with this endpoint so ORVEX can use it safely.`);
    }
    return '';
  }
  if (originOf(bound) !== originOf(url)) {
    throw new Error(`The saved ${id} key belongs to ${bound}, not this endpoint. Save the key again for this endpoint.`);
  }
  return vault.peek(id) || '';
}

const STT_ENDPOINT_SETTING = 'stt.endpoint';

/**
 * Local Whisper shares the machine's few cores with the model, so it only runs
 * when speech input actually points at it. An unset endpoint is the original
 * behaviour: the app owns its own transcription server.
 */
function localWhisperWanted() {
  const saved = String(db.getSetting(STT_ENDPOINT_SETTING, '') || '').trim();
  if (!saved) return true;
  try {
    const u = new URL(saved);
    return ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) && u.port === String(whisperLocal.PORT);
  } catch {
    return true;
  }
}

function syncLocalWhisper() {
  if (!localWhisperWanted()) {
    whisperLocal.stop();
    return false;
  }
  void whisperLocal
    .start()
    .then((state) => {
      if (state.error) console.error('Local whisper server failed:', state.error);
    })
    .catch((err) => console.error('Local whisper server failed:', err && err.message ? err.message : err));
  return true;
}

/**
 * Hosted speech input needs the same key the chat provider already has, and
 * asking for it twice only gives the secret one more place to leak from. This
 * copies it inside the main process, and only from a provider already bound to
 * the exact origin the transcription endpoint uses.
 */
async function linkSttKeyFromProvider(target) {
  const origin = originOf(target);
  if (!origin) throw new Error('Set a transcription endpoint first.');
  const blocked = security.networkPolicyBlock(target);
  if (blocked) throw new Error(blocked);
  const bindings = providerBindings();
  const ids = Object.keys(bindings).filter((id) => id !== 'stt' && originOf(bindings[id]) === origin);
  if (!ids.length) {
    throw new Error(`No saved provider key is linked to ${origin}. Add that provider in Settings → Providers, or paste the key once here.`);
  }
  const source = ids.map((id) => ({ id, key: vault.peek(id) })).find((row) => row.key);
  if (!source) throw new Error(`The provider for ${origin} has no saved key to reuse.`);
  await vault.set('stt', source.key);
  saveProviderBinding('stt', bindings[source.id]);
  security.setSecretValues(Object.values(await vault.load()));
  return { linked: true, provider: source.id };
}

const STT_POOL_VAULT_ID = 'stt.pool';
const STT_POOL_HEALTH_SETTING = 'stt.keyHealth';

/**
 * The pool as stored: one list of keys per endpoint origin. A hosted quota
 * belongs to one service, so switching speech input between Groq, OpenAI and
 * ElevenLabs must not drop the keys saved for the others.
 */
function poolTables(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [origin, rows] of Object.entries(raw)) {
    const clean = sttKeys.normalisePool(rows);
    if (clean.length) out[origin] = clean;
  }
  return out;
}

async function readSttPool(origin) {
  return poolTables(await vault.getJson(STT_POOL_VAULT_ID))[origin] || [];
}

function sttPoolHealth() {
  const saved = db.getSetting(STT_POOL_HEALTH_SETTING, {});
  return saved && typeof saved === 'object' ? saved : {};
}

async function writeSttPool(origin, rows) {
  const tables = poolTables(await vault.getJson(STT_POOL_VAULT_ID));
  if (rows.length) tables[origin] = rows;
  else delete tables[origin];
  await vault.setJson(STT_POOL_VAULT_ID, Object.keys(tables).length ? tables : null);
  // the pool lives as one JSON entry, so its values are added to the redaction
  // list by hand rather than read back as strings
  const stored = Object.values(await vault.load()).filter((value) => typeof value === 'string');
  const pooled = Object.values(tables).flat().map((row) => row.key);
  security.setSecretValues([...stored, ...pooled]);
}

/**
 * Keys this endpoint may use, in the order they should be tried. The single
 * key pasted in Settings comes first; the pool behind it is what keeps a
 * conversation running when one quota runs out.
 */
async function sttKeyAttempts(target) {
  const out = [];
  const seen = new Set();
  const single = boundSecretOrEmpty('stt', target);
  if (single) {
    out.push({ id: 'stt', key: single });
    seen.add(single);
  }
  const origin = originOf(target);
  if (origin) {
    const pool = await readSttPool(origin);
    for (const pick of sttKeys.pickOrder(pool, sttPoolHealth())) {
      const entry = pool.find((row) => row.id === pick.id);
      if (!entry || !entry.key || seen.has(entry.key)) continue;
      seen.add(entry.key);
      out.push({ id: entry.id, key: entry.key });
    }
  }
  return out;
}

/**
 * ElevenLabs keys for speech output. Speech input may point somewhere else
 * entirely, so the single STT key only counts when it was saved for this host;
 * the per-endpoint pool is the list the user built for ElevenLabs.
 */
async function elevenKeyAttempts() {
  const origin = elevenTts.ORIGIN;
  const out = [];
  const seen = new Set();
  const bindings = providerBindings();
  for (const id of ['stt', 'elevenlabs']) {
    const bound = bindings[id];
    if (!bound || originOf(bound) !== origin) continue;
    const key = vault.peek(id);
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push({ id, key });
    }
  }
  const pool = await readSttPool(origin);
  for (const pick of sttKeys.pickOrder(pool, sttPoolHealth())) {
    const entry = pool.find((row) => row.id === pick.id);
    if (!entry || !entry.key || seen.has(entry.key)) continue;
    seen.add(entry.key);
    out.push({ id: entry.id, key: entry.key });
  }
  return out;
}

/** Runs one ElevenLabs call, moving to the next saved key when one is refused. */
async function withElevenKey(run) {
  const net = security.networkPolicyBlock(elevenTts.ORIGIN);
  if (net) throw new Error(net);
  const attempts = await elevenKeyAttempts();
  if (!attempts.length) {
    throw new Error('No ElevenLabs key is saved for speech output. Add one in Settings → Voice — the same key list serves speech input and output.');
  }
  if (attempts.length === 1) return run(attempts[0].key);
  let health = sttPoolHealth();
  let lastError = null;
  let moved = false;
  const refused = [];
  for (const attempt of attempts) {
    try {
      const answer = await run(attempt.key);
      if (moved) db.setSetting(STT_POOL_HEALTH_SETTING, sttKeys.withSuccess(health, attempt.id));
      return answer;
    } catch (err) {
      const kind = sttKeys.classifyError(err);
      if (!sttKeys.shouldRotate(kind)) throw err;
      refused.push(attempt.id);
      lastError = err;
      moved = true;
      health = sttKeys.withFailure(health, attempt.id, kind, Date.now(), err && err.message ? err.message : String(err));
    }
  }
  db.setSetting(STT_POOL_HEALTH_SETTING, health);
  const detail = lastError && lastError.message ? ` Last answer: ${lastError.message}` : '';
  throw new Error(`All ${refused.length} saved ElevenLabs keys were refused.${detail}`);
}

function withMediaKey(payload, id) {
  const p = payload && typeof payload === 'object' ? payload : {};
  if (!p.url || p.key) return p;
  return { ...p, key: boundSecretOrEmpty(id, p.url) };
}

function configuredChain(payload = {}) {
  const fallback = payload.provider || null;
  const local = localBrain.candidate();
  const brainConfig = localBrain.getConfig();
  if (brainConfig.offline && !local) return [];
  const localFirst = brainConfig.prefer === 'local-first' || brainConfig.prefer === 'offline-only';
  const base = uniqueCandidates([
    ...(localFirst && local ? [local] : []),
    fallback,
    ...(Array.isArray(payload.candidates) ? payload.candidates : []),
    payload.local,
  ]);
  const planned = advanced.filterCandidates(base, {
    task: String(payload.task || 'agent'),
    prompt: String(payload.goal || payload.prompt || ''),
    sensitive: payload.sensitive === true,
  });
  const task = String(payload.task || 'agent');
  const saved = db.getRouting()[task];
  if (!Array.isArray(saved) || !saved.length) return planned.map(withProviderKey);
  const picked = [];
  for (const want of saved) {
    if (!want) continue;
    const id = String(want.providerId || want.id || want.presetId || '');
    const model = want.model ? String(want.model) : '';
    const match = planned.find(
      (c) => String(c.id || c.presetId || '') === id && (!model || String(c.model) === model) && !picked.includes(c),
    );
    if (match) picked.push(match);
  }
  return (picked.length ? [...picked, ...planned.filter((c) => !picked.includes(c))] : planned).map(withProviderKey);
}

/** Explain why no model is available instead of a generic error. */
function unavailableModelMessage(payload = {}) {
  try {
    const route = localBrain.route({ task: String(payload.task || 'agent') });
    if (route.target === 'blocked') return route.reason;
    const base = uniqueCandidates([
      payload.provider,
      ...(Array.isArray(payload.candidates) ? payload.candidates : []),
      payload.local,
    ]);
    const planned = advanced.planCandidates(base, {
      task: String(payload.task || 'agent'),
      prompt: String(payload.goal || payload.prompt || ''),
      sensitive: payload.sensitive === true,
    });
    return planned.reason || 'No model is configured.';
  } catch {
    return 'No model is configured.';
  }
}

/** Token and cost totals for one run, read from the real usage ledger. */
function usageForRun(runId) {
  try {
    const row = db.raw()
      ?.prepare(
        `SELECT COALESCE(SUM(prompt_tokens),0) AS promptTokens,
                COALESCE(SUM(completion_tokens),0) AS completionTokens,
                COALESCE(SUM(cost_usd),0) AS cost,
                COALESCE(SUM(ms),0) AS ms,
                COUNT(*) AS calls
         FROM usage WHERE run_id = ?`,
      )
      .get(runId);
    return {
      promptTokens: Number(row?.promptTokens) || 0,
      completionTokens: Number(row?.completionTokens) || 0,
      cost: Number(row?.cost) || 0,
      ms: Number(row?.ms) || 0,
      calls: Number(row?.calls) || 0,
    };
  } catch {
    return { promptTokens: 0, completionTokens: 0, cost: 0, ms: 0, calls: 0 };
  }
}

/** Outcome score: observable pass/fail only; cancelled runs stay unscored. */
function outcomeScore(event) {
  if (Number.isFinite(Number(event.score))) return Math.max(0, Math.min(1, Number(event.score)));
  if (event.ok) return 1;
  if (event.cancelled) return null;
  return 0;
}

function recordEpisode(payload) {
  training.appendEpisode(payload).catch((err) => {
    console.error('Episode recorder:', err && err.message ? err.message : err);
  });
}

function recordRunFinished({ runId, mode, goal, model, provider, plan, actions, event }) {
  const usage = usageForRun(runId);
  const status = event.cancelled ? 'cancelled' : event.ok ? 'done' : 'failed';
  recordEpisode({
    runId,
    kind: mode === 'orchestrator' ? 'orchestrator' : 'agent',
    goal,
    status,
    score: outcomeScore(event),
    provider,
    model,
    steps: Number(event.steps) || actions.filter((a) => a.type === 'tool').length,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    cost: usage.cost,
    ms: Number(event.ms) || 0,
    plan: plan || null,
    actions,
    outcome: {
      ok: !!event.ok,
      cancelled: !!event.cancelled,
      summary: event.summary || null,
      error: event.error || null,
      calls: usage.calls,
    },
    error: event.ok ? null : event.error || (event.cancelled ? null : event.summary || null),
  });
}

function recordWorkflowFinished(run) {
  const status = run.status === 'succeeded' ? 'done' : run.status === 'cancelled' ? 'cancelled' : 'failed';
  recordEpisode({
    runId: run.id,
    kind: 'workflow',
    goal: String(run.workflowName || 'Workflow run'),
    status,
    score: status === 'done' ? 1 : status === 'failed' ? 0 : null,
    provider: 'workflow',
    model: null,
    steps: Array.isArray(run.steps) ? run.steps.length : 0,
    ms: run.startedAt && run.endedAt ? Math.max(0, run.endedAt - run.startedAt) : 0,
    plan: { workflowId: run.workflowId, workflowName: run.workflowName },
    actions: Array.isArray(run.steps) ? run.steps.slice(-200) : [],
    outcome: {
      status: run.status,
      error: run.error || null,
      input: run.input || null,
      output: run.output || null,
    },
    error: run.error || null,
  });
}

function recordJobFinished(event) {
  const job = (() => {
    try {
      return advanced.getJob(event.id);
    } catch {
      return null;
    }
  })();
  const status = event.status === 'done' ? 'done' : event.status === 'cancelled' ? 'cancelled' : 'failed';
  recordEpisode({
    runId: event.id,
    kind: 'job',
    goal: String(job?.spec?.title || job?.title || `Job ${event.id}`),
    status,
    score: status === 'done' ? 1 : status === 'failed' ? 0 : null,
    provider: 'job',
    model: null,
    steps: Array.isArray(event.results) ? event.results.length : Array.isArray(job?.spec?.steps) ? job.spec.steps.length : 0,
    plan: job?.spec ? { title: job.spec.title, steps: job.spec.steps } : null,
    actions: Array.isArray(event.results) ? event.results.slice(-200) : [],
    outcome: { status: event.status, error: event.error || null },
    error: event.error || null,
  });
}

function normalizeHistory(messages) {
  return (Array.isArray(messages) ? messages : []).map((m) => ({
    role: m && m.role === 'assistant' ? 'assistant' : m && m.role === 'system' ? 'system' : 'user',
    text: String((m && (m.content ?? m.text)) || ''),
    ...(m && Array.isArray(m.images) && m.images.length ? { images: m.images } : {}),
  }));
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, payload) => {
    const blocked = security.channelBlocked(channel);
    if (blocked) return fail(new Error(blocked));
    try {
      return ok(await fn(payload, _event));
    } catch (err) {
      return fail(err);
    }
  });
}

// Local model servers and hosted APIs both get permissive CORS from the desktop
// shell: the renderer's origin is file:// (or the dev server), never their own.
// Only ORVEX's own windows get the relaxation — not every webContents in the session.
function relaxCors() {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const ids = new Set();
    if (win && !win.isDestroyed()) ids.add(win.webContents.id);
    if (mini && !mini.isDestroyed()) ids.add(mini.webContents.id);
    if (!ids.has(details.webContentsId)) {
      callback({});
      return;
    }
    const headers = { ...(details.responseHeaders || {}) };
    for (const key of Object.keys(headers)) {
      const lower = key.toLowerCase();
      if (lower.startsWith('access-control-allow-')) delete headers[key];
    }
    headers['access-control-allow-origin'] = ['*'];
    headers['access-control-allow-headers'] = ['*'];
    headers['access-control-allow-methods'] = ['GET, POST, PUT, PATCH, DELETE, OPTIONS'];
    callback({ responseHeaders: headers });
  });
}

/** Shared start path for the direct agent and the plan → execute → verify orchestrator. */
async function startEngine(payload = {}, mode = 'agent', extra = {}) {
  if (activeRun) throw new Error('The engine is already running a goal. Stop it first.');
  const resume = extra.resume === true;
  let goal = String(payload.goal || '').trim();
  let runId = String(payload.runId || '').trim();
  if (resume) {
    if (!runId) throw new Error('runId is required to resume a run.');
    const saved = db.runGet(runId);
    if (!saved) throw new Error('That run no longer exists.');
    if (!saved.checkpoint || !Array.isArray(saved.checkpoint.plan) || !saved.checkpoint.plan.length) {
      throw new Error('That run has no saved plan, so it cannot be resumed.');
    }
    goal = String(saved.goal || goal).trim();
    if (!goal) throw new Error('That run has no saved goal.');
  } else if (!goal) {
    throw new Error('Goal is empty.');
  }
  if (!payload.provider || !payload.provider.baseUrl || !payload.provider.model) {
    throw new Error('Pick a model provider in Settings before starting the engine.');
  }
  // Reserve the slot before the first await so two rapid Start clicks cannot
  // both pass the activeRun check and run concurrently.
  if (!runId) runId = `run_${Date.now().toString(36)}`;
  const controller = new AbortController();
  const agentId = payload.agentId ? String(payload.agentId) : null;
  const run = { runId, controller, paused: false, waiters: [], mode, agentId, goal: goal.slice(0, 4000) };
  activeRun = run;
  const abandon = () => {
    if (activeRun === run) activeRun = null;
  };

  let problem = null;
  try {
    problem = await preflightProvider(payload.provider);
  } catch (err) {
    abandon();
    throw err;
  }
  if (problem && !(Array.isArray(payload.candidates) && payload.candidates.length)) {
    abandon();
    throw new Error(problem);
  }

  const chain = configuredChain(payload);
  if (!chain.length) {
    abandon();
    throw new Error(unavailableModelMessage(payload));
  }

  try {
    const sqlite = db.raw();
    if (resume) {
      sqlite
        ?.prepare('UPDATE runs SET status = ?, ended_at = NULL, model = ?, provider = ?, agent_id = COALESCE(?, agent_id) WHERE id = ?')
        .run('running', payload.provider.model || null, payload.provider.name || null, agentId, runId);
    } else {
      sqlite
        ?.prepare('INSERT INTO runs(id, goal, status, model, provider, agent_id, steps, started_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)')
        .run(runId, goal.slice(0, 4000), 'running', payload.provider.model || null, payload.provider.name || null, agentId, 0, Date.now());
    }
  } catch {
    /* run history is best-effort */
  }

  const recorded = { plan: null, actions: [], model: null, provider: null, finished: false };
  let finishNotified = false;
  const emit = (event) => {
    if (event.type === 'run_start') {
      recorded.model = event.model || null;
      recorded.provider = event.provider || null;
    } else if (event.type === 'plan_created') {
      recorded.plan = event.plan || null;
    } else if (event.type === 'tool_start') {
      recorded.actions.push({ type: 'tool', id: event.id, name: event.name, args: event.args, at: Date.now() });
    } else if (event.type === 'tool_result') {
      const entry = [...recorded.actions].reverse().find((a) => a.type === 'tool' && a.id === event.id);
      if (entry) {
        entry.ok = event.ok !== false;
        entry.ms = Number(event.ms) || 0;
        entry.output = event.output || '';
        entry.error = event.error || null;
      } else {
        recorded.actions.push({
          type: 'tool',
          id: event.id,
          name: event.name,
          ok: event.ok !== false,
          ms: Number(event.ms) || 0,
          output: event.output || '',
          error: event.error || null,
          at: Date.now(),
        });
      }
    } else if (event.type === 'step_done') {
      recorded.actions.push({ type: 'step', step: event.step || null, ok: event.ok !== false, note: event.note || null, at: Date.now() });
    } else if (event.type === 'run_end' && !recorded.finished) {
      recorded.finished = true;
      recordRunFinished({
        runId,
        mode,
        goal: run.goal,
        model: recorded.model,
        provider: recorded.provider,
        plan: recorded.plan,
        actions: recorded.actions,
        event,
      });
      if (!finishNotified && typeof extra.onFinish === 'function') {
        finishNotified = true;
        try {
          extra.onFinish(event);
        } catch {
          /* the caller's bookkeeping must not break the run */
        }
      }
    }
    if (event.type === 'run_end') {
      try {
        db.raw()
          ?.prepare('UPDATE runs SET status = ?, steps = ?, ended_at = ?, summary = ? WHERE id = ?')
          .run(
            event.ok ? 'ok' : event.cancelled ? 'cancelled' : 'failed',
            Number(event.steps) || 0,
            Date.now(),
            String(event.summary || '').slice(0, 2000),
            runId,
          );
      } catch {
        /* run history is best-effort */
      }
    }
    if (event.type === 'run_start' || event.type === 'run_end') {
      if (tray) tray.setToolTip(event.type === 'run_start' ? 'ORVEX — running a goal' : 'ORVEX — idle');
    }
    if (win && !win.isDestroyed()) win.webContents.send('orvex:agent-event', { runId, ...event });
    const needsAttention =
      event.type === 'approval_request' || (event.type === 'run_end' && win && !win.isDestroyed() && !win.isFocused());
    if (needsAttention) {
      const title =
        event.type === 'approval_request'
          ? 'ORVEX needs your approval'
          : event.ok
            ? 'ORVEX — goal complete'
            : 'ORVEX — engine stopped';
      const body = String(event.type === 'approval_request' ? event.reason || event.name : event.summary || '').slice(0, 160);
      sendToWindow('orvex:notify', {
        title,
        body,
        kind: event.type === 'approval_request' ? 'agent' : 'system',
        target: event.type === 'approval_request' ? 'chat' : 'monitoring',
        runId,
        at: Date.now(),
      });
      try {
        const note = new Notification({ title, body });
        note.on('click', () => showWindow(true));
        note.show();
      } catch {
        /* notifications unavailable */
      }
    }
  };

  const releaseWaiters = () => {
    const waiting = run.waiters.splice(0);
    for (const resolve of waiting) resolve();
  };

  const gate = () =>
    new Promise((resolve) => {
      if (!run.paused || controller.signal.aborted) resolve();
      else run.waiters.push(resolve);
    });

  const approve = (req) =>
    new Promise((resolve) => {
      const done = (allowed) => {
        const entry = pendingApprovals.get(req.id);
        if (!entry) return;
        pendingApprovals.delete(req.id);
        clearTimeout(entry.timer);
        controller.signal.removeEventListener('abort', entry.onAbort);
        resolve(allowed);
      };
      const onAbort = () => done(false);
      controller.signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => done(false), APPROVAL_TIMEOUT_MS);
      pendingApprovals.set(req.id, { done, timer, onAbort, runId });
      if (win && !win.isDestroyed() && !win.isFocused()) {
        try {
          win.flashFrame(true);
        } catch {
          /* some platforms have no frame */
        }
      }
    });

  run.gate = gate;
  run.releaseWaiters = releaseWaiters;

  void (async () => {
    let memory = '';
    try {
      const structured = memoryStore.context({ goal, limit: 6, maxChars: 2200 });
      if (structured) memory += `Structured long-term memory (searchable in the Memory page):\n${structured}\n\n`;
    } catch {
      /* memory stays empty rather than blocking the run */
    }
    try {
      const legacy = (await fsp.readFile(MEMORY_FILE, 'utf8')).trim();
      if (legacy) memory += `Legacy memory notes:\n${legacy.slice(-4000)}`;
    } catch {
      /* first run — no legacy notes yet */
    }
    const compact = payload.compactTools === true;
    // A spoken turn keeps the prompt small: a token-metered provider rejects the
    // whole request rather than trimming it, and the reply is what matters.
    memory = memory.slice(-(compact ? 2400 : 8000));
    const shared = {
      goal,
      provider: payload.provider,
      candidates: chain,
      local: payload.local || null,
      memory,
      emit,
      signal: controller.signal,
      gate,
      approve,
      maxSteps: payload.maxSteps,
      autoApprove: payload.autoApprove === true && security.status().role === 'owner',
      runId,
      task: payload.task || 'agent',
      // Voice turns carry a lean tool set: a spoken question does not need the
      // maker or training tools, and a small per-minute budget rejects them.
      compactTools: compact,
    };
    const blocks = [];
    if (payload.systemAppend) blocks.push(String(payload.systemAppend).trim());
    if (!compact) {
      try {
        const catalog = learner.skillCatalog(12);
        if (catalog.length) {
          blocks.push(
            `Enabled skills from earlier successful runs. Each line is one skill — call skill_load with its id to get the full steps before applying one:\n${catalog.join('\n')}`,
          );
        }
      } catch {
        /* skills are an optimisation, never a reason to block a run */
      }
    }
    if (blocks.filter(Boolean).length) shared.systemAppend = blocks.filter(Boolean).join('\n\n');
    if (mode === 'orchestrator') await runOrchestrator({ ...shared, resume });
    else await runAgent(shared);
  })()
    .catch((err) => {
      const message = err && err.message ? err.message : String(err);
      emit({ type: 'error', message });
      emit({ type: 'run_end', ok: false, mode, summary: `Run crashed: ${message}` });
    })
    .finally(() => {
      planTodos.clear(runId);
      delegates.cancelForParent(runId, 'The parent run finished before this sub-agent did.');
      delegates.clear(runId);
      for (const [id, entry] of pendingApprovals) {
        if (entry.runId === runId) {
          pendingApprovals.delete(id);
          clearTimeout(entry.timer);
          entry.done(false);
        }
      }
      if (activeRun === run) activeRun = null;
    });

  return { runId };
}

/**
 * A workforce shift is a real engine run. The agent either has a stored cloud
 * model assignment (key hydrated here from the vault binding) or uses the
 * running Local Brain; nothing is started without a reachable model.
 */
async function runWorkforceShift({ agent, goal, systemAppend, onRunId }) {
  const emergency = security.status().emergency;
  if (emergency && emergency.stopped) {
    throw new Error(`Emergency stop is active${emergency.reason ? ` (${emergency.reason})` : ''}. A shift cannot start.`);
  }
  const assigned = agent && agent.model && typeof agent.model === 'object' ? agent.model : null;
  const local = localBrain.candidate();
  const provider = assigned && assigned.baseUrl && assigned.model ? withProviderKey({ ...assigned }) : local;
  if (!provider || !provider.baseUrl || !provider.model) {
    throw new Error('Assign a cloud model to this agent, or start the Local Brain with a chat model loaded.');
  }
  const candidates = uniqueCandidates([provider]);
  let finish = null;
  const finished = new Promise((resolve) => {
    finish = resolve;
  });
  const result = await startEngine(
    { goal, provider, candidates, task: 'agent', systemAppend },
    'agent',
    { workforce: true, onFinish: (event) => finish(event) },
  );
  try {
    if (onRunId) onRunId(result.runId);
  } catch {
    /* linking the shift to the run trace is best-effort */
  }
  return await finished;
}

function autoResumeEnabled() {
  return db.getSetting(AUTO_RESUME_SETTING, true) !== false;
}

/**
 * Continue the newest plan that was mid-flight when ORVEX closed. Completed
 * steps are not re-run; a step that was interrupted asks for approval before
 * it executes again. Runs paused by the user are left alone.
 */
async function autoResumeInterrupted() {
  if (!autoResumeEnabled() || activeRun) return null;
  const state = security.status();
  if (state.locked || (state.emergency && state.emergency.stopped)) return null;
  const target = runRecovery.autoResumeTarget(db.runsUnfinished(15));
  if (!target) return null;
  const provider = withProviderKey({ ...target.provider });
  if (!provider.baseUrl || !provider.model) return null;
  const candidates = target.candidates.map((candidate) => withProviderKey({ ...candidate }));
  try {
    await startEngine(
      { runId: target.runId, goal: target.goal, provider, candidates, task: target.task },
      'orchestrator',
      { resume: true },
    );
    sendToWindow('orvex:notify', {
      title: 'ORVEX resumed a plan',
      body: `${target.goal.slice(0, 140)} — continuing after the restart. Steps already verified are not repeated.`,
      kind: 'system',
      target: 'engine',
      runId: target.runId,
      at: Date.now(),
    });
    return target.runId;
  } catch (err) {
    sendToWindow('orvex:notify', {
      title: 'ORVEX could not resume a plan',
      body: `${err && err.message ? err.message : String(err)} Open Engine to resume it manually.`,
      kind: 'system',
      target: 'engine',
      runId: target.runId,
      at: Date.now(),
    });
    return null;
  }
}

function registerIpc() {
  const dialogFilters = (raw) => {
    const filters = (Array.isArray(raw) ? raw : [])
      .map((f) => ({
        name: String((f && f.name) || 'Files'),
        extensions: (Array.isArray(f && f.extensions) ? f.extensions : [])
          .map((e) => String(e).replace(/^\./, ''))
          .filter(Boolean),
      }))
      .filter((f) => f.extensions.length);
    return filters.length ? filters : undefined;
  };

  handle('orvex:env', () => ({
    platform: process.platform,
    arch: process.arch,
    versions: {
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome,
    },
    home: app.getPath('home'),
    userData: app.getPath('userData'),
    auditFile: AUDIT_FILE,
    dev: !!DEV_URL,
    hotkey: registeredHotkey,
    approvalTimeoutMs: APPROVAL_TIMEOUT_MS,
  }));

  handle('orvex:app:prefs', () => {
    let launchAtLogin = false;
    try {
      launchAtLogin = app.getLoginItemSettings().openAtLogin;
    } catch {
      /* unsupported platform */
    }
    return {
      launchAtLogin,
      closeToTray: !!prefs.closeToTray,
      packaged: app.isPackaged,
      version: app.getVersion(),
      userData: DATA_DIR,
    };
  });

  handle('orvex:app:prefs:set', ({ launchAtLogin, closeToTray } = {}) => {
    if (typeof closeToTray === 'boolean') {
      prefs.closeToTray = closeToTray;
      savePrefs();
    }
    if (typeof launchAtLogin === 'boolean') {
      if (!app.isPackaged) throw new Error('Startup registration works in the installed build, not from the dev runner.');
      app.setLoginItemSettings({ openAtLogin: launchAtLogin, path: process.execPath });
    }
    let openAtLogin = false;
    try {
      openAtLogin = app.getLoginItemSettings().openAtLogin;
    } catch {
      /* unsupported platform */
    }
    return { launchAtLogin: openAtLogin, closeToTray: !!prefs.closeToTray, packaged: app.isPackaged };
  });

  handle('orvex:app:window', ({ action, id, tab } = {}) => {
    const main = win && !win.isDestroyed() ? win : null;
    switch (action) {
      case 'state':
        break;
      case 'minimize':
        if (!main) throw new Error('The main window is not open.');
        main.minimize();
        break;
      case 'maximize':
        if (!main) throw new Error('The main window is not open.');
        if (main.isMaximized()) main.unmaximize();
        else main.maximize();
        break;
      case 'restore':
        if (!main) throw new Error('The main window is not open.');
        if (main.isMinimized()) main.restore();
        main.show();
        main.focus();
        break;
      case 'hide':
        if (!main) throw new Error('The main window is not open.');
        main.hide();
        break;
      case 'close':
        if (!main) throw new Error('The main window is not open.');
        main.close();
        break;
      case 'showMain':
        showWindow(true);
        break;
      case 'quit':
        quitting = true;
        app.quit();
        break;
      case 'openMini':
        createMiniWindow();
        break;
      case 'closeMini':
        if (mini && !mini.isDestroyed()) mini.close();
        break;
      case 'toggleMini':
        toggleMiniWindow();
        break;
      case 'navigate': {
        if (!main) throw new Error('The main window is not open.');
        if (main.isMinimized()) main.restore();
        main.show();
        main.focus();
        main.webContents.send('orvex:navigate', { id: String(id || 'home'), tab: tab ? String(tab) : null });
        break;
      }
      default:
        throw new Error(`Unknown window action "${String(action)}".`);
    }
    return windowState();
  });

  handle('orvex:tool', async ({ name, args } = {}) => {
    if (!tools.definitions.some((d) => d.name === name)) throw new Error(`Tool "${name}" is not exposed.`);
    const escalation = tools.escalationReason(name, args || {});
    const reason = tools.approvalReason(name, args || {}) || (escalation && escalation.reason);
    if (reason) {
      const answer = await dialog.showMessageBox(win && !win.isDestroyed() ? win : null, {
        type: 'warning',
        title: 'Approve this tool call?',
        message: `${name} needs your approval`,
        detail: reason,
        buttons: ['Run once', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      if (answer.response !== 0) throw new Error('The tool call was not approved.');
    }
    return await tools.runTool(name, args || {}, { runId: 'renderer' });
  });

  handle('orvex:mcp:get', async () => {
    const saved = await mcp.getConfig();
    return { ...saved, status: mcp.status() };
  });

  handle('orvex:mcp:set', async ({ servers } = {}) => {
    if (activeRun) throw new Error('Stop the running goal before changing MCP servers.');
    const result = await mcp.setConfig(servers);
    tools.applyMcp(result.definitions, mcp.callMcpTool);
    return { status: result.status };
  });

  handle('orvex:mcp:reconnect', async () => {
    if (activeRun) throw new Error('Stop the running goal before reconnecting MCP servers.');
    const status = await connectMcp();
    return { status };
  });

  handle('orvex:agent:start', (payload = {}) =>
    startEngine(payload, payload.mode === 'orchestrator' ? 'orchestrator' : 'agent'),
  );

  handle('orvex:orchestrator:start', (payload = {}) => startEngine({ ...payload, mode: 'orchestrator' }, 'orchestrator'));

  handle('orvex:orchestrator:resume', (payload = {}) => startEngine(payload, 'orchestrator', { resume: true }));

  handle('orvex:orchestrator:runs', ({ limit } = {}) => ({
    runs: db.runsRecent(limit || 15),
    resumable: db.runsUnfinished(15),
    autoResume: autoResumeEnabled(),
  }));

  handle('orvex:orchestrator:setAutoResume', ({ enabled } = {}) => {
    db.setSetting(AUTO_RESUME_SETTING, enabled !== false);
    return { enabled: autoResumeEnabled() };
  });

  handle('orvex:orchestrator:run', ({ runId } = {}) => {
    if (!runId) throw new Error('runId is required.');
    const run = db.runGet(runId);
    if (!run) throw new Error('Run not found.');
    return { run, steps: db.runStepsGet(runId) };
  });

  handle('orvex:agent:stop', () => {
    if (!activeRun) return { stopped: false };
    const run = activeRun;
    run.controller.abort();
    run.releaseWaiters();
    activeRun = null;
    return { stopped: true };
  });

  handle('orvex:agent:pause', () => {
    if (!activeRun) throw new Error('The engine is not running.');
    if (activeRun.paused) return { paused: true };
    activeRun.paused = true;
    win?.webContents.send('orvex:agent-event', { runId: activeRun.runId, type: 'paused' });
    return { paused: true };
  });

  handle('orvex:agent:resume', () => {
    if (!activeRun) throw new Error('The engine is not running.');
    if (!activeRun.paused) return { paused: false };
    activeRun.paused = false;
    activeRun.releaseWaiters();
    win?.webContents.send('orvex:agent-event', { runId: activeRun.runId, type: 'resumed' });
    return { paused: false };
  });

  handle('orvex:agent:approve', ({ id, allow } = {}) => {
    const entry = id ? pendingApprovals.get(id) : null;
    if (!entry) return { resolved: false };
    entry.done(!!allow);
    return { resolved: true };
  });

  handle('orvex:agent:status', () => ({
    running: !!activeRun,
    paused: !!(activeRun && activeRun.paused),
    runId: activeRun ? activeRun.runId : null,
    agentId: activeRun ? activeRun.agentId || null : null,
  }));

  /**
   * Streaming chat for the renderer. The promise resolves as soon as the stream
   * is registered; tokens flow back on `orvex:llm-event` so the UI stays live.
   */
  handle('orvex:llm:start', (payload = {}) => {
    const requestId = String(payload.requestId || '');
    if (!requestId) throw new Error('requestId is missing.');
    if (llmStreams.has(requestId)) throw new Error('That request is already streaming.');
    const chain = configuredChain(payload);
    if (!chain.length) throw new Error(unavailableModelMessage(payload));

    const controller = new AbortController();
    llmStreams.set(requestId, controller);
    const send = (event) => {
      if (win && !win.isDestroyed()) win.webContents.send('orvex:llm-event', { requestId, ...event });
    };

    void (async () => {
      try {
        const result = await gateway.chat({
          candidates: chain,
          task: payload.task || 'chat',
          system: payload.system,
          history: normalizeHistory(payload.messages),
          temperature: payload.temperature,
          maxTokens: payload.maxTokens || 4096,
          jsonSchema: payload.jsonSchema || null,
          stream: payload.stream !== false,
          signal: controller.signal,
          runId: payload.runId || null,
          noImages: payload.noImages === true,
          onDelta: (delta, full) => send({ type: 'delta', text: delta, full }),
          onReasoning: (full) => send({ type: 'reasoning', text: full }),
          onFirstToken: () => send({ type: 'first' }),
          onEvent: (event) => send({ type: 'gateway', event }),
          onUsage: (usage) => send({ type: 'usage', usage }),
        });
        send({ type: 'done', text: result.text, usage: result.usage, provider: result.provider, model: result.model, ms: result.ms });
      } catch (err) {
        if (err && err.name === 'AbortError') send({ type: 'aborted' });
        else send({ type: 'error', message: err && err.message ? err.message : String(err) });
      } finally {
        llmStreams.delete(requestId);
      }
    })();

    return { requestId, candidates: chain.map((c) => ({ id: c.id || c.presetId || c.baseUrl, name: c.name || c.model, model: c.model })) };
  });

  handle('orvex:llm:abort', ({ requestId } = {}) => {
    const id = String(requestId || '');
    const controller = id ? llmStreams.get(id) : null;
    if (!controller) return { aborted: false };
    controller.abort();
    llmStreams.delete(id);
    return { aborted: true };
  });

  handle('orvex:routing:get', () => ({ routing: db.getRouting(), tasks: ROUTING_TASKS }));

  handle('orvex:routing:set', ({ task, chain } = {}) => {
    if (!task) throw new Error('Routing task is missing.');
    if (!ROUTING_TASKS.includes(String(task))) throw new Error(`Unknown routing task "${task}".`);
    return { routing: db.setRouting(String(task), Array.isArray(chain) ? chain : []) };
  });

  handle('orvex:routing:clear', ({ task } = {}) => {
    if (task) db.setRouting(String(task), []);
    return { routing: db.getRouting() };
  });

  handle('orvex:usage:summary', ({ sinceMs } = {}) => {
    const window = Number(sinceMs) || 24 * 3600 * 1000;
    return db.usageSummary({ sinceMs: window }) || { totals: null, byModel: [], byTask: [], since: null };
  });

  handle('orvex:usage:recent', (limit = 50) => db.usageRecent(limit));

  handle('orvex:usage:clear', () => db.clearUsage());

  handle('orvex:budget:get', () => advisor.getBudget());

  handle('orvex:budget:set', ({ dailyUsd, monthlyUsd } = {}) => {
    const next = advisor.setBudget({ dailyUsd, monthlyUsd });
    advisor.invalidate();
    return next;
  });

  /* ------------------------------------------------------ Phase 11 — advisor */

  handle('orvex:advisor:brief', () => advisor.brief({ force: true }));
  handle('orvex:advisor:suggestions', () => advisor.suggestions({ force: true }));
  handle('orvex:advisor:dismiss', ({ id, hours } = {}) => {
    const result = advisor.dismiss({ id, hours });
    try {
      tools.audit({ kind: 'advisor-dismiss', ok: true, args: JSON.stringify({ id: result.id, until: result.until }) });
    } catch {
      /* the preference is already saved */
    }
    return result;
  });
  handle('orvex:advisor:restore', ({ id } = {}) => advisor.restore({ id }));
  handle('orvex:advisor:budget', () => advisor.getBudget());
  handle('orvex:advisor:budget:set', (payload = {}) => {
    requireOwner();
    const next = advisor.setBudget(payload || {});
    advisor.invalidate();
    return next;
  });
  handle('orvex:advisor:update', () => advisor.getUpdate());
  handle('orvex:advisor:update:feed', (payload = {}) => {
    requireOwner();
    return advisor.setUpdateFeed(payload || {});
  });
  handle('orvex:advisor:update:check', async (payload = {}) => {
    const result = await advisor.checkUpdate(payload || {});
    advisor.invalidate();
    return result;
  });

  /* ------------------------------------------------- GitHub release updater */

  handle('orvex:updater:state', () => updater.state());
  handle('orvex:updater:repo', (payload = {}) => {
    requireOwner();
    return updater.setRepo(payload || {});
  });
  handle('orvex:updater:autoCheck', (payload = {}) => {
    requireOwner();
    return updater.setAutoCheck(payload || {});
  });
  handle('orvex:updater:check', async (payload = {}) => {
    requireOwner();
    return updater.check(payload || {});
  });
  handle('orvex:updater:download', async () => {
    requireOwner();
    return updater.download();
  });
  handle('orvex:updater:install', async () => {
    requireOwner();
    return updater.install();
  });
  handle('orvex:updater:reveal', () => updater.reveal());
  handle('orvex:updater:openRelease', () => updater.openRelease());

  /* ------------------------------------------------------------- Game Pilot */

  handle('orvex:gamepilot:profiles', () => gamePilot.listProfiles());
  handle('orvex:gamepilot:status', () => gamePilot.status());
  handle('orvex:gamepilot:saveProfile', (payload = {}) => {
    requireOwner();
    return gamePilot.saveProfile(payload || {});
  });
  handle('orvex:gamepilot:deleteProfile', ({ id } = {}) => {
    requireOwner();
    return gamePilot.deleteProfile(id);
  });
  handle('orvex:gamepilot:start', ({ id } = {}) => {
    requireOwner();
    return gamePilot.start(id);
  });
  handle('orvex:gamepilot:stop', () => gamePilot.stop());

  handle('orvex:health:reset', () => {
    db.healthResetAll();
    return { reset: true };
  });

  /* --------------------------------------------------- Section 15: monitoring */

  handle('orvex:monitor:overview', () => monitor.overview());
  handle('orvex:monitor:series', ({ minutes } = {}) => monitor.series({ minutes }));
  handle('orvex:monitor:sample', () => monitor.sampleOnce());
  handle('orvex:monitor:usage', (payload = {}) => monitor.usage(payload || {}));
  handle('orvex:monitor:usageSeries', (payload = {}) => monitor.usageSeries(payload || {}));
  handle('orvex:monitor:usageCsv', (payload = {}) => monitor.usageCsv(payload || {}));
  handle('orvex:monitor:traces', (payload = {}) => monitor.traces(payload || {}));
  handle('orvex:monitor:trace', (payload = {}) => monitor.trace(payload || {}));
  handle('orvex:monitor:compare', (payload = {}) => monitor.compare(hydrateProviderPayload(payload || {})));
  handle('orvex:monitor:health', (payload = {}) => monitor.health(hydrateProviderPayload(payload || {})));
  handle('orvex:monitor:recoverables', () => monitor.recoverables());
  handle('orvex:monitor:abandon', (payload = {}) => monitor.abandonRun(payload || {}));
  handle('orvex:monitor:crashes', ({ limit } = {}) => monitor.crashes(limit));
  handle('orvex:monitor:clearCrashes', () => monitor.clearCrashes());
  handle('orvex:monitor:evalSuites', () => monitor.evalSuites());
  handle('orvex:monitor:evalSave', (payload = {}) => monitor.evalSave(payload || {}));
  handle('orvex:monitor:evalDelete', (payload = {}) => monitor.evalDelete(payload || {}));
  handle('orvex:monitor:evalRun', (payload = {}) => monitor.evalRun(hydrateProviderPayload(payload || {})));
  handle('orvex:monitor:evalHistory', (payload = {}) => monitor.evalHistory(payload || {}));
  handle('orvex:monitor:evalClear', (payload = {}) => monitor.evalClear(payload || {}));

  /* ------------------------------------------------- Section 17: productivity */

  handle('orvex:productivity:capabilities', () => productivity.capabilities());
  handle('orvex:productivity:calc', (payload = {}) => productivity.calc(payload || {}));
  handle('orvex:productivity:pythonInfo', () => productivity.pythonInfo());
  handle('orvex:productivity:runPython', (payload = {}) => productivity.runPython(payload || {}));
  handle('orvex:productivity:dataAnalyze', (payload = {}) => productivity.dataAnalyze(payload || {}));
  handle('orvex:productivity:dataChart', (payload = {}) => productivity.dataChart(payload || {}));
  handle('orvex:productivity:sheetOpen', (payload = {}) => productivity.sheetOpen(payload || {}));
  handle('orvex:productivity:sheetSave', (payload = {}) => productivity.sheetSave(payload || {}));
  handle('orvex:productivity:sheetCreate', (payload = {}) => productivity.sheetCreate(payload || {}));
  handle('orvex:productivity:sqlRun', (payload = {}) => productivity.sqlRun(payload || {}));
  handle('orvex:productivity:sqlTables', () => productivity.sqlTables());
  handle('orvex:productivity:sqlSchema', (payload = {}) => productivity.sqlSchema(payload || {}));
  handle('orvex:productivity:reportBuild', (payload = {}) => productivity.reportBuild(payload || {}));
  handle('orvex:productivity:transcribeAudio', (payload = {}) => productivity.transcribeAudio(payload || {}));
  handle('orvex:productivity:meetingSummarize', (payload = {}) =>
    productivity.meetingSummarize({ ...(payload || {}), candidates: configuredChain({ ...(payload || {}), task: 'summarize' }) }));
  handle('orvex:productivity:noteList', (payload = {}) => productivity.noteList(payload || {}));
  handle('orvex:productivity:noteCreate', (payload = {}) => productivity.noteCreate(payload || {}));
  handle('orvex:productivity:noteUpdate', (payload = {}) => productivity.noteUpdate(payload || {}));
  handle('orvex:productivity:noteDelete', (payload = {}) => productivity.noteDelete(payload || {}));
  handle('orvex:productivity:noteAsk', (payload = {}) =>
    productivity.noteAsk({ ...(payload || {}), candidates: configuredChain({ ...(payload || {}), task: 'memory' }) }));
  handle('orvex:productivity:taskList', (payload = {}) => productivity.taskList(payload || {}));
  handle('orvex:productivity:taskCreate', (payload = {}) => productivity.taskCreate(payload || {}));
  handle('orvex:productivity:taskUpdate', (payload = {}) => productivity.taskUpdate(payload || {}));
  handle('orvex:productivity:taskToggle', (payload = {}) => productivity.taskToggle(payload || {}));
  handle('orvex:productivity:taskRemove', (payload = {}) => productivity.taskRemove(payload || {}));
  handle('orvex:productivity:taskStats', () => productivity.taskStats());
  handle('orvex:productivity:translate', (payload = {}) =>
    productivity.translate({ ...(payload || {}), candidates: configuredChain({ ...(payload || {}), task: 'chat' }) }));
  handle('orvex:productivity:textList', () => productivity.textList());
  handle('orvex:productivity:textOpen', (payload = {}) => productivity.textOpen(payload || {}));
  handle('orvex:productivity:textSave', (payload = {}) => productivity.textSave(payload || {}));
  handle('orvex:productivity:textRemove', (payload = {}) => productivity.textRemove(payload || {}));
  handle('orvex:productivity:textRename', (payload = {}) => productivity.textRename(payload || {}));
  handle('orvex:productivity:slidesBuild', (payload = {}) => productivity.slidesBuild(payload || {}));
  handle('orvex:productivity:compareDocs', (payload = {}) => productivity.compareDocs(payload || {}));
  handle('orvex:productivity:artifacts', (payload = {}) => productivity.artifacts(payload || {}));

  handle('orvex:db:info', () => db.info());

  handle('orvex:audit:tail', async (limit = 120) => {
    const n = Math.min(Math.max(Number(limit) || 120, 1), 1000);
    const rows = db.auditTail(n);
    if (rows.length) {
      return rows.map((row) => ({
        ts: new Date(Number(row.ts) || Date.now()).toISOString(),
        kind: row.kind,
        ...(row.tool ? { tool: row.tool } : {}),
        ...(row.args ? { args: row.args } : {}),
        ...(row.ok === null || row.ok === undefined ? {} : { ok: !!row.ok }),
        ...(row.ms === null || row.ms === undefined ? {} : { ms: row.ms }),
        ...(row.error ? { error: row.error } : {}),
        ...(row.runId ? { runId: row.runId } : {}),
      }));
    }
    // Older installs only have the JSONL trail; keep reading it as a fallback.
    let raw = '';
    try {
      raw = await fsp.readFile(AUDIT_FILE, 'utf8');
    } catch {
      return [];
    }
    const lines = raw.trim().split('\n').filter(Boolean).slice(-n);
    return lines.map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { kind: 'raw', text: line };
      }
    });
  });

  handle('orvex:secrets:get', async () => {
    const map = await vault.load();
    // Presence only: values stay in the main process.
    const keys = {};
    for (const id of Object.keys(map)) keys[id] = true;
    return { available: vault.available(), keys };
  });

  handle('orvex:secrets:set', async ({ id, key, baseUrl } = {}) => {
    const name = String(id || '');
    if (!/^[a-z0-9._:-]{1,80}$/i.test(name)) throw new Error('Secret id is not valid.');
    if (!vault.available()) throw new Error('OS encryption is not available on this machine.');
    const value = key ? String(key) : '';
    await vault.set(name, value || null);
    if (baseUrl) saveProviderBinding(name, String(baseUrl));
    else if (!value) saveProviderBinding(name, null);
    if (value) security.setSecretValues(Object.values(await vault.load()));
    return { saved: !!value, hasKey: !!value };
  });

  /* ------------------------------------- provider probes (keys stay in main) */

  function providerInput(payload) {
    const p = payload && typeof payload === 'object' && payload.provider ? payload.provider : payload || {};
    return p && typeof p === 'object' ? p : {};
  }

  function providerTarget(payload) {
    const p = withProviderKey({ ...providerInput(payload) });
    const base = String(p.baseUrl || '').trim().replace(/\/+$/, '');
    if (!base || base.length > 500) throw new Error('The provider base URL is missing or too long.');
    const blocked = security.networkPolicyBlock(base);
    if (blocked) throw new Error(blocked);
    return { provider: p, base };
  }

  function providerHeaders(p) {
    const headers = { accept: 'application/json' };
    if (p.apiKey) {
      if (p.api === 'anthropic') {
        headers['x-api-key'] = p.apiKey;
        headers['anthropic-version'] = '2023-06-01';
      } else {
        headers.authorization = `Bearer ${p.apiKey}`;
      }
    }
    return headers;
  }

  async function providerFetch(url, init, timeout = 12_000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  handle('orvex:providers:models', async (payload = {}) => {
    const { provider, base } = providerTarget(payload);
    const res = await providerFetch(`${base}/models`, { headers: providerHeaders(provider) }).catch(() => null);
    if (!res || !res.ok) return null;
    const data = await res.json().catch(() => null);
    const rows = Array.isArray(data && data.data) ? data.data : Array.isArray(data && data.models) ? data.models : [];
    const models = [];
    const skipped = [];
    let priced = false;
    for (const row of rows) {
      const id = row && typeof row.id === 'string' ? row.id : '';
      if (!id) continue;
      // Speech, classifier and image endpoints live in the same /models list as
      // chat models (Groq lists whisper and prompt-guard there too). They cannot
      // answer a chat completion, so they stay out of the model dropdown.
      if (modelCatalog.nonChatModel(id)) {
        skipped.push(id);
        continue;
      }
      let free = /:free$/i.test(id);
      const pricing = row.pricing;
      if (pricing && typeof pricing === 'object') {
        const pin = pricing.prompt ?? pricing.input;
        const pout = pricing.completion ?? pricing.output;
        if (pin !== undefined || pout !== undefined) {
          const zero = (v) => v !== undefined && v !== null && v !== '' && Number(v) === 0;
          priced = true;
          free = zero(pin) && zero(pout);
        }
      }
      models.push({ id, free });
    }
    return models.length ? { models, priced, skipped } : null;
  });

  handle('orvex:providers:test', async (payload = {}) => {
    const { provider, base } = providerTarget(payload);
    const started = Date.now();
    const name = String(provider.name || provider.id || 'Provider');

    if (provider.api === 'anthropic') {
      const res = await providerFetch(`${base}/messages`, {
        method: 'POST',
        headers: { ...providerHeaders(provider), 'content-type': 'application/json' },
        body: JSON.stringify({
          model: provider.model || 'claude-sonnet-4-6',
          max_tokens: 16,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      }).catch((err) => ({ ok: false, status: 0, statusText: '', text: async () => String(err && err.message ? err.message : err), json: async () => ({}) }));
      const ms = Date.now() - started;
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { ok: false, label: name, detail: `HTTP ${res.status} — ${String(body || res.statusText || '').slice(0, 160)}` };
      }
      const data = await res.json().catch(() => ({}));
      const reply = data && data.content && data.content[0] && data.content[0].text;
      return { ok: true, label: name, detail: `Connected in ${ms}ms — replied "${String(reply || 'ok').slice(0, 40)}"` };
    }

    const res = await providerFetch(`${base}/models`, { headers: providerHeaders(provider) }).catch((err) => ({
      ok: false,
      status: 0,
      statusText: String(err && err.message ? err.message : err),
      text: async () => '',
      json: async () => ({}),
    }));
    const ms = Date.now() - started;
    if (!res.ok) {
      if (res.status === 404 || res.status === 405) {
        const probe = await providerFetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: { ...providerHeaders(provider), 'content-type': 'application/json' },
          body: JSON.stringify({
            model: provider.model || 'local-model',
            max_tokens: 8,
            messages: [{ role: 'user', content: 'ping' }],
          }),
        }).catch(() => null);
        const pms = Date.now() - started;
        if (!probe || !probe.ok) {
          const body = probe ? await probe.text().catch(() => '') : '';
          return { ok: false, label: name, detail: `HTTP ${probe ? probe.status : 0} — ${String(body || (probe ? probe.statusText : 'unreachable')).slice(0, 160)}` };
        }
        return { ok: true, label: name, detail: `Connected in ${pms}ms (chat probe)` };
      }
      const body = await res.text().catch(() => '');
      return { ok: false, label: name, detail: `HTTP ${res.status} — ${String(body || res.statusText || '').slice(0, 160)}` };
    }
    const data = await res.json().catch(() => ({}));
    const ids = (Array.isArray(data && data.data) ? data.data : []).map((m) => m && m.id).filter(Boolean);
    return {
      ok: true,
      label: name,
      detail: `Connected in ${ms}ms — ${ids.length ? `${ids.length} models (${ids.slice(0, 3).join(', ')})` : 'server reachable'}`,
    };
  });

  handle('orvex:media:assets', () => mediaServer.info());

  const announceCode = (info) => {
    if (win && !win.isDestroyed()) win.webContents.send('orvex:code:changed', info);
    return info;
  };

  handle('orvex:code:info', () => code.info());

  handle('orvex:code:open', async () => {
    const opts = {
      title: 'Open a coding workspace',
      properties: ['openDirectory'],
      buttonLabel: 'Open folder',
    };
    const picked = win && !win.isDestroyed() ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (picked.canceled || !picked.filePaths.length) return { cancelled: true, info: await code.info() };
    return { cancelled: false, info: announceCode(await code.open(picked.filePaths[0])) };
  });

  handle('orvex:code:openPath', async ({ dir } = {}) => {
    const blocked = guardrails.checkPath(String(dir || ''), 'read');
    if (blocked) throw new Error(blocked);
    return announceCode(await code.open(dir));
  });
  handle('orvex:code:close', async () => {
    await code.close();
    return announceCode(await code.info());
  });
  handle('orvex:code:list', ({ path: rel } = {}) => code.list(rel));
  handle('orvex:code:read', ({ path: rel } = {}) => code.read(rel));
  handle('orvex:code:write', ({ path: rel, content } = {}) => code.write(rel, content));
  handle('orvex:code:rename', ({ from, to } = {}) => code.rename(from, to));
  handle('orvex:code:remove', ({ path: rel } = {}) => code.remove(rel));
  handle('orvex:code:search', ({ query } = {}) => code.search(query));
  handle('orvex:code:gitStatus', () => code.gitStatus());
  handle('orvex:code:gitDiff', (payload = {}) => code.gitDiff(payload));
  handle('orvex:code:gitStage', ({ paths } = {}) => code.gitStage(paths));
  handle('orvex:code:gitUnstage', ({ paths } = {}) => code.gitUnstage(paths));
  handle('orvex:code:gitCommit', ({ message } = {}) => code.gitCommit(message));
  handle('orvex:code:gitLog', ({ limit } = {}) => code.gitLog(limit));
  handle('orvex:code:gitInit', () => code.gitInit());
  handle('orvex:code:run', ({ script } = {}) => code.runScript(script));
  handle('orvex:code:terminal', ({ command, cwd } = {}) => code.terminal(command, cwd));
  handle('orvex:code:stop', ({ runId } = {}) => code.stop(runId));

  handle('orvex:research:info', () => research.info());
  handle('orvex:research:list', () => research.list());
  handle('orvex:research:get', async ({ id } = {}) => {
    const entry = await research.get(String(id || ''));
    if (!entry) throw new Error('Research report not found.');
    return entry;
  });
  handle('orvex:research:delete', ({ id } = {}) => research.remove(String(id || '')));
  handle('orvex:research:start', (payload = {}) => research.start(payload));
  handle('orvex:research:stop', ({ runId } = {}) => research.stop(runId ? String(runId) : null));
  handle('orvex:research:readUrl', ({ url, maxChars } = {}) => research.readUrl(url, { maxChars }));
  handle('orvex:research:readFile', async () => {
    const opts = {
      title: 'Read a document',
      properties: ['openFile'],
      buttonLabel: 'Read',
      filters: [
        {
          name: 'Documents',
          extensions: ['pdf', 'docx', 'html', 'htm', 'csv', 'tsv', 'txt', 'md', 'json', 'xml', 'png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tif', 'tiff'],
        },
      ],
    };
    const picked = win && !win.isDestroyed() ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (picked.canceled || !picked.filePaths.length) return { cancelled: true, document: null };
    const filePath = picked.filePaths[0];
    const blocked = guardrails.checkPath(filePath, 'read');
    if (blocked) throw new Error(blocked);
    const document = await research.readFile(filePath);
    return { cancelled: false, document };
  });
  handle('orvex:research:saveDocument', (payload = {}) => research.saveDocument(payload.document || payload));
  handle('orvex:research:export', async ({ id } = {}) => {
    const entry = await research.get(String(id || ''));
    if (!entry) throw new Error('Research report not found.');
    if (!entry.report) throw new Error('This report has no content to export yet.');
    const slug =
      String(entry.title || entry.query || 'research')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'research';
    const opts = {
      title: 'Export research report',
      defaultPath: path.join(app.getPath('documents'), `${slug}.md`),
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    };
    const picked = win && !win.isDestroyed() ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (picked.canceled || !picked.filePath) return { cancelled: true, path: null };
    const stamp = new Date(entry.createdAt || Date.now()).toLocaleString();
    const meta = `\n\n---\n_Generated by ORVEX on ${stamp} — ${entry.sources.length} source${entry.sources.length === 1 ? '' : 's'}, mode ${entry.mode || 'n/a'}._\n`;
    await fsp.writeFile(picked.filePath, `${entry.report}${meta}`, 'utf8');
    return { cancelled: false, path: picked.filePath };
  });
  handle('orvex:research:open', async ({ url } = {}) => {
    const blocked = guardrails.checkUrl(url);
    if (blocked) throw new Error(blocked);
    await shell.openExternal(String(url));
    return { opened: true };
  });

  handle('orvex:memory:get', async () => {
    try {
      const text = await fsp.readFile(MEMORY_FILE, 'utf8');
      return { text, bytes: Buffer.byteLength(text, 'utf8') };
    } catch {
      return { text: '', bytes: 0 };
    }
  });

  handle('orvex:memory:set', async ({ text } = {}) => {
    const body = String(text ?? '');
    if (body.length > 200000) throw new Error('Memory file is too large (200k chars max).');
    await fsp.mkdir(path.dirname(MEMORY_FILE), { recursive: true });
    await fsp.writeFile(MEMORY_FILE, body, 'utf8');
    try {
      memoryStore.importLegacy(MEMORY_FILE);
    } catch {
      /* structured import is best-effort */
    }
    return { bytes: Buffer.byteLength(body, 'utf8') };
  });

  handle('orvex:memory:clear', async () => {
    await fsp.rm(MEMORY_FILE, { force: true });
    return { cleared: true };
  });

  handle('orvex:memory:info', async () => memoryStore.info());
  handle('orvex:memory:stats', async () => memoryStore.stats());
  handle('orvex:memory:list', async (filters = {}) => memoryStore.list(filters || {}));
  handle('orvex:memory:item', async ({ id } = {}) => {
    const item = memoryStore.get(id);
    if (!item) throw new Error('Memory item not found.');
    return item;
  });
  handle('orvex:memory:add', async (payload = {}) => memoryStore.add(payload || {}));
  handle('orvex:memory:update', async ({ id, patch } = {}) => memoryStore.update(id, patch || {}));
  handle('orvex:memory:remove', async ({ id } = {}) => memoryStore.remove(id));
  handle('orvex:memory:search', async ({ query, kind, project, limit } = {}) =>
    memoryStore.search(query, { kind, project, limit }),
  );
  handle('orvex:memory:ask', async ({ question, candidates, project, limit } = {}) =>
    memoryStore.ask({ question, candidates: hydrateProviderPayload({ candidates }).candidates, project, limit }),
  );
  handle('orvex:memory:profile:get', async () => memoryStore.getProfile());
  handle('orvex:memory:profile:save', async (patch = {}) => memoryStore.saveProfile(patch || {}));
  handle('orvex:memory:conflicts', async ({ status, limit } = {}) => memoryStore.conflicts({ status, limit }));
  handle('orvex:memory:resolve', async ({ id, action, mergedText } = {}) =>
    memoryStore.resolveConflict(id, action, { mergedText }),
  );
  handle('orvex:memory:links', async ({ id, limit } = {}) => memoryStore.links(id, limit));
  handle('orvex:memory:graph', async (opts = {}) => memoryStore.graph(opts || {}));
  handle('orvex:memory:context', async (opts = {}) => ({ text: memoryStore.context(opts || {}) }));
  handle('orvex:memory:import', async () => memoryStore.importLegacy(MEMORY_FILE));
  handle('orvex:memory:sweep', async () => memoryStore.sweep());

  handle('orvex:files:info', () => filesStore.info());
  handle('orvex:files:roots', () => filesStore.roots());
  handle('orvex:files:list', (payload = {}) => filesStore.list(payload || {}));
  handle('orvex:files:search', (payload = {}) => filesStore.search(payload || {}));
  handle('orvex:files:stat', (payload = {}) => filesStore.stat(payload || {}));
  handle('orvex:files:read', (payload = {}) => filesStore.read(payload || {}));
  handle('orvex:files:write', (payload = {}) => filesStore.write(payload || {}));
  handle('orvex:files:mkdir', (payload = {}) => filesStore.mkdir(payload || {}));
  handle('orvex:files:rename', (payload = {}) => filesStore.rename(payload || {}));
  handle('orvex:files:copy', (payload = {}) => filesStore.copy(payload || {}));
  handle('orvex:files:remove', (payload = {}) => filesStore.remove(payload || {}));
  handle('orvex:files:duplicates', (payload = {}) => filesStore.duplicates(payload || {}));
  handle('orvex:files:zip', (payload = {}) => filesStore.zip(payload || {}));
  handle('orvex:files:unzip', (payload = {}) => filesStore.unzip(payload || {}));
  handle('orvex:files:zipList', (payload = {}) => filesStore.zipList(payload || {}));
  handle('orvex:files:pdfInfo', (payload = {}) => filesStore.pdfInfo(payload || {}));
  handle('orvex:files:pdfMerge', (payload = {}) => filesStore.pdfMerge(payload || {}));
  handle('orvex:files:pdfSplit', (payload = {}) => filesStore.pdfSplit(payload || {}));
  handle('orvex:files:pdfRotate', (payload = {}) => filesStore.pdfRotate(payload || {}));
  handle('orvex:files:pdfMeta', (payload = {}) => filesStore.pdfMeta(payload || {}));
  handle('orvex:files:pdfCreate', (payload = {}) => filesStore.pdfCreate(payload || {}));
  handle('orvex:files:xlsxInfo', (payload = {}) => filesStore.xlsxInfo(payload || {}));
  handle('orvex:files:xlsxRead', (payload = {}) => filesStore.xlsxRead(payload || {}));
  handle('orvex:files:xlsxToCsv', (payload = {}) => filesStore.xlsxToCsv(payload || {}));
  handle('orvex:files:xlsxWrite', (payload = {}) => filesStore.xlsxWrite(payload || {}));
  handle('orvex:files:docxMake', (payload = {}) => filesStore.docxMake(payload || {}));
  handle('orvex:files:diff', (payload = {}) => filesStore.diff(payload || {}));
  handle('orvex:files:backup', (payload = {}) => filesStore.backup(payload || {}));
  handle('orvex:files:backups', (payload = {}) => filesStore.backups(payload || {}));
  handle('orvex:files:restoreBackup', (payload = {}) => filesStore.restoreBackup(payload || {}));
  handle('orvex:files:removeBackup', (payload = {}) => filesStore.removeBackup(payload || {}));
  handle('orvex:files:versions', (payload = {}) => filesStore.versions(payload || {}));
  handle('orvex:files:restoreVersion', (payload = {}) => filesStore.restoreVersion(payload || {}));
  handle('orvex:files:watchStart', (payload = {}) => filesStore.watchStart(payload || {}));
  handle('orvex:files:watchStop', (payload = {}) => filesStore.watchStop(payload || {}));
  handle('orvex:files:watchStatus', () => filesStore.watchStatus());

  handle('orvex:files:pickFolder', async () => {
    const opts = { title: 'Open a folder', properties: ['openDirectory'], buttonLabel: 'Open folder' };
    const picked = win && !win.isDestroyed() ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (picked.canceled || !picked.filePaths.length) return { cancelled: true, path: null };
    const blocked = guardrails.checkPath(picked.filePaths[0], 'read');
    if (blocked) throw new Error(blocked);
    return { cancelled: false, path: picked.filePaths[0] };
  });

  handle('orvex:files:pickFile', async (payload = {}) => {
    const opts = {
      title: 'Open a file',
      properties: ['openFile'],
      buttonLabel: 'Open',
      filters: dialogFilters(payload.filters),
    };
    const picked = win && !win.isDestroyed() ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (picked.canceled || !picked.filePaths.length) return { cancelled: true, path: null };
    const blocked = guardrails.checkPath(picked.filePaths[0], 'read');
    if (blocked) throw new Error(blocked);
    return { cancelled: false, path: picked.filePaths[0] };
  });

  handle('orvex:files:pickSave', async (payload = {}) => {
    const opts = {
      title: 'Save as',
      buttonLabel: 'Save',
      defaultPath: payload.defaultPath ? String(payload.defaultPath) : undefined,
      filters: dialogFilters(payload.filters),
    };
    const picked = win && !win.isDestroyed() ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (picked.canceled || !picked.filePath) return { cancelled: true, path: null };
    const blocked = guardrails.checkPath(picked.filePath, 'write');
    if (blocked) throw new Error(blocked);
    return { cancelled: false, path: picked.filePath };
  });

  handle('orvex:files:reveal', async ({ path: target } = {}) => {
    const blocked = guardrails.checkPath(target, 'read');
    if (blocked) throw new Error(blocked);
    shell.showItemInFolder(String(target));
    return { revealed: true };
  });

  handle('orvex:files:openPath', async ({ path: target } = {}) => {
    const blocked = guardrails.checkPath(target, 'read');
    if (blocked) throw new Error(blocked);
    const err = await shell.openPath(String(target));
    if (err) throw new Error(err);
    return { opened: true };
  });

  /* ------------------------------------------------------- Section 10 — media */

  const mediaChain = (payload = {}) => configuredChain({ ...payload, task: payload.task || 'media' });

  handle('orvex:media:info', () => creative.info());
  handle('orvex:media:library', (payload = {}) => creative.library(payload || {}));
  handle('orvex:media:get', ({ id } = {}) => creative.getAsset(id));
  handle('orvex:media:delete', ({ id } = {}) => creative.deleteAsset(id));
  handle('orvex:media:rename', (payload = {}) => creative.renameAsset(payload || {}));
  handle('orvex:media:import', (payload = {}) => creative.importAsset(payload || {}));
  handle('orvex:media:importPick', async () => {
    const opts = {
      title: 'Import into the media library',
      properties: ['openFile'],
      buttonLabel: 'Import',
      filters: [
        { name: 'Media', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'svg', 'mp3', 'wav', 'm4a', 'ogg', 'flac', 'mp4', 'mov', 'webm', 'mkv', 'gltf', 'glb', 'obj', 'stl', 'ply', 'fbx', 'srt', 'vtt'] },
        { name: 'All files', extensions: ['*'] },
      ],
    };
    const picked = win && !win.isDestroyed() ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (picked.canceled || !picked.filePaths.length) return { cancelled: true, asset: null };
    const asset = await creative.importAsset({ path: picked.filePaths[0] });
    return { cancelled: false, asset };
  });
  handle('orvex:media:pickFile', async ({ filters } = {}) => {
    const opts = { title: 'Open a media file', properties: ['openFile'], buttonLabel: 'Open', filters: dialogFilters(filters) };
    const picked = win && !win.isDestroyed() ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (picked.canceled || !picked.filePaths.length) return { cancelled: true, path: null };
    const blocked = guardrails.checkPath(picked.filePaths[0], 'read');
    if (blocked) throw new Error(blocked);
    return { cancelled: false, path: picked.filePaths[0] };
  });
  handle('orvex:media:export', async ({ id, destPath } = {}) => {
    if (destPath) return creative.exportTo({ id, destPath });
    const asset = await creative.getAsset(id);
    const opts = { title: 'Export media asset', buttonLabel: 'Export', defaultPath: asset.name };
    const picked = win && !win.isDestroyed() ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (picked.canceled || !picked.filePath) return { cancelled: true, path: null };
    return { cancelled: false, ...(await creative.exportTo({ id, destPath: picked.filePath })) };
  });
  handle('orvex:media:reveal', async ({ id } = {}) => {
    const info = await creative.assetPath({ id });
    shell.showItemInFolder(info.path);
    return { revealed: true, path: info.path };
  });
  handle('orvex:media:open', async ({ id } = {}) => {
    const info = await creative.assetPath({ id });
    const err = await shell.openPath(info.path);
    if (err) throw new Error(err);
    return { opened: true };
  });
  handle('orvex:media:source', (payload = {}) => creative.registerSource(payload || {}));
  handle('orvex:media:generate', (payload = {}) => creative.generateImage(hydrateProviderPayload(payload || {})));
  handle('orvex:media:edit', (payload = {}) => creative.editImage(hydrateProviderPayload(payload || {})));
  handle('orvex:media:removeBackground', (payload = {}) => creative.removeBackground(hydrateProviderPayload(payload || {})));
  handle('orvex:media:upscale', (payload = {}) => creative.upscaleImage(payload || {}));
  handle('orvex:media:analyze', async (payload = {}) => {
    let images = Array.isArray(payload.images) ? payload.images : [];
    if (payload.assetId) images = [await creative.imagePayload({ assetId: payload.assetId })];
    const normalized = images
      .map((img) => {
        if (!img) return null;
        if (img.data) return { mime: img.mime || 'image/png', data: String(img.data) };
        if (img.dataUrl) {
          const match = /^data:([^;,]+);base64,(.*)$/s.exec(String(img.dataUrl));
          return match ? { mime: match[1], data: match[2] } : null;
        }
        return null;
      })
      .filter(Boolean);
    return creative.analyzeImages({
      candidates: mediaChain(payload),
      prompt: payload.prompt,
      system: payload.system,
      images: normalized,
      maxTokens: payload.maxTokens,
      task: payload.task === 'vision' ? 'vision' : 'media',
    });
  });
  handle('orvex:media:transcribe', (payload = {}) => creative.transcribe(withMediaKey(payload, 'stt')));
  handle('orvex:media:subtitles', async (payload = {}) => {
    if (Array.isArray(payload.segments) && payload.segments.length) return creative.subtitleFile(payload || {});
    return creative.subtitlesFromAudio(withMediaKey(payload, 'stt'));
  });
  handle('orvex:media:srt', (payload = {}) => {
    const built = creative.buildSubtitles(payload || {});
    return { ...built, segments: payload.segments || [] };
  });
  handle('orvex:media:tts', (payload = {}) => creative.synthesize(withMediaKey(payload, 'stt')));
  handle('orvex:media:music', (payload = {}) => creative.music(withMediaKey(payload, 'music')));
  handle('orvex:media:heygenVoices', (payload = {}) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    return creative.heygenVoices({ ...p, key: boundSecretOrEmpty('heygen', 'https://api.heygen.com') });
  });
  handle('orvex:media:heygenTts', (payload = {}) => {
    const net = security.networkPolicyBlock('https://api.heygen.com');
    if (net) throw new Error(net);
    const p = payload && typeof payload === 'object' ? payload : {};
    return creative.heygenSpeak({ ...p, key: boundSecretOrEmpty('heygen', 'https://api.heygen.com') });
  });
  handle('orvex:media:heygenTtsStream', async (payload = {}, event) => {
    const sender = event.sender;
    if (![win, mini].some((w) => w && !w.isDestroyed() && w.webContents === sender)) throw new Error('Unknown speech client.');
    const net = security.networkPolicyBlock('https://api.heygen.com');
    if (net) throw new Error(net);
    const id = String(payload.id || '');
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new Error('Invalid speech request id.');
    // One reply is spoken sentence by sentence, so several streams from the
    // same window are live at once. Each id keeps its own controller; the
    // oldest rolls over when a window exceeds the pool.
    const key = speechKey(sender.id, id);
    const previous = speechStreams.get(key);
    if (previous) {
      previous.controller.abort();
      speechStreams.delete(key);
    }
    const live = [];
    for (const [k, entry] of speechStreams) if (entry.senderId === sender.id) live.push(k);
    while (live.length >= SPEECH_STREAMS_PER_WINDOW) {
      const oldest = live.shift();
      speechStreams.get(oldest).controller.abort();
      speechStreams.delete(oldest);
    }
    const controller = new AbortController();
    const entry = { id, senderId: sender.id, controller };
    speechStreams.set(key, entry);
    const abort = () => controller.abort();
    sender.once('destroyed', abort);
    sender.once('render-process-gone', abort);
    sender.once('did-start-navigation', abort);
    try {
      return await creative.heygenSpeakStream({
        text: payload.text, voiceId: payload.voiceId, model: payload.model,
        language: payload.language, speed: payload.speed,
        key: boundSecretOrEmpty('heygen', 'https://api.heygen.com'),
        signal: controller.signal,
        onAudio: (part) => {
          const blocked = security.channelBlocked('orvex:media:heygenTtsStream') || security.networkPolicyBlock('https://api.heygen.com');
          if (blocked) { controller.abort(); throw new Error(blocked); }
          if (!controller.signal.aborted && !sender.isDestroyed()) sender.send('orvex:media:heygenAudio', { id, ...part });
        },
      });
    } finally {
      sender.removeListener('destroyed', abort);
      sender.removeListener('render-process-gone', abort);
      sender.removeListener('did-start-navigation', abort);
      if (speechStreams.get(key) === entry) speechStreams.delete(key);
    }
  });
  ipcMain.handle('orvex:media:stopHeygenTts', (event, { id } = {}) => {
    const entry = speechStreams.get(speechKey(event.sender.id, String(id || '')));
    if (!entry) return ok({ stopped: false });
    entry.controller.abort();
    return ok({ stopped: true });
  });

  /* ElevenLabs speech output: the same stream registry, PCM frames instead of WAV parts. */
  handle('orvex:media:elevenTtsStream', async (payload = {}, event) => {
    const sender = event.sender;
    if (![win, mini].some((w) => w && !w.isDestroyed() && w.webContents === sender)) throw new Error('Unknown speech client.');
    const id = String(payload.id || '');
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new Error('Invalid speech request id.');
    const key = speechKey(sender.id, id);
    const previous = speechStreams.get(key);
    if (previous) {
      previous.controller.abort();
      speechStreams.delete(key);
    }
    const live = [];
    for (const [k, entry] of speechStreams) if (entry.senderId === sender.id) live.push(k);
    while (live.length >= SPEECH_STREAMS_PER_WINDOW) {
      const oldest = live.shift();
      speechStreams.get(oldest).controller.abort();
      speechStreams.delete(oldest);
    }
    const controller = new AbortController();
    const entry = { id, senderId: sender.id, controller };
    speechStreams.set(key, entry);
    const abort = () => controller.abort();
    sender.once('destroyed', abort);
    sender.once('render-process-gone', abort);
    sender.once('did-start-navigation', abort);
    try {
      return await withElevenKey((apiKey) =>
        elevenTts.speakStream({
          text: payload.text,
          voiceId: payload.voiceId,
          model: payload.model,
          speed: payload.speed,
          stability: payload.stability,
          key: apiKey,
          signal: controller.signal,
          onAudio: (part) => {
            const blocked = security.channelBlocked('orvex:media:elevenTtsStream') || security.networkPolicyBlock(elevenTts.ORIGIN);
            if (blocked) {
              controller.abort();
              throw new Error(blocked);
            }
            if (!controller.signal.aborted && !sender.isDestroyed()) sender.send('orvex:media:elevenAudio', { id, ...part });
          },
        }),
      );
    } finally {
      sender.removeListener('destroyed', abort);
      sender.removeListener('render-process-gone', abort);
      sender.removeListener('did-start-navigation', abort);
      if (speechStreams.get(key) === entry) speechStreams.delete(key);
    }
  });
  ipcMain.handle('orvex:media:stopElevenTts', (event, { id } = {}) => {
    const entry = speechStreams.get(speechKey(event.sender.id, String(id || '')));
    if (!entry) return ok({ stopped: false });
    entry.controller.abort();
    return ok({ stopped: true });
  });
  handle('orvex:media:elevenVoices', () => withElevenKey((key) => elevenTts.listVoices({ key })));
  handle('orvex:media:elevenModels', () => withElevenKey((key) => elevenTts.listModels({ key })));

  /* Speech-to-text proxy: audio plus a stored key never meet in the renderer. */
  handle('orvex:stt:transcribe', async ({ url, model, audio, type, timeoutMs, language } = {}) => {
    const target = String(url || '').trim();
    const net = security.networkPolicyBlock(target);
    if (net) throw new Error(net);
    const attempts = await sttKeyAttempts(target);
    if (attempts.length <= 1) {
      return sttProxy.transcribeAudio({ url: target, key: attempts.length ? attempts[0].key : '', audio, type, model, language, timeoutMs });
    }
    let health = sttPoolHealth();
    let lastError = null;
    let moved = false;
    const refused = [];
    for (const attempt of attempts) {
      try {
        const answer = await sttProxy.transcribeAudio({ url: target, key: attempt.key, audio, type, model, language, timeoutMs });
        // the keys that refused this clip stay parked, or the next turn walks
        // through a dead quota all over again
        if (moved) db.setSetting(STT_POOL_HEALTH_SETTING, sttKeys.withSuccess(health, attempt.id));
        return answer;
      } catch (err) {
        const kind = sttKeys.classifyError(err);
        // a bad request or a dead service fails the same way for every key, so
        // only a refusal aimed at this credential moves on to the next one
        if (!sttKeys.shouldRotate(kind)) throw err;
        refused.push(attempt.id);
        lastError = err;
        moved = true;
        health = sttKeys.withFailure(health, attempt.id, kind, Date.now(), err && err.message ? err.message : String(err));
      }
    }
    db.setSetting(STT_POOL_HEALTH_SETTING, health);
    const detail = lastError && lastError.message ? ` Last answer: ${lastError.message}` : '';
    throw new Error(`All ${refused.length} saved transcription keys were refused by this endpoint.${detail}`);
  });
  handle('orvex:stt:setEndpoint', ({ url } = {}) => {
    const value = String(url || '').trim().slice(0, 500);
    if (value) {
      const net = security.networkPolicyBlock(value);
      if (net) throw new Error(net);
    }
    db.setSetting(STT_ENDPOINT_SETTING, value);
    return { local: syncLocalWhisper() };
  });
  handle('orvex:stt:useProviderKey', async ({ url } = {}) => linkSttKeyFromProvider(String(url || '').trim()));

  /* Live speech input: the mic is streamed, the service decides when a turn ends. */
  handle('orvex:stt:realtime:start', async (payload = {}, event) => {
    const sender = event.sender;
    if (![win, mini].some((w) => w && !w.isDestroyed() && w.webContents === sender)) throw new Error('Unknown speech client.');
    const net = security.networkPolicyBlock(elevenTts.ORIGIN);
    if (net) throw new Error(net);
    const old = realtimeSessions.get(sender.id);
    if (old) {
      clearInterval(old.keepAlive);
      old.controller.abort();
      old.session.close();
      realtimeSessions.delete(sender.id);
    }
    const attempts = await elevenKeyAttempts();
    if (!attempts.length) {
      throw new Error('No ElevenLabs key is saved for live speech input. Add one in Settings → Voice.');
    }
    const id = `rt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    let health = sttPoolHealth();
    let lastError = null;
    let moved = false;
    const refused = [];
    for (const attempt of attempts) {
      const controller = new AbortController();
      let session = null;
      try {
        session = elevenRealtime.openSession({
          key: attempt.key,
          origin: elevenTts.ORIGIN,
          model: payload.model,
          language: payload.language,
          commitStrategy: 'vad',
          silenceSecs: payload.silenceSecs,
          signal: controller.signal,
          onEvent: (evt) => {
            if (evt.type === 'error' && elevenRealtime.isKeyRefusal(evt.error)) {
              // A credential that dies mid-conversation is parked like any other
              const next = sttKeys.withFailure(sttPoolHealth(), attempt.id, sttKeys.classifyError({ status: evt.error === 'auth_error' ? 401 : evt.error === 'quota_exceeded' ? 402 : 429 }), Date.now(), evt.message);
              db.setSetting(STT_POOL_HEALTH_SETTING, next);
            }
            const blocked = security.channelBlocked('orvex:stt:realtime:start');
            if (blocked || controller.signal.aborted || sender.isDestroyed()) return;
            sender.send('orvex:stt:realtime-event', { id, ...evt });
          },
        });
        const info = await session.ready;
        if (moved) db.setSetting(STT_POOL_HEALTH_SETTING, sttKeys.withSuccess(health, attempt.id));
        const entry = { id, session, controller, senderId: sender.id, lastAudioAt: Date.now() };
        realtimeSessions.set(sender.id, entry);
        // The service drops a session after ~15 s without audio. An open but quiet
        // microphone is normal between turns, so a 20 ms silence frame keeps the
        // socket alive without pretending anybody spoke.
        entry.keepAlive = setInterval(() => {
          if (!session.open || Date.now() - entry.lastAudioAt < 3000) return;
          try {
            session.send(Buffer.alloc(640));
            entry.lastAudioAt = Date.now();
          } catch {
            /* the close event reports it */
          }
        }, 1000);
        entry.keepAlive.unref?.();
        const drop = () => {
          clearInterval(entry.keepAlive);
          controller.abort();
          session.close();
          if (realtimeSessions.get(sender.id) === entry) realtimeSessions.delete(sender.id);
        };
        sender.once('destroyed', drop);
        sender.once('render-process-gone', drop);
        sender.once('did-start-navigation', drop);
        entry.drop = drop;
        return { id, sampleRate: info.sampleRate, model: info.model, commitStrategy: info.commitStrategy, sessionId: info.sessionId };
      } catch (err) {
        if (session) session.close();
        controller.abort();
        const kind = sttKeys.classifyError(err);
        if (!sttKeys.shouldRotate(kind)) throw err;
        refused.push(attempt.id);
        lastError = err;
        moved = true;
        health = sttKeys.withFailure(health, attempt.id, kind, Date.now(), err && err.message ? err.message : String(err));
      }
    }
    db.setSetting(STT_POOL_HEALTH_SETTING, health);
    const detail = lastError && lastError.message ? ` Last answer: ${lastError.message}` : '';
    throw new Error(`All ${refused.length} saved ElevenLabs keys were refused for live speech input.${detail}`);
  });
  handle('orvex:stt:realtime:audio', ({ id, audio, commit } = {}, event) => {
    const entry = realtimeSessions.get(event.sender.id);
    if (!entry || entry.id !== String(id || '')) throw new Error('No live speech session is open.');
    const blocked = security.channelBlocked('orvex:stt:realtime:audio');
    if (blocked) {
      entry.controller.abort();
      throw new Error(blocked);
    }
    entry.lastAudioAt = Date.now();
    return entry.session.send(Buffer.from(String(audio || ''), 'base64'), commit === true);
  });
  handle('orvex:stt:realtime:commit', ({ id } = {}, event) => {
    const entry = realtimeSessions.get(event.sender.id);
    if (!entry || entry.id !== String(id || '')) throw new Error('No live speech session is open.');
    return entry.session.commit();
  });
  handle('orvex:stt:realtime:stop', ({ id } = {}, event) => {
    const entry = realtimeSessions.get(event.sender.id);
    if (!entry || (id && entry.id !== String(id))) return { stopped: false };
    entry.drop?.();
    entry.controller.abort();
    entry.session.close();
    realtimeSessions.delete(event.sender.id);
    return { stopped: true };
  });

  /* Speech input key pool: presence, labels and status only — values stay here. */
  handle('orvex:stt:keys:list', async ({ url } = {}) => {
    const origin = originOf(String(url || '').trim());
    const tables = poolTables(await vault.getJson(STT_POOL_VAULT_ID));
    const health = sttPoolHealth();
    return {
      limit: sttKeys.MAX_KEYS,
      keys: (tables[origin] || []).map((entry) => sttKeys.describe(entry, health)),
      savedFor: origin,
      others: Object.entries(tables)
        .filter(([where]) => where !== origin)
        .reduce((sum, [, rows]) => sum + rows.length, 0),
      hasSingleKey: !!(await vault.get('stt')),
    };
  });
  handle('orvex:stt:keys:add', async ({ url, key, label } = {}) => {
    const target = String(url || '').trim();
    if (!target) throw new Error('Pick a speech input endpoint first.');
    const blocked = security.networkPolicyBlock(target);
    if (blocked) throw new Error(blocked);
    const origin = originOf(target);
    if (!origin) throw new Error('That endpoint URL is not valid.');
    const value = String(key || '').trim();
    if (!value) throw new Error('Paste the key you want to add.');
    let pool = await readSttPool(origin);
    if (pool.some((entry) => entry.key === value)) return { added: false, count: pool.length, reason: 'That key is already in the list.' };
    if (pool.length >= sttKeys.MAX_KEYS) throw new Error(`ORVEX keeps ${sttKeys.MAX_KEYS} keys per endpoint — remove one first.`);
    pool = sttKeys.normalisePool([...pool, { id: sttKeys.newKeyId(), label: String(label || '').trim(), key: value, addedAt: Date.now() }]);
    await writeSttPool(origin, pool);
    return { added: true, count: pool.length };
  });
  handle('orvex:stt:keys:remove', async ({ id, url } = {}) => {
    const wanted = String(id || '');
    if (wanted === 'stt') throw new Error('Clear the single STT key field to remove that one.');
    const origin = originOf(String(url || '').trim());
    const pool = (await readSttPool(origin)).filter((entry) => entry.id !== wanted);
    await writeSttPool(origin, pool);
    const health = { ...sttPoolHealth() };
    delete health[wanted];
    db.setSetting(STT_POOL_HEALTH_SETTING, health);
    return { count: pool.length };
  });
  handle('orvex:stt:keys:reset', () => {
    db.setSetting(STT_POOL_HEALTH_SETTING, {});
    return { cleared: true };
  });
  handle('orvex:stt:models', async ({ url } = {}) => {
    const target = String(url || '').trim();
    if (!target) throw new Error('Pick a speech input endpoint first.');
    const blocked = security.networkPolicyBlock(target);
    if (blocked) throw new Error(blocked);
    const attempts = await sttKeyAttempts(target);
    return sttProxy.listModels({ url: target, key: attempts.length ? attempts[0].key : '' });
  });
  handle('orvex:media:inspect3d', (payload = {}) => creative.inspect3D(payload || {}));
  handle('orvex:media:saveText', (payload = {}) => creative.saveText(payload || {}));
  handle('orvex:media:saveSubtitle', (payload = {}) => creative.saveSubtitleText(payload || {}));
  handle('orvex:media:saveImage', (payload = {}) => creative.saveImageData(payload || {}));
  handle('orvex:media:prompts', (payload = {}) => creative.prompts(payload || {}));
  handle('orvex:media:prompt:save', (payload = {}) => creative.savePrompt(payload || {}));
  handle('orvex:media:prompt:delete', ({ id } = {}) => creative.deletePrompt({ id }));
  handle('orvex:media:prompt:use', ({ id } = {}) => creative.usePrompt({ id }));

  /* ---------------------------------------------------------- device control */

  const deskSource = (file) => {
    if (!file) return null;
    try {
      return creative.registerSource({ path: file });
    } catch {
      return null;
    }
  };
  const deskPass = async (result) => {
    const value = await result;
    if (!value || value.ok === false) throw new Error((value && value.error) || 'The desktop action failed.');
    return value;
  };

  handle('orvex:desktop:system', () => deskPass(desktop.handlers.system_status({})));
  handle('orvex:desktop:volume', (args = {}) => deskPass(desktop.handlers.system_volume(args || {})));
  handle('orvex:desktop:brightness', (args = {}) => deskPass(desktop.handlers.system_brightness(args || {})));
  handle('orvex:desktop:screenInfo', () => deskPass(desktop.handlers.screen_info({})));
  handle('orvex:desktop:capture', async (args = {}) => {
    const result = await deskPass(await desktop.handlers.screen_capture(args || {}));
    const withUrl = (file, extra) => ({ ...extra, file, url: (deskSource(file) || {}).url || '' });
    return {
      ...result,
      url: (deskSource(result.file) || {}).url || '',
      files: Array.isArray(result.files) ? result.files.map((f) => withUrl(f.file, f)) : [],
      width: result.width || 0,
      height: result.height || 0,
      display: result.display || null,
    };
  });
  handle('orvex:desktop:ocr', async (args = {}) => {
    const result = await deskPass(await desktop.handlers.screen_ocr(args || {}));
    return { ...result, url: result.file ? (deskSource(result.file) || {}).url || '' : '' };
  });
  handle('orvex:desktop:uiTree', (args = {}) => deskPass(desktop.handlers.ui_tree(args || {})));
  handle('orvex:desktop:uiAction', (args = {}) => deskPass(desktop.handlers.ui_action(args || {})));
  handle('orvex:desktop:mouseMove', (args = {}) => deskPass(desktop.handlers.mouse_move(args || {})));
  handle('orvex:desktop:mouseClick', (args = {}) => deskPass(desktop.handlers.mouse_click(args || {})));
  handle('orvex:desktop:mouseScroll', (args = {}) => deskPass(desktop.handlers.mouse_scroll(args || {})));
  handle('orvex:desktop:mouseDrag', (args = {}) => deskPass(desktop.handlers.mouse_drag(args || {})));
  handle('orvex:desktop:mouseDown', (args = {}) => deskPass(desktop.handlers.mouse_down(args || {})));
  handle('orvex:desktop:mouseUp', (args = {}) => deskPass(desktop.handlers.mouse_up(args || {})));
  handle('orvex:desktop:keyType', (args = {}) => deskPass(desktop.handlers.key_type(args || {})));
  handle('orvex:desktop:keyPress', (args = {}) => deskPass(desktop.handlers.key_press(args || {})));
  handle('orvex:desktop:windowList', (args = {}) => deskPass(desktop.handlers.window_list(args || {})));
  handle('orvex:desktop:windowAction', (args = {}) => deskPass(desktop.handlers.window_action(args || {})));
  handle('orvex:desktop:appList', (args = {}) => deskPass(desktop.handlers.app_list(args || {})));
  handle('orvex:desktop:appLaunch', (args = {}) => deskPass(desktop.handlers.app_launch(args || {})));
  handle('orvex:desktop:screenFind', (args = {}) => deskPass(desktop.handlers.screen_find(args || {})));
  handle('orvex:desktop:screenClickText', (args = {}) => deskPass(desktop.handlers.screen_click_text(args || {})));
  handle('orvex:hands:run', async (payload = {}) => {
    if (handsController) throw new Error('A hands task is already running. Stop it first.');
    handsController = new AbortController();
    try {
      return await hands.runTask({ ...(payload || {}), signal: handsController.signal });
    } finally {
      handsController = null;
    }
  });
  handle('orvex:hands:stop', () => {
    const active = !!handsController;
    if (handsController) handsController.abort();
    return { stopped: active };
  });
  handle('orvex:desktop:processList', (args = {}) => deskPass(desktop.handlers.process_list(args || {})));
  handle('orvex:desktop:processKill', (args = {}) => deskPass(desktop.handlers.process_kill(args || {})));
  handle('orvex:desktop:clipboardRead', async () => {
    const result = await deskPass(await desktop.handlers.clipboard_read({}));
    return { ...result, url: result.file ? (deskSource(result.file) || {}).url || '' : '' };
  });
  handle('orvex:desktop:clipboardWrite', (args = {}) => deskPass(desktop.handlers.clipboard_write(args || {})));
  handle('orvex:desktop:recordStart', async (args = {}) => {
    const result = await deskPass(await desktop.handlers.screen_record_start(args || {}));
    return { ...result, url: result.file ? (deskSource(result.file) || {}).url || '' : '' };
  });
  handle('orvex:desktop:recordStop', async () => {
    const result = await deskPass(await desktop.handlers.screen_record_stop({}));
    return { ...result, url: result.file ? (deskSource(result.file) || {}).url || '' : '' };
  });
  handle('orvex:desktop:recordStatus', () => deskPass(desktop.handlers.screen_record_status({})));
  handle('orvex:desktop:metrics', () => desktop.handlers.system_metrics({}));
  handle('orvex:desktop:power', async ({ action } = {}) => {
    const mode = String(action || '').toLowerCase();
    if (mode !== 'lock') throw new Error('Only "lock" is supported from the dashboard.');
    if (process.platform !== 'win32') throw new Error('Locking the workstation is Windows-only right now.');
    await new Promise((resolve, reject) => {
      require('node:child_process').execFile('rundll32.exe', ['user32.dll,LockWorkStation'], { windowsHide: true }, (err) =>
        err ? reject(new Error('Windows refused the lock request.')) : resolve(),
      );
    });
    return { locked: true };
  });

  /* ---------------------------------------------------------------- dashboard */

  let systemCache = { at: 0, value: null };
  let systemProbing = false;
  const systemSnapshot = async () => {
    if (systemCache.value && Date.now() - systemCache.at < 30000) return systemCache.value;
    if (systemProbing) return systemCache.value;
    systemProbing = true;
    try {
      const value = await deskPass(desktop.handlers.system_status({}));
      systemCache = { at: Date.now(), value };
      return value;
    } finally {
      systemProbing = false;
    }
  };
  /**
   * Slow OS probes (battery, volume, brightness) are cached separately; the
   * dashboard must not wait ~9s for them before painting CPU/RAM/disk.
   */
  const fastSystemStatus = () => {
    const cpus = os.cpus();
    const cached = systemCache.value && Date.now() - systemCache.at < 30000 ? systemCache.value : null;
    let user = '';
    try {
      user = os.userInfo().username;
    } catch {
      user = '';
    }
    return {
      hostname: os.hostname(),
      user,
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      cpu: cpus.length ? String(cpus[0].model || '').trim() : '',
      cores: cpus.length,
      uptimeSec: Math.round(os.uptime()),
      battery: cached?.battery ?? null,
      volume: cached?.volume ?? null,
      muted: cached?.muted ?? false,
      brightness: cached?.brightness ?? null,
      displays: cached?.displays ?? 0,
    };
  };

  handle('orvex:dashboard:snapshot', async () => {
    const cachedSystem = systemCache.value && Date.now() - systemCache.at < 30000 ? systemCache.value : null;
    if (!cachedSystem) void systemSnapshot().catch(() => {});
    const [metrics, system] = await Promise.all([desktop.handlers.system_metrics({}), Promise.resolve(cachedSystem || fastSystemStatus())]);
    const wf = workflows.list();
    const usage = db.usageSummary({ sinceMs: Math.max(60_000, Date.now() - STARTED_AT) }) || null;

    let memory = null;
    try {
      const s = memoryStore.stats();
      memory = { total: s.total, active: s.active, pinned: s.pinned, conflicts: s.conflicts };
    } catch {
      memory = null;
    }
    let media = null;
    try {
      const i = creative.info();
      media = { assets: i.assets, prompts: i.prompts, ready: i.ready };
    } catch {
      media = null;
    }
    let researchCount = null;
    try {
      researchCount = (await research.list()).length;
    } catch {
      researchCount = null;
    }
    let connections = null;
    try {
      connections = integrations.health().connections.length;
    } catch {
      connections = null;
    }

    return {
      at: Date.now(),
      startedAt: STARTED_AT,
      metrics,
      system: {
        hostname: system.hostname,
        user: system.user,
        platform: system.platform,
        arch: system.arch,
        release: system.release,
        cpu: system.cpu,
        cores: system.cores,
        uptimeSec: system.uptimeSec,
        battery: system.battery || null,
        volume: system.volume,
        muted: system.muted,
        brightness: system.brightness,
        displays: system.displays,
      },
      agent: {
        running: !!activeRun,
        paused: !!(activeRun && activeRun.paused),
        runId: activeRun ? activeRun.runId : null,
        goal: activeRun ? activeRun.goal || null : null,
        agentId: activeRun ? activeRun.agentId || null : null,
        mode: activeRun ? activeRun.mode || 'agent' : null,
      },
      workflows: { stats: wf.stats, runs: wf.runs.slice(0, 10), concurrency: wf.concurrency },
      runs: db.runsRecent(8),
      activity: db.auditTail(15),
      usage,
      security: (() => {
        const s = security.status();
        return { role: s.role, roleLabel: s.roleLabel, hasPin: s.hasPin, locked: s.locked, stopped: s.emergency.stopped, stopReason: s.emergency.reason };
      })(),
      counts: {
        memory,
        media,
        research: researchCount,
        connections,
      },
    };
  });
  handle('orvex:desktop:source', (args = {}) => creative.registerSource(args || {}));
  handle('orvex:desktop:export', async ({ path: filePath, name } = {}) => {
    if (!filePath) throw new Error('Nothing to export.');
    if (!fs.existsSync(filePath)) throw new Error('That file no longer exists.');
    const picked = await dialog.showSaveDialog(win, {
      defaultPath: path.join(app.getPath('downloads'), name || path.basename(filePath)),
    });
    if (picked.canceled || !picked.filePath) return { cancelled: true, path: null };
    await fsp.copyFile(filePath, picked.filePath);
    return { cancelled: false, path: picked.filePath };
  });
  handle('orvex:desktop:reveal', ({ path: filePath } = {}) => {
    if (!filePath || !fs.existsSync(filePath)) throw new Error('That file no longer exists.');
    shell.showItemInFolder(filePath);
    return { revealed: true, path: filePath };
  });

  /* --------------------------- integrations, OAuth, permissions, MCP server */

  handle('orvex:integrations:list', () => integrations.listConnections());
  handle('orvex:integrations:save', (payload = {}) => integrations.saveConnection(payload));
  handle('orvex:integrations:delete', ({ id } = {}) => integrations.deleteConnection(id));
  handle('orvex:integrations:test', ({ id } = {}) => integrations.testConnection(id));
  handle('orvex:integrations:run', (payload = {}) => integrations.runConnectionAction(payload));
  handle('orvex:integrations:health', () => integrations.health());
  handle('orvex:integrations:http', (payload = {}) => integrations.httpRequest(payload));
  handle('orvex:integrations:ws', (payload = {}) => integrations.wsRequest(payload));
  handle('orvex:integrations:webhook', async ({ op = 'status', limit, port, autostart } = {}) => {
    if (op === 'status') return integrations.webhookStatus();
    if (op === 'start') return integrations.startWebhook({ port, autostart });
    if (op === 'stop') return integrations.stopWebhook();
    if (op === 'events') return integrations.webhookEvents(limit);
    if (op === 'clear') return integrations.clearWebhookEvents();
    if (op === 'test') return integrations.webhookTest();
    throw new Error('op must be status, start, stop, events, clear or test.');
  });

  handle('orvex:oauth:state', () => oauth.accountsState());
  handle('orvex:oauth:device', (payload = {}) => oauth.startDeviceFlow(payload));
  handle('orvex:oauth:pkce', (payload = {}) => oauth.startPkceFlow(payload));
  handle('orvex:oauth:flow', ({ id } = {}) => oauth.flowState(id));
  handle('orvex:oauth:cancel', ({ id } = {}) => oauth.cancelFlow(id));
  handle('orvex:oauth:remove', ({ id } = {}) => oauth.removeAccount(id));
  handle('orvex:oauth:tokenState', ({ id } = {}) => oauth.accountTokenState(id));
  handle('orvex:oauth:check', ({ id } = {}) => oauth.checkAccount(id));

  handle('orvex:permissions:state', () => permissions.state());
  handle('orvex:permissions:set', (payload = {}) => {
    const state = security.status();
    if (state.role !== 'owner') throw new Error(`Only the Owner role can change tool permissions (current role: ${state.roleLabel}).`);
    return permissions.setPolicy(payload);
  });
  handle('orvex:permissions:reset', ({ tool } = {}) => {
    const state = security.status();
    if (state.role !== 'owner') throw new Error(`Only the Owner role can change tool permissions (current role: ${state.roleLabel}).`);
    return permissions.reset(tool);
  });
  handle('orvex:permissions:addFloor', (payload = {}) => {
    const state = security.status();
    if (state.role !== 'owner') throw new Error(`Only the Owner role can change approval floors (current role: ${state.roleLabel}).`);
    const next = permissions.addFloor(payload);
    tools.audit({ kind: 'approval-floor-added', tool: String(payload.tool || '*'), ok: true, args: JSON.stringify({ pattern: String(payload.pattern || ''), note: String(payload.note || '') }) });
    return next;
  });
  handle('orvex:permissions:removeFloor', ({ id } = {}) => {
    const state = security.status();
    if (state.role !== 'owner') throw new Error(`Only the Owner role can change approval floors (current role: ${state.roleLabel}).`);
    const next = permissions.removeFloor(id);
    tools.audit({ kind: 'approval-floor-removed', ok: true, args: JSON.stringify({ id: String(id || '') }) });
    return next;
  });

  handle('orvex:approval-advisor:state', () => approvalAdvisor.state());
  handle('orvex:approval-advisor:add', (payload = {}) => {
    const state = security.status();
    if (state.role !== 'owner') throw new Error(`Only the Owner role can add escalation rules (current role: ${state.roleLabel}).`);
    const next = approvalAdvisor.add(payload);
    tools.audit({ kind: 'escalation-rule-added', tool: String(payload.tool || ''), ok: true, args: JSON.stringify({ pattern: String(payload.pattern || ''), reason: String(payload.reason || '') }) });
    return next;
  });
  handle('orvex:approval-advisor:accept', ({ id } = {}) => {
    const state = security.status();
    if (state.role !== 'owner') throw new Error(`Only the Owner role can accept escalation rules (current role: ${state.roleLabel}).`);
    const next = approvalAdvisor.accept(id);
    tools.audit({ kind: 'escalation-rule-accepted', ok: true, args: JSON.stringify({ id: String(id || '') }) });
    return next;
  });
  handle('orvex:approval-advisor:remove', ({ id } = {}) => {
    const state = security.status();
    if (state.role !== 'owner') throw new Error(`Only the Owner role can remove escalation rules (current role: ${state.roleLabel}).`);
    const next = approvalAdvisor.remove(id);
    tools.audit({ kind: 'escalation-rule-removed', ok: true, args: JSON.stringify({ id: String(id || '') }) });
    return next;
  });
  handle('orvex:approval-advisor:learn', () => {
    const state = security.status();
    if (state.role !== 'owner') throw new Error(`Only the Owner role can scan for escalation rules (current role: ${state.roleLabel}).`);
    return approvalAdvisor.learn();
  });

  handle('orvex:connectors:list', () => connectors.listConnectors());
  handle('orvex:connectors:preview', (payload = {}) => {
    requireOwner();
    return connectors.previewSpec(payload || {});
  });
  handle('orvex:connectors:save', (payload = {}) => {
    requireOwner();
    return connectors.saveConnector(payload || {});
  });
  handle('orvex:connectors:delete', ({ id } = {}) => {
    requireOwner();
    return connectors.deleteConnector(id);
  });
  handle('orvex:connectors:test', ({ id } = {}) => connectors.testConnector(id));
  handle('orvex:connectors:call', (payload = {}) => connectors.callConnector(payload || {}));

  handle('orvex:maker:list', () => maker.list());
  handle('orvex:maker:templates', () => maker.templates());
  handle('orvex:maker:create', (payload = {}) => {
    requireOwner();
    return maker.create(payload || {});
  });
  handle('orvex:maker:files', (payload = {}) => maker.files(payload.projectId, payload.path || ''));
  handle('orvex:maker:read', (payload = {}) => maker.readFile(payload.projectId, payload.path));
  handle('orvex:maker:write', (payload = {}) => {
    requireOwner();
    return maker.writeFile(payload.projectId, payload.path, payload.content);
  });
  handle('orvex:maker:preview', ({ projectId } = {}) => maker.preview(projectId));
  handle('orvex:maker:stopPreview', ({ projectId } = {}) => maker.stopPreview(projectId));
  handle('orvex:maker:export', ({ projectId, destDir } = {}) => maker.exportZip(projectId, destDir));
  handle('orvex:maker:run', ({ projectId, args } = {}) => maker.run(projectId, args || []));
  handle('orvex:maker:remove', ({ projectId } = {}) => {
    requireOwner();
    return maker.remove(projectId);
  });
  handle('orvex:maker:open', async ({ projectId } = {}) => {
    const row = maker.list().projects.find((p) => p.id === String(projectId));
    if (!row) throw new Error('Unknown Maker project.');
    const failed = await shell.openPath(row.dir);
    if (failed) throw new Error(failed);
    return { opened: true, dir: row.dir };
  });
  handle('orvex:maker:reveal', ({ projectId } = {}) => {
    const row = maker.list().projects.find((p) => p.id === String(projectId));
    if (!row) throw new Error('Unknown Maker project.');
    shell.showItemInFolder(row.dir);
    return { revealed: true, dir: row.dir };
  });

  /* ----------------------------------------------------------------- security */

  const atRestLabel = process.platform === 'win32' ? 'Windows DPAPI (Electron safeStorage)' : 'OS keychain (Electron safeStorage)';
  const secretsSummary = async () => {
    const info = await vault.list();
    return { ...info, encryption: vault.available() ? atRestLabel : 'unavailable', storeFile: SECRETS_FILE ? path.basename(SECRETS_FILE) : null };
  };
  const requireOwner = () => {
    const state = security.status();
    if (state.role !== 'owner') throw new Error(`Only the Owner role can change security settings (current role: ${state.roleLabel}).`);
    return state;
  };

  handle('orvex:security:status', async () => {
    const info = await vault.list();
    return {
      ...security.status(),
      atRest: { available: vault.available(), label: atRestLabel, storeFile: SECRETS_FILE ? path.basename(SECRETS_FILE) : null, exists: info.exists },
      permissionCounts: permissions.state().counts,
      secretCount: info.count,
    };
  });
  handle('orvex:security:setPin', (payload = {}) => {
    requireOwner();
    return security.setPin(payload);
  });
  handle('orvex:security:removePin', (payload = {}) => {
    requireOwner();
    return security.removePin(payload);
  });
  handle('orvex:security:unlock', ({ pin } = {}) => security.unlock(pin));
  handle('orvex:security:lock', () => security.lock('Locked by you'));
  handle('orvex:security:touch', () => {
    security.touch();
    return { at: Date.now() };
  });
  handle('orvex:security:role', ({ role, pin } = {}) => {
    const next = String(role || '').toLowerCase();
    const rank = { viewer: 0, operator: 1, owner: 2 };
    const state = security.status();
    if (next === state.role) return state;
    if (rank[next] > rank[state.role]) {
      // Promotion is proven with the PIN when one exists. Without a PIN there is
      // nothing to verify, and demanding one would trap a downgraded machine
      // because setting a PIN is itself owner-only.
      if (security.hasPin()) security.verifyPinAttempt(pin);
    } else {
      requireOwner();
    }
    return security.setRole(role);
  });
  handle('orvex:security:settings', (payload = {}) => {
    requireOwner();
    return security.setSettings(payload);
  });
  handle('orvex:security:emergencyStop', ({ reason } = {}) => {
    requireOwner();
    return security.emergencyStop(reason || 'Emergency stop pressed');
  });
  handle('orvex:security:emergencyClear', () => {
    requireOwner();
    const result = security.clearEmergency();
    try {
      advanced.startRules();
    } catch {
      /* the rule engine can be restarted from Advanced later */
    }
    return result;
  });
  handle('orvex:security:scan', ({ text } = {}) => security.scanInjection(String(text || '').slice(0, 20000)));
  handle('orvex:security:audit', ({ limit, kind, tool, ok, query } = {}) => {
    const n = Math.min(Math.max(Number(limit) || 200, 1), 1000);
    let rows = db.auditTail(n);
    if (kind) rows = rows.filter((row) => String(row.kind) === String(kind));
    if (tool) rows = rows.filter((row) => String(row.tool || '').toLowerCase().includes(String(tool).toLowerCase()));
    if (ok === true || ok === false) rows = rows.filter((row) => (row.ok === 1) === ok);
    if (query) {
      const needle = String(query).toLowerCase();
      rows = rows.filter((row) => JSON.stringify(row).toLowerCase().includes(needle));
    }
    return rows.map((row) => ({
      ts: new Date(Number(row.ts) || Date.now()).toISOString(),
      kind: row.kind,
      ...(row.tool ? { tool: row.tool } : {}),
      ...(row.args ? { args: security.redact(String(row.args).slice(0, 600)) } : {}),
      ...(row.ok === null || row.ok === undefined ? {} : { ok: !!row.ok }),
      ...(row.ms === null || row.ms === undefined ? {} : { ms: row.ms }),
      ...(row.error ? { error: security.redact(String(row.error).slice(0, 600)) } : {}),
      ...(row.runId ? { runId: row.runId } : {}),
    }));
  });
  handle('orvex:security:secrets', () => secretsSummary());
  handle('orvex:security:secretSet', async ({ id, value } = {}) => {
    requireOwner();
    const key = String(id || '').trim();
    if (!/^[a-zA-Z0-9._:-]{1,120}$/.test(key)) throw new Error('Secret ids use letters, numbers, dot, dash, underscore or colon.');
    if (typeof value !== 'string' || value.length < 4) throw new Error('Enter a secret value of at least 4 characters.');
    await vault.set(key, value);
    security.setSecretValues(Object.values(await vault.load()));
    tools.audit({ kind: 'secret-set', ok: true, args: JSON.stringify({ id: key }) });
    return secretsSummary();
  });
  handle('orvex:security:secretDelete', async ({ id } = {}) => {
    requireOwner();
    const key = String(id || '').trim();
    if (!key) throw new Error('Pick a secret to delete.');
    await vault.remove(key);
    security.setSecretValues(Object.values(await vault.load()));
    tools.audit({ kind: 'secret-delete', ok: true, args: JSON.stringify({ id: key }) });
    return secretsSummary();
  });
  handle('orvex:security:backups', () => security.listBackups());
  handle('orvex:security:backup', (payload = {}) => {
    requireOwner();
    return security.createBackup(payload);
  });
  handle('orvex:security:restore', (payload = {}) => {
    requireOwner();
    return security.restoreBackup(payload.id, payload.passphrase);
  });
  handle('orvex:security:deleteBackup', ({ id } = {}) => {
    requireOwner();
    return security.deleteBackup(id);
  });
  handle('orvex:security:privacy', async (payload = {}) => {
    requireOwner();
    return privacyClear(payload);
  });

  /* ------------------------------------------------------ Phase 6 — training */

  handle('orvex:training:status', () => training.status());
  handle('orvex:training:usage', () => training.usage());
  handle('orvex:training:setRoot', ({ dir } = {}) => {
    requireOwner();
    return training.setRoot(dir);
  });
  handle('orvex:training:pickRoot', async () => {
    requireOwner();
    const opts = {
      title: 'Choose the training vault folder',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Use this folder',
    };
    const picked = win && !win.isDestroyed() ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (picked.canceled || !picked.filePaths.length) return { cancelled: true, status: await training.status() };
    return { cancelled: false, status: await training.setRoot(picked.filePaths[0]) };
  });
  handle('orvex:training:setQuota', ({ bytes } = {}) => {
    requireOwner();
    return training.setQuota(bytes);
  });
  handle('orvex:training:openRoot', async () => {
    const target = training.root();
    const error = await shell.openPath(target);
    if (error) throw new Error(error);
    return { opened: true, root: target };
  });
  handle('orvex:training:episodes', (payload = {}) => training.listEpisodes(payload || {}));
  handle('orvex:training:episode', ({ id } = {}) => training.getEpisode(id));
  handle('orvex:training:deleteEpisode', ({ id } = {}) => {
    requireOwner();
    return training.deleteEpisode(id);
  });
  handle('orvex:training:clearEpisodes', () => {
    requireOwner();
    return training.clearEpisodes();
  });
  handle('orvex:training:stats', () => training.episodeStats());
  handle('orvex:training:scoreCurve', (payload = {}) => training.scoreCurve(payload || {}));
  handle('orvex:training:evalPacks', ({ limit } = {}) => ({ packs: training.listEvalPacks(limit) }));
  handle('orvex:training:buildEvalPack', (payload = {}) => {
    requireOwner();
    return training.buildEvalPack(payload || {});
  });

  handle('orvex:learner:status', () => learner.status());
  handle('orvex:learner:suggestions', () => ({ suggestions: learner.suggestions() }));
  handle('orvex:learner:skills', (payload = {}) => ({ skills: learner.listSkills(payload || {}) }));
  handle('orvex:learner:skillPrompt', ({ id } = {}) => ({ prompt: learner.skillPrompt(id) }));
  handle('orvex:learner:trainKits', ({ limit } = {}) => ({ kits: learner.listTrainKits(limit) }));
  handle('orvex:learner:models', () => ({ models: learner.modelsIndex() }));
  handle('orvex:learner:finetunes', ({ limit } = {}) => ({ runs: learner.finetuneRuns(limit) }));
  handle('orvex:learner:nanos', () => ({ models: learner.nanoModels(), active: learner.activeNano() }));
  handle('orvex:learner:predict', (payload = {}) => learner.predictNano(payload || {}));
  handle('orvex:learner:trainNano', (payload = {}) => {
    requireOwner();
    return learner.trainNano(payload || {});
  });
  handle('orvex:learner:rollbackNano', () => {
    requireOwner();
    return learner.rollbackNano();
  });
  handle('orvex:learner:compileSkill', (payload = {}) => {
    requireOwner();
    return learner.compileSkill(payload || {});
  });
  handle('orvex:learner:setSkillStatus', (payload = {}) => {
    requireOwner();
    return learner.setSkillStatus(payload || {});
  });
  handle('orvex:learner:deleteSkill', ({ id } = {}) => {
    requireOwner();
    return learner.deleteSkill({ id });
  });
  handle('orvex:learner:saveSkill', (payload = {}) => {
    requireOwner();
    return learner.saveSkill(payload || {});
  });
  handle('orvex:learner:exportSkill', ({ id } = {}) => ({ bundle: learner.exportSkill({ id }) }));
  handle('orvex:learner:exportSkills', () => learner.exportSkills());
  handle('orvex:learner:importSkill', (payload = {}) => {
    requireOwner();
    return learner.importSkill(payload || {});
  });
  handle('orvex:learner:buildTrainKit', (payload = {}) => {
    requireOwner();
    return learner.buildTrainKit(payload || {});
  });
  handle('orvex:learner:pickGguf', async () => {
    requireOwner();
    const opts = {
      title: 'Import a GGUF model',
      properties: ['openFile'],
      filters: [{ name: 'GGUF models', extensions: ['gguf'] }],
    };
    const picked = win && !win.isDestroyed() ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return { cancelled: !!picked.canceled, file: picked.canceled ? null : picked.filePaths[0] || null };
  });
  handle('orvex:learner:importGguf', (payload = {}) => {
    requireOwner();
    return learner.importGguf(payload || {});
  });
  handle('orvex:learner:deleteModel', ({ id } = {}) => {
    requireOwner();
    return learner.deleteModel({ id });
  });
  handle('orvex:learner:finetune', (payload = {}) => {
    requireOwner();
    return learner.finetune(payload || {});
  });
  handle('orvex:learner:finetuneStatus', ({ id } = {}) => {
    requireOwner();
    return learner.finetuneStatus({ id });
  });
  handle('orvex:learner:finetuneCancel', ({ id } = {}) => {
    requireOwner();
    return learner.finetuneCancel({ id });
  });
  handle('orvex:learner:cycle', () => {
    requireOwner();
    return learner.runCycle();
  });

  handle('orvex:workforce:status', () => workforce.status());
  handle('orvex:workforce:agents', (payload = {}) => ({ agents: workforce.listAgents(payload || {}) }));
  handle('orvex:workforce:agent', ({ id } = {}) => workforce.getAgent(id));
  handle('orvex:workforce:createAgent', (payload = {}) => {
    requireOwner();
    return workforce.createAgent(payload || {});
  });
  handle('orvex:workforce:updateAgent', (payload = {}) => {
    requireOwner();
    return workforce.updateAgent(payload || {});
  });
  handle('orvex:workforce:deleteAgent', ({ id } = {}) => {
    requireOwner();
    return workforce.deleteAgent(id);
  });
  handle('orvex:workforce:pauseAgent', ({ id } = {}) => {
    requireOwner();
    return workforce.pauseAgent(id);
  });
  handle('orvex:workforce:resumeAgent', ({ id } = {}) => {
    requireOwner();
    return workforce.resumeAgent(id);
  });
  handle('orvex:workforce:startShift', (payload = {}) => {
    requireOwner();
    return workforce.startShift(payload.id, payload || {});
  });
  handle('orvex:workforce:shifts', (payload = {}) => ({ shifts: workforce.listShifts(payload || {}) }));
  handle('orvex:workforce:shift', ({ id } = {}) => workforce.getShift(id));
  handle('orvex:workforce:inbox', (payload = {}) => ({ messages: workforce.listInbox(payload || {}) }));
  handle('orvex:workforce:readInbox', (payload = {}) => {
    requireOwner();
    return workforce.readInbox(payload || {});
  });
  handle('orvex:workforce:clearInbox', () => {
    requireOwner();
    return workforce.clearInbox();
  });
  handle('orvex:workforce:tick', () => {
    requireOwner();
    return workforce.tick();
  });

  handle('orvex:localbrain:status', () => localBrain.status());
  handle('orvex:localbrain:models', (payload = {}) => localBrain.scanModels(payload || {}));
  handle('orvex:localbrain:modelsRefresh', ({ hash } = {}) => localBrain.scanModels({ hash: hash === true }));
  handle('orvex:localbrain:config', (payload = {}) => (payload && Object.keys(payload).length ? localBrain.setConfig(payload) : localBrain.getConfig()));
  handle('orvex:localbrain:runtime', () => localBrain.findRuntime());
  handle('orvex:localbrain:start', ({ id } = {}) => localBrain.start(id));
  handle('orvex:localbrain:stop', () => localBrain.stop('user'));
  handle('orvex:localbrain:chat', (payload = {}) => localBrain.chat(payload || {}));
  handle('orvex:localbrain:route', (payload = {}) => localBrain.route(payload || {}));
  handle('orvex:localbrain:grammar', () => ({ grammar: localBrain.toolGrammar() }));
  handle('orvex:localbrain:hash', ({ id } = {}) => {
    requireOwner();
    return localBrain.hashModel(id);
  });

  handle('orvex:mcp-server:status', () => mcpServer.status());
  handle('orvex:mcp-server:start', (payload = {}) => mcpServer.start(payload));
  handle('orvex:mcp-server:stop', () => mcpServer.stop());
  handle('orvex:mcp-server:config', ({ allowRisky } = {}) => mcpServer.setAllowRisky(allowRisky));

  /* ---------------------------------------------------------------- workflows */

  handle('orvex:workflows:list', () => workflows.list());
  handle('orvex:workflows:save', (payload = {}) => workflows.save(payload));
  handle('orvex:workflows:delete', ({ id } = {}) => workflows.remove(id));
  handle('orvex:workflows:enabled', ({ id, enabled } = {}) => workflows.setEnabled(id, enabled));
  handle('orvex:workflows:run', ({ id, input } = {}) => workflows.runNow(id, input));
  handle('orvex:workflows:runs', ({ workflowId, limit } = {}) => ({ runs: workflows.runsFor(workflowId, limit) }));
  handle('orvex:workflows:clearRuns', ({ workflowId } = {}) => workflows.clearRuns(workflowId));
  handle('orvex:workflows:detail', ({ id } = {}) => workflows.runDetail(id));
  handle('orvex:workflows:approve', ({ runId, allow } = {}) => workflows.approve(runId, allow));
  handle('orvex:workflows:cancel', ({ runId } = {}) => workflows.cancel(runId));
  handle('orvex:workflows:resume', ({ runId } = {}) => workflows.resume(runId));
  handle('orvex:workflows:templates', () => ({ templates: workflows.templateDefs() }));
  handle('orvex:workflows:fromTemplate', ({ templateId } = {}) => workflows.createFromTemplate(templateId));
  handle('orvex:workflows:tools', () => ({
    tools: tools.definitions.map((d) => ({ name: d.name, description: d.description, parameters: d.parameters })),
  }));
  handle('orvex:workflows:cron', ({ expression, from } = {}) => {
    const nextAt = workflows.cronNext(expression, from);
    return { expression, nextAt, next: new Date(nextAt).toISOString() };
  });

  /* --------------------------------------------------- Section 19 — advanced */

  handle('orvex:advanced:status', () => advanced.status());
  handle('orvex:advanced:mode', ({ mode } = {}) => (mode ? advanced.setMode(mode) : advanced.modeStatus()));
  handle('orvex:advanced:context', () => advanced.contextSnapshot());
  handle('orvex:advanced:suggest', (payload = {}) =>
    advanced.suggestContext({ candidates: configuredChain({ ...(payload || {}), task: 'chat' }) }),
  );
  handle('orvex:advanced:approve', ({ id, allow } = {}) => {
    const entry = pendingAdvancedApprovals.get(String(id || ''));
    if (!entry) return { resolved: false };
    entry.done(allow === true);
    return { resolved: true };
  });

  handle('orvex:advanced:rules', () => ({ rules: advanced.listRules(), events: advanced.ruleEvents(40) }));
  handle('orvex:advanced:ruleSave', (payload = {}) => advanced.saveRule(payload || {}));
  handle('orvex:advanced:ruleDelete', ({ id } = {}) => advanced.deleteRule(id));
  handle('orvex:advanced:ruleEnable', ({ id, enabled } = {}) => advanced.setRuleEnabled(id, enabled));
  handle('orvex:advanced:rulesTick', () => advanced.tick());

  handle('orvex:advanced:eval', (payload = {}) =>
    advanced.selfEval({
      goal: payload.goal,
      output: payload.output,
      criteria: payload.criteria,
      candidates: configuredChain({ ...(payload || {}), task: 'chat' }),
    }),
  );
  handle('orvex:advanced:evalHistory', ({ limit } = {}) => advanced.selfEvalHistory(limit));

  handle('orvex:advanced:routeStats', ({ task, days } = {}) => advanced.routeStats(task || 'agent', days));
  handle('orvex:advanced:routeRecommend', (payload = {}) =>
    advanced.recommendRoute({
      task: String((payload && payload.task) || 'agent'),
      candidates: configuredChain({ ...(payload || {}), task: String((payload && payload.task) || 'agent') }),
    }),
  );
  handle('orvex:advanced:routeApply', ({ task, chain } = {}) => advanced.applyRoute({ task, chain }));

  handle('orvex:advanced:learning', ({ status } = {}) => advanced.listLearning(status));
  handle('orvex:advanced:learningMine', ({ days } = {}) => advanced.mineLearning({ days }));
  handle('orvex:advanced:learningApprove', ({ id } = {}) => advanced.approveLearning(id));
  handle('orvex:advanced:learningDismiss', ({ id } = {}) => advanced.dismissLearning(id));

  handle('orvex:advanced:jobs', ({ limit } = {}) => advanced.listJobs(limit));
  handle('orvex:advanced:job', ({ id } = {}) => advanced.getJob(id));
  handle('orvex:advanced:jobCreate', (payload = {}) => advanced.createJob(payload || {}));
  handle('orvex:advanced:jobStart', ({ id } = {}) => advanced.startJob(id, { wait: false }));
  handle('orvex:advanced:jobPause', ({ id } = {}) => advanced.pauseJob(id));
  handle('orvex:advanced:jobResume', ({ id } = {}) => advanced.resumeJob(id, { wait: false }));
  handle('orvex:advanced:jobCancel', ({ id } = {}) => advanced.cancelJob(id));
  handle('orvex:advanced:jobDelete', ({ id } = {}) => advanced.deleteJob(id));

  handle('orvex:advanced:recovery', () => advanced.recoveryOverview());
  handle('orvex:advanced:recoveryResume', (payload = {}) => advanced.resumeRecovery(payload || {}));
  handle('orvex:advanced:recoveryDiscard', ({ kind, id } = {}) => advanced.discardRecovery({ kind, id }));

  /* multi-agent collaboration */
  handle('orvex:collab:agents', () => ({
    agents: collab.listAgents(),
    caps: { maxAgents: 5, maxRounds: 3 },
  }));
  handle('orvex:collab:agentSave', (payload = {}) => collab.saveAgent(payload || {}));
  handle('orvex:collab:agentDelete', ({ id } = {}) => collab.deleteAgent(id));
  handle('orvex:collab:sessions', ({ limit } = {}) => collab.listSessions(limit));
  handle('orvex:collab:session', ({ id } = {}) => collab.getSession(id));
  handle('orvex:collab:start', (payload = {}) =>
    collab.startSession({ ...(payload || {}), candidates: configuredChain({ ...(payload || {}), task: 'agent' }) }, { wait: false }),
  );
  handle('orvex:collab:stop', ({ id } = {}) => collab.stopSession(id));
  handle('orvex:collab:sessionDelete', ({ id } = {}) => collab.deleteSession(id));

  /* computer-vision agent */
  handle('orvex:vision:capture', async (args = {}) => {
    const result = await vision.captureScreen(args || {});
    const file = result.file || result.image || '';
    return { ...result, file, url: result.url || sourceUrlFor(file) };
  });
  handle('orvex:vision:ocr', (args = {}) => vision.readScreenText(args || {}));
  handle('orvex:vision:analyze', (payload = {}) =>
    vision.analyze({ ...(payload || {}), candidates: configuredChain({ ...(payload || {}), task: 'vision' }) }),
  );

  /* plugin SDK + marketplace */
  handle('orvex:plugins:list', () => ({ plugins: plugins.listPlugins(), catalogUrl: plugins.catalogUrl() }));
  handle('orvex:plugins:installDir', async ({ dir } = {}) => {
    let source = String(dir || '').trim();
    if (!source) {
      const opts = { title: 'Choose a plugin folder', properties: ['openDirectory'], buttonLabel: 'Install' };
      const picked = win && !win.isDestroyed() ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
      if (picked.canceled || !picked.filePaths.length) return { cancelled: true, plugin: null };
      source = picked.filePaths[0];
    }
    const blocked = guardrails.checkPath(source, 'read');
    if (blocked) throw new Error(blocked);
    return { cancelled: false, plugin: await plugins.installFromDir(source) };
  });
  handle('orvex:plugins:installCatalog', ({ id } = {}) => plugins.installFromCatalog(id));
  handle('orvex:plugins:catalog', ({ refresh } = {}) => plugins.catalog({ refresh: refresh === true }));
  handle('orvex:plugins:catalogSet', ({ url } = {}) => plugins.setCatalogUrl(url));
  handle('orvex:plugins:catalogKeys', () => ({
    keys: plugins.catalogKeys().map((key) => ({ keyId: key.keyId, fingerprint: key.fingerprint })),
    requireSignature: plugins.requireSignature(),
  }));
  handle('orvex:plugins:catalogKeysSet', ({ text } = {}) => plugins.setCatalogKeys(text));
  handle('orvex:plugins:catalogRequire', ({ value } = {}) => plugins.setRequireSignature(value === true));
  handle('orvex:plugins:enable', ({ id, enabled } = {}) => plugins.setEnabled(id, enabled));
  handle('orvex:plugins:uninstall', ({ id } = {}) => plugins.uninstall(id));

  /* multi-device pairing and sync */
  handle('orvex:devices:info', () => ({
    device: devices.localInfo(),
    host: devices.hostStatus(),
    devices: devices.listDevices(),
    log: devices.syncLog(30),
  }));
  handle('orvex:devices:name', ({ name } = {}) => ({ name: devices.setName(name) }));
  handle('orvex:devices:hostStart', ({ port } = {}) => devices.startHost({ port }));
  handle('orvex:devices:hostStop', () => devices.stopHost());
  handle('orvex:devices:pairCode', () => devices.newPairCode());
  handle('orvex:devices:discover', ({ timeoutMs } = {}) => devices.discover({ timeoutMs }));
  handle('orvex:devices:pair', (payload = {}) => devices.pair(payload || {}));
  handle('orvex:devices:check', ({ id } = {}) => devices.check(id));
  handle('orvex:devices:pull', ({ id } = {}) => devices.pull(id));
  handle('orvex:devices:push', ({ id } = {}) => devices.push(id));
  handle('orvex:devices:unpair', ({ id } = {}) => devices.unpair(id));

  /* agent-to-agent messaging */
  handle('orvex:a2a:status', () => a2a.status());
  handle('orvex:a2a:hostStart', ({ port, expose } = {}) => {
    requireOwner();
    return a2a.hostStart({ port, expose });
  });
  handle('orvex:a2a:hostStop', () => {
    requireOwner();
    return a2a.hostStop();
  });
  handle('orvex:a2a:rotateToken', () => {
    requireOwner();
    return a2a.rotateToken();
  });
  handle('orvex:a2a:peerAdd', (payload = {}) => {
    requireOwner();
    return { peer: a2a.addPeer(payload || {}) };
  });
  handle('orvex:a2a:peerRemove', ({ id } = {}) => {
    requireOwner();
    return a2a.removePeer(id);
  });
  handle('orvex:a2a:peerCard', ({ url } = {}) => a2a.fetchCard(url));
  handle('orvex:a2a:send', (payload = {}) => a2a.send(payload.peerId, payload.text, { timeoutMs: payload.timeoutMs }));
  handle('orvex:a2a:tasks', ({ limit, direction } = {}) => ({ tasks: a2a.listTasks({ limit, direction }) }));
  handle('orvex:a2a:task', ({ id } = {}) => a2a.getTask(id));
  handle('orvex:a2a:cancel', ({ id } = {}) => a2a.cancel(id));
}

function registerMediaProtocol() {
  protocol.handle('orvex-media', async (request) => {
    try {
      const file = await creative.resolveUrl(request.url);
      const stat = await fsp.stat(file);
      const type = creative._internals.mimeOf(file);
      const range = request.headers.get('range');
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
        const satisfiable = (start, end) =>
          Number.isInteger(start) && Number.isInteger(end) && start >= 0 && start <= end && start < stat.size;
        if (!match || (!match[1] && !match[2])) {
          return new Response('Range not satisfiable', { status: 416, headers: { 'content-range': `bytes */${stat.size}` } });
        }
        let start;
        let end;
        if (!match[1]) {
          // Suffix range: bytes=-N means the last N bytes.
          const suffix = Number(match[2]);
          if (!Number.isInteger(suffix) || suffix <= 0 || stat.size === 0) {
            return new Response('Range not satisfiable', { status: 416, headers: { 'content-range': `bytes */${stat.size}` } });
          }
          start = Math.max(stat.size - suffix, 0);
          end = stat.size - 1;
        } else {
          start = Number(match[1]);
          end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
        }
        if (!satisfiable(start, end)) {
          return new Response('Range not satisfiable', { status: 416, headers: { 'content-range': `bytes */${stat.size}` } });
        }
        const stream = Readable.toWeb(fs.createReadStream(file, { start, end }));
        return new Response(stream, {
          status: 206,
          headers: {
            'content-type': type,
            'content-length': String(end - start + 1),
            'content-range': `bytes ${start}-${end}/${stat.size}`,
            'accept-ranges': 'bytes',
            'cache-control': 'no-cache',
          },
        });
      }
      const stream = Readable.toWeb(fs.createReadStream(file));
      return new Response(stream, {
        status: 200,
        headers: {
          'content-type': type,
          'content-length': String(stat.size),
          'accept-ranges': 'bytes',
          'cache-control': 'no-cache',
        },
      });
    } catch (err) {
      return new Response(String(err && err.message ? err.message : err), {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
  });
}

if (process.platform === 'win32') app.setAppUserModelId('com.orvex.app');

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showWindow(true);
  });

  app.whenReady().then(async () => {
    // This process owns the single-instance lock, so no engine can be live:
    // unfinished rows belong to the previous session.
    db.runsMarkStale();
    fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true });
    relaxCors();
    setupMediaPermissions();
    try {
      await mediaServer.start({
        dirs: [path.join(__dirname, '..', 'dist', 'mediapipe'), path.join(__dirname, '..', 'public', 'mediapipe')],
      });
    } catch (err) {
      console.error('Media asset server failed:', err && err.message ? err.message : err);
    }
    registerIpc();
    registerMediaProtocol();
    createWindow();
    syncLocalWhisper();
    setupTray();
    setupHotkey();
    setupAirStopHotkey();
    // Give the window and local model servers a moment to come up first.
    setTimeout(() => {
      void autoResumeInterrupted()
        .then((runId) => {
          if (runId) return;
          const waiting = db.runsUnfinished(15).filter((run) => run.status === 'interrupted');
          if (!waiting.length) return;
          sendToWindow('orvex:notify', {
            title: 'ORVEX has interrupted plans',
            body: `${waiting.length} plan(s) stopped when ORVEX last closed. Open Engine to resume them.`,
            kind: 'system',
            target: 'engine',
            at: Date.now(),
          });
        })
        .catch(() => {});
    }, 5000);
    setTimeout(() => {
      void updater
        .autoCheck()
        .then((result) => {
          if (!result || !result.ok || !result.available) return;
          sendToWindow('orvex:notify', {
            title: `ORVEX ${result.latest} is available`,
            body: 'Open Advisor → Updates to review and verify the release before installing.',
            kind: 'system',
            target: 'advisor',
            tab: 'updates',
            at: Date.now(),
          });
        })
        .catch(() => {});
    }, 20_000);
    void connectMcp().catch((err) => {
      tools.audit({ kind: 'mcp_error', error: err && err.message ? err.message : String(err) });
      console.error('MCP connect failed:', err && err.message ? err.message : err);
    });
    void integrations.autostartWebhook().catch(() => {});
    void mcpServer.autostart().catch(() => {});
    try {
      monitor.start();
    } catch (err) {
      console.error('Monitoring sampler failed:', err && err.message ? err.message : err);
    }
    try {
      workflows.start();
    } catch (err) {
      console.error('Workflow scheduler failed:', err && err.message ? err.message : err);
    }
    try {
      workforce.start();
    } catch (err) {
      console.error('Workforce scheduler failed:', err && err.message ? err.message : err);
    }
    try {
      powerMonitor.on('lock-screen', () => {
        if (security.hasPin()) {
          try {
            security.lock('Windows session locked');
          } catch {
            /* no PIN or already locked */
          }
        }
      });
    } catch {
      /* powerMonitor is unavailable on some headless builds */
    }
    securityTimer = setInterval(() => {
      try {
        security.idleLockCheck();
      } catch {
        /* never let the timer crash the app */
      }
    }, 30_000);
    securityTimer.unref?.();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showWindow(true);
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    gamePilot.shutdown();
    whisperLocal.stop();
    localBrain.shutdown().catch(() => {});
    maker.stopAll().catch(() => {});
  });

  app.on('before-quit', () => {
    quitting = true;
    if (securityTimer) {
      clearInterval(securityTimer);
      securityTimer = null;
    }
    for (const controller of llmStreams.values()) controller.abort();
    llmStreams.clear();
    for (const entry of speechStreams.values()) entry.controller.abort();
    speechStreams.clear();
    for (const entry of pendingAdvancedApprovals.values()) {
      clearTimeout(entry.timer);
      entry.done(false);
    }
    pendingAdvancedApprovals.clear();
    advanced.stopRules();
    workforce.stop();
    plugins.stopAll();
    devices.stop();
    if (activeRun) {
      activeRun.controller.abort();
      activeRun.releaseWaiters();
    }
    void browser.close();
    desktop.shutdown();
    code.dispose();
    research.dispose();
    void filesStore.close();
    void creative.close();
    void mcp.disconnectAll();
    void integrations.stopWebhook({ persist: false });
    void mcpServer.stop({ persist: false });
    workflows.stop();
    monitor.shutdown();
    db.close();
  });
}
