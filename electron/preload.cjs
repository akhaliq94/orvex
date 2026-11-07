'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('orvex', {
  isDesktop: true,
  env: () => invoke('orvex:env'),
  tools: {
    run: (name, args) => invoke('orvex:tool', { name, args }),
  },
  agent: {
    start: (payload) => invoke('orvex:agent:start', payload),
    stop: () => invoke('orvex:agent:stop'),
    status: () => invoke('orvex:agent:status'),
    pause: () => invoke('orvex:agent:pause'),
    resume: () => invoke('orvex:agent:resume'),
    approve: (id, allow) => invoke('orvex:agent:approve', { id, allow }),
    onEvent: (cb) => {
      const handler = (_event, data) => cb(data);
      ipcRenderer.on('orvex:agent-event', handler);
      return () => ipcRenderer.removeListener('orvex:agent-event', handler);
    },
  },
  orchestrator: {
    start: (payload) => invoke('orvex:orchestrator:start', payload),
    resume: (payload) => invoke('orvex:orchestrator:resume', payload),
    runs: (limit) => invoke('orvex:orchestrator:runs', { limit }),
    run: (runId) => invoke('orvex:orchestrator:run', { runId }),
    setAutoResume: (enabled) => invoke('orvex:orchestrator:setAutoResume', { enabled }),
  },
  app: {
    prefs: () => invoke('orvex:app:prefs'),
    setPrefs: (patch) => invoke('orvex:app:prefs:set', patch),
    window: (action, extra) => invoke('orvex:app:window', { action, ...(extra || {}) }),
    onWake: (cb) => {
      const handler = () => cb();
      ipcRenderer.on('orvex:wake', handler);
      return () => ipcRenderer.removeListener('orvex:wake', handler);
    },
    onWindowState: (cb) => {
      const handler = (_event, data) => cb(data);
      ipcRenderer.on('orvex:window:state', handler);
      return () => ipcRenderer.removeListener('orvex:window:state', handler);
    },
    onNavigate: (cb) => {
      const handler = (_event, data) => cb(data);
      ipcRenderer.on('orvex:navigate', handler);
      return () => ipcRenderer.removeListener('orvex:navigate', handler);
    },
    onNotify: (cb) => {
      const handler = (_event, data) => cb(data);
      ipcRenderer.on('orvex:notify', handler);
      return () => ipcRenderer.removeListener('orvex:notify', handler);
    },
  },
  audit: {
    tail: (limit) => invoke('orvex:audit:tail', limit),
  },
  llm: {
    start: (payload) => invoke('orvex:llm:start', payload),
    abort: (requestId) => invoke('orvex:llm:abort', { requestId }),
    onEvent: (cb) => {
      const handler = (_event, data) => cb(data);
      ipcRenderer.on('orvex:llm-event', handler);
      return () => ipcRenderer.removeListener('orvex:llm-event', handler);
    },
  },
  providers: {
    test: (provider) => invoke('orvex:providers:test', { provider }),
    models: (provider) => invoke('orvex:providers:models', { provider }),
  },
  stt: {
    transcribe: (payload) => invoke('orvex:stt:transcribe', payload),
    setEndpoint: (url) => invoke('orvex:stt:setEndpoint', { url }),
    useProviderKey: (url) => invoke('orvex:stt:useProviderKey', { url }),
    models: (url) => invoke('orvex:stt:models', { url }),
    keys: {
      list: (url) => invoke('orvex:stt:keys:list', { url }),
      add: (key, label, url) => invoke('orvex:stt:keys:add', { key, label, url }),
      remove: (id, url) => invoke('orvex:stt:keys:remove', { id, url }),
      reset: () => invoke('orvex:stt:keys:reset', {}),
    },
    realtime: {
      start: (payload) => invoke('orvex:stt:realtime:start', payload || {}),
      audio: (id, audio, commit) => invoke('orvex:stt:realtime:audio', { id, audio, commit: !!commit }),
      commit: (id) => invoke('orvex:stt:realtime:commit', { id }),
      stop: (id) => invoke('orvex:stt:realtime:stop', { id }),
      onEvent: (cb) => {
        const handler = (_event, data) => cb(data);
        ipcRenderer.on('orvex:stt:realtime-event', handler);
        return () => ipcRenderer.removeListener('orvex:stt:realtime-event', handler);
      },
    },
  },
  routing: {
    get: () => invoke('orvex:routing:get'),
    set: (task, chain) => invoke('orvex:routing:set', { task, chain }),
    clear: (task) => invoke('orvex:routing:clear', { task }),
  },
  usage: {
    summary: (sinceMs) => invoke('orvex:usage:summary', { sinceMs }),
    recent: (limit) => invoke('orvex:usage:recent', limit),
    clear: () => invoke('orvex:usage:clear'),
  },
  budget: {
    get: () => invoke('orvex:budget:get'),
    set: (dailyUsd, monthlyUsd) => invoke('orvex:budget:set', { dailyUsd, monthlyUsd }),
  },
  advisor: {
    brief: () => invoke('orvex:advisor:brief'),
    suggestions: () => invoke('orvex:advisor:suggestions'),
    dismiss: (id, hours) => invoke('orvex:advisor:dismiss', { id, hours }),
    restore: (id) => invoke('orvex:advisor:restore', { id }),
    budget: () => invoke('orvex:advisor:budget'),
    setBudget: (payload) => invoke('orvex:advisor:budget:set', payload),
    update: () => invoke('orvex:advisor:update'),
    setUpdateFeed: (url) => invoke('orvex:advisor:update:feed', { url }),
    checkUpdate: (url) => invoke('orvex:advisor:update:check', { url }),
  },
  updater: {
    state: () => invoke('orvex:updater:state'),
    setRepo: (repo) => invoke('orvex:updater:repo', { repo }),
    setAutoCheck: (enabled) => invoke('orvex:updater:autoCheck', { enabled }),
    check: (repo) => invoke('orvex:updater:check', { repo }),
    download: () => invoke('orvex:updater:download'),
    install: () => invoke('orvex:updater:install'),
    reveal: () => invoke('orvex:updater:reveal'),
    openRelease: () => invoke('orvex:updater:openRelease'),
    onEvent: (cb) => {
      const handler = (_event, data) => cb(data);
      ipcRenderer.on('orvex:updater:event', handler);
      return () => ipcRenderer.removeListener('orvex:updater:event', handler);
    },
  },
  health: {
    reset: () => invoke('orvex:health:reset'),
  },
  monitor: {
    overview: () => invoke('orvex:monitor:overview'),
    series: (minutes) => invoke('orvex:monitor:series', { minutes }),
    sample: () => invoke('orvex:monitor:sample'),
    usage: (sinceMs) => invoke('orvex:monitor:usage', { sinceMs }),
    usageSeries: (sinceMs) => invoke('orvex:monitor:usageSeries', { sinceMs }),
    usageCsv: (sinceMs) => invoke('orvex:monitor:usageCsv', { sinceMs }),
    traces: (limit) => invoke('orvex:monitor:traces', { limit }),
    trace: (runId) => invoke('orvex:monitor:trace', { runId }),
    compare: (payload) => invoke('orvex:monitor:compare', payload),
    health: (candidates) => invoke('orvex:monitor:health', { candidates }),
    recoverables: () => invoke('orvex:monitor:recoverables'),
    abandon: (runId) => invoke('orvex:monitor:abandon', { runId }),
    crashes: (limit) => invoke('orvex:monitor:crashes', { limit }),
    clearCrashes: () => invoke('orvex:monitor:clearCrashes'),
    evalSuites: () => invoke('orvex:monitor:evalSuites'),
    evalSave: (payload) => invoke('orvex:monitor:evalSave', payload),
    evalDelete: (id) => invoke('orvex:monitor:evalDelete', { id }),
    evalRun: (payload) => invoke('orvex:monitor:evalRun', payload),
    evalHistory: (suite, limit) => invoke('orvex:monitor:evalHistory', { suite, limit }),
    evalClear: (suite) => invoke('orvex:monitor:evalClear', { suite }),
  },
  productivity: {
    capabilities: () => invoke('orvex:productivity:capabilities'),
    calc: (expression) => invoke('orvex:productivity:calc', { expression }),
    pythonInfo: () => invoke('orvex:productivity:pythonInfo'),
    runPython: (payload) => invoke('orvex:productivity:runPython', payload),
    dataAnalyze: (payload) => invoke('orvex:productivity:dataAnalyze', payload),
    dataChart: (payload) => invoke('orvex:productivity:dataChart', payload),
    sheetOpen: (payload) => invoke('orvex:productivity:sheetOpen', payload),
    sheetSave: (payload) => invoke('orvex:productivity:sheetSave', payload),
    sheetCreate: (payload) => invoke('orvex:productivity:sheetCreate', payload),
    sqlRun: (payload) => invoke('orvex:productivity:sqlRun', payload),
    sqlTables: () => invoke('orvex:productivity:sqlTables'),
    sqlSchema: (table) => invoke('orvex:productivity:sqlSchema', { table }),
    reportBuild: (payload) => invoke('orvex:productivity:reportBuild', payload),
    transcribeAudio: (payload) => invoke('orvex:productivity:transcribeAudio', payload),
    meetingSummarize: (payload) => invoke('orvex:productivity:meetingSummarize', payload),
    noteList: (payload) => invoke('orvex:productivity:noteList', payload),
    noteCreate: (payload) => invoke('orvex:productivity:noteCreate', payload),
    noteUpdate: (payload) => invoke('orvex:productivity:noteUpdate', payload),
    noteDelete: (id) => invoke('orvex:productivity:noteDelete', { id }),
    noteAsk: (payload) => invoke('orvex:productivity:noteAsk', payload),
    taskList: (payload) => invoke('orvex:productivity:taskList', payload),
    taskCreate: (payload) => invoke('orvex:productivity:taskCreate', payload),
    taskUpdate: (payload) => invoke('orvex:productivity:taskUpdate', payload),
    taskToggle: (id) => invoke('orvex:productivity:taskToggle', { id }),
    taskRemove: (id) => invoke('orvex:productivity:taskRemove', { id }),
    taskStats: () => invoke('orvex:productivity:taskStats'),
    translate: (payload) => invoke('orvex:productivity:translate', payload),
    textList: () => invoke('orvex:productivity:textList'),
    textOpen: (name) => invoke('orvex:productivity:textOpen', { name }),
    textSave: (payload) => invoke('orvex:productivity:textSave', payload),
    textRemove: (name) => invoke('orvex:productivity:textRemove', { name }),
    textRename: (name, newName) => invoke('orvex:productivity:textRename', { name, newName }),
    slidesBuild: (payload) => invoke('orvex:productivity:slidesBuild', payload),
    compareDocs: (payload) => invoke('orvex:productivity:compareDocs', payload),
    artifacts: (payload) => invoke('orvex:productivity:artifacts', payload),
  },
  db: {
    info: () => invoke('orvex:db:info'),
  },
  secrets: {
    get: () => invoke('orvex:secrets:get'),
    set: (id, key, baseUrl) => invoke('orvex:secrets:set', { id, key, baseUrl }),
  },
  memory: {
    get: () => invoke('orvex:memory:get'),
    set: (text) => invoke('orvex:memory:set', { text }),
    clear: () => invoke('orvex:memory:clear'),
    info: () => invoke('orvex:memory:info'),
    stats: () => invoke('orvex:memory:stats'),
    list: (filters) => invoke('orvex:memory:list', filters),
    item: (id) => invoke('orvex:memory:item', { id }),
    add: (payload) => invoke('orvex:memory:add', payload),
    update: (id, patch) => invoke('orvex:memory:update', { id, patch }),
    remove: (id) => invoke('orvex:memory:remove', { id }),
    search: (query, opts) => invoke('orvex:memory:search', { query, ...opts }),
    ask: (payload) => invoke('orvex:memory:ask', payload),
    profile: () => invoke('orvex:memory:profile:get'),
    saveProfile: (patch) => invoke('orvex:memory:profile:save', patch),
    conflicts: (status) => invoke('orvex:memory:conflicts', { status }),
    resolve: (id, action, mergedText) => invoke('orvex:memory:resolve', { id, action, mergedText }),
    links: (id, limit) => invoke('orvex:memory:links', { id, limit }),
    graph: (opts) => invoke('orvex:memory:graph', opts),
    context: (opts) => invoke('orvex:memory:context', opts),
    importLegacy: () => invoke('orvex:memory:import'),
    sweep: () => invoke('orvex:memory:sweep'),
  },
  files: {
    info: () => invoke('orvex:files:info'),
    roots: () => invoke('orvex:files:roots'),
    list: (path) => invoke('orvex:files:list', { path }),
    search: (path, query, limit) => invoke('orvex:files:search', { path, query, limit }),
    stat: (path) => invoke('orvex:files:stat', { path }),
    read: (path, maxBytes) => invoke('orvex:files:read', { path, maxBytes }),
    write: (path, content) => invoke('orvex:files:write', { path, content }),
    mkdir: (path, recursive) => invoke('orvex:files:mkdir', { path, recursive }),
    rename: (from, to) => invoke('orvex:files:rename', { from, to }),
    copy: (from, to, overwrite) => invoke('orvex:files:copy', { from, to, overwrite }),
    remove: (path, recursive) => invoke('orvex:files:remove', { path, recursive }),
    duplicates: (path, opts) => invoke('orvex:files:duplicates', { path, ...opts }),
    zip: (dest, sources) => invoke('orvex:files:zip', { dest, sources }),
    unzip: (zipPath, destDir) => invoke('orvex:files:unzip', { zipPath, destDir }),
    zipList: (zipPath) => invoke('orvex:files:zipList', { zipPath }),
    pdfInfo: (path) => invoke('orvex:files:pdfInfo', { path }),
    pdfMerge: (paths, dest) => invoke('orvex:files:pdfMerge', { paths, dest }),
    pdfSplit: (path, ranges, destDir) => invoke('orvex:files:pdfSplit', { path, ranges, destDir }),
    pdfRotate: (path, pages, degrees, dest) => invoke('orvex:files:pdfRotate', { path, pages, degrees, dest }),
    pdfSetMeta: (path, meta, dest) => invoke('orvex:files:pdfMeta', { path, meta, dest }),
    pdfCreate: (dest, title, text) => invoke('orvex:files:pdfCreate', { dest, title, text }),
    xlsxInfo: (path) => invoke('orvex:files:xlsxInfo', { path }),
    xlsxRead: (path, sheet, limit) => invoke('orvex:files:xlsxRead', { path, sheet, limit }),
    xlsxToCsv: (path, dest, sheet) => invoke('orvex:files:xlsxToCsv', { path, dest, sheet }),
    xlsxWrite: (dest, sheets) => invoke('orvex:files:xlsxWrite', { dest, sheets }),
    docxMake: (dest, markdown, title) => invoke('orvex:files:docxMake', { dest, markdown, title }),
    diff: (a, b) => invoke('orvex:files:diff', { a, b }),
    backup: (path) => invoke('orvex:files:backup', { path }),
    backups: (path) => invoke('orvex:files:backups', { path }),
    restoreBackup: (id) => invoke('orvex:files:restoreBackup', { id }),
    removeBackup: (id) => invoke('orvex:files:removeBackup', { id }),
    versions: (path) => invoke('orvex:files:versions', { path }),
    restoreVersion: (id) => invoke('orvex:files:restoreVersion', { id }),
    watchStart: (path) => invoke('orvex:files:watchStart', { path }),
    watchStop: (id) => invoke('orvex:files:watchStop', { id }),
    watchStatus: () => invoke('orvex:files:watchStatus'),
    pickFolder: () => invoke('orvex:files:pickFolder'),
    pickFile: (filters) => invoke('orvex:files:pickFile', { filters }),
    pickSave: (defaultPath, filters) => invoke('orvex:files:pickSave', { defaultPath, filters }),
    reveal: (path) => invoke('orvex:files:reveal', { path }),
    openPath: (path) => invoke('orvex:files:openPath', { path }),
    onChange: (cb) => {
      const handler = (_event, data) => cb(data);
      ipcRenderer.on('orvex:files:changed', handler);
      return () => ipcRenderer.removeListener('orvex:files:changed', handler);
    },
  },
  mcp: {
    get: () => invoke('orvex:mcp:get'),
    set: (servers) => invoke('orvex:mcp:set', { servers }),
    reconnect: () => invoke('orvex:mcp:reconnect'),
  },
  media: {
    assets: () => invoke('orvex:media:assets'),
    info: () => invoke('orvex:media:info'),
    library: (filters) => invoke('orvex:media:library', filters),
    get: (id) => invoke('orvex:media:get', { id }),
    remove: (id) => invoke('orvex:media:delete', { id }),
    rename: (id, name) => invoke('orvex:media:rename', { id, name }),
    importFile: (path) => invoke('orvex:media:import', { path }),
    importPick: () => invoke('orvex:media:importPick'),
    pickFile: (filters) => invoke('orvex:media:pickFile', { filters }),
    exportAsset: (id, destPath) => invoke('orvex:media:export', { id, destPath }),
    reveal: (id) => invoke('orvex:media:reveal', { id }),
    open: (id) => invoke('orvex:media:open', { id }),
    source: (path) => invoke('orvex:media:source', { path }),
    generate: (payload) => invoke('orvex:media:generate', payload),
    edit: (payload) => invoke('orvex:media:edit', payload),
    removeBackground: (payload) => invoke('orvex:media:removeBackground', payload),
    upscale: (payload) => invoke('orvex:media:upscale', payload),
    analyze: (payload) => invoke('orvex:media:analyze', payload),
    transcribe: (payload) => invoke('orvex:media:transcribe', payload),
    subtitles: (payload) => invoke('orvex:media:subtitles', payload),
    srt: (payload) => invoke('orvex:media:srt', payload),
    tts: (payload) => invoke('orvex:media:tts', payload),
    heygenVoices: (payload) => invoke('orvex:media:heygenVoices', payload),
    heygenTts: (payload) => invoke('orvex:media:heygenTts', payload),
    heygenTtsStream: (payload) => invoke('orvex:media:heygenTtsStream', payload),
    stopHeygenTts: (id) => invoke('orvex:media:stopHeygenTts', { id }),
    onHeygenAudio: (cb) => {
      const handler = (_event, data) => cb(data);
      ipcRenderer.on('orvex:media:heygenAudio', handler);
      return () => ipcRenderer.removeListener('orvex:media:heygenAudio', handler);
    },
    elevenVoices: () => invoke('orvex:media:elevenVoices', {}),
    elevenModels: () => invoke('orvex:media:elevenModels', {}),
    elevenTtsStream: (payload) => invoke('orvex:media:elevenTtsStream', payload),
    stopElevenTts: (id) => invoke('orvex:media:stopElevenTts', { id }),
    onElevenAudio: (cb) => {
      const handler = (_event, data) => cb(data);
      ipcRenderer.on('orvex:media:elevenAudio', handler);
      return () => ipcRenderer.removeListener('orvex:media:elevenAudio', handler);
    },
    music: (payload) => invoke('orvex:media:music', payload),
    inspect3d: (path) => invoke('orvex:media:inspect3d', { path }),
    saveText: (name, text, ext) => invoke('orvex:media:saveText', { name, text, ext }),
    saveSubtitle: (name, text, format) => invoke('orvex:media:saveSubtitle', { name, text, format }),
    saveImage: (dataUrl, name) => invoke('orvex:media:saveImage', { dataUrl, name }),
    prompts: (filters) => invoke('orvex:media:prompts', filters),
    savePrompt: (payload) => invoke('orvex:media:prompt:save', payload),
    deletePrompt: (id) => invoke('orvex:media:prompt:delete', { id }),
    usePrompt: (id) => invoke('orvex:media:prompt:use', { id }),
    assetUrl: (id) => `orvex-media://asset/${encodeURIComponent(String(id))}`,
    onChange: (cb) => {
      const handler = (_event, data) => cb(data);
      ipcRenderer.on('orvex:media:changed', handler);
      return () => ipcRenderer.removeListener('orvex:media:changed', handler);
    },
  },
  desktop: {
    system: () => invoke('orvex:desktop:system'),
    metrics: () => invoke('orvex:desktop:metrics'),
    power: (action) => invoke('orvex:desktop:power', { action }),
    volume: (payload) => invoke('orvex:desktop:volume', payload),
    brightness: (payload) => invoke('orvex:desktop:brightness', payload),
    screenInfo: () => invoke('orvex:desktop:screenInfo'),
    capture: (payload) => invoke('orvex:desktop:capture', payload),
    ocr: (payload) => invoke('orvex:desktop:ocr', payload),
    uiTree: (payload) => invoke('orvex:desktop:uiTree', payload),
    uiAction: (payload) => invoke('orvex:desktop:uiAction', payload),
    mouseMove: (x, y) => invoke('orvex:desktop:mouseMove', { x, y }),
    mouseClick: (payload) => invoke('orvex:desktop:mouseClick', payload),
    mouseScroll: (payload) => invoke('orvex:desktop:mouseScroll', payload),
    mouseDrag: (payload) => invoke('orvex:desktop:mouseDrag', payload),
    mouseDown: (button) => invoke('orvex:desktop:mouseDown', { button }),
    mouseUp: (button) => invoke('orvex:desktop:mouseUp', { button }),
    keyType: (text) => invoke('orvex:desktop:keyType', { text }),
    keyPress: (keys) => invoke('orvex:desktop:keyPress', { keys }),
    windows: (filters) => invoke('orvex:desktop:windowList', filters),
    windowAction: (payload) => invoke('orvex:desktop:windowAction', payload),
    apps: (filters) => invoke('orvex:desktop:appList', filters),
    appLaunch: (payload) => invoke('orvex:desktop:appLaunch', payload),
    screenFind: (payload) => invoke('orvex:desktop:screenFind', payload),
    screenClickText: (payload) => invoke('orvex:desktop:screenClickText', payload),
    processes: (filters) => invoke('orvex:desktop:processList', filters),
    processKill: (payload) => invoke('orvex:desktop:processKill', payload),
    clipboardRead: () => invoke('orvex:desktop:clipboardRead'),
    clipboardWrite: (payload) => invoke('orvex:desktop:clipboardWrite', payload),
    recordStart: (payload) => invoke('orvex:desktop:recordStart', payload),
    recordStop: () => invoke('orvex:desktop:recordStop'),
    recordStatus: () => invoke('orvex:desktop:recordStatus'),
    source: (filePath) => invoke('orvex:desktop:source', { path: filePath }),
    exportFile: (filePath, name) => invoke('orvex:desktop:export', { path: filePath, name }),
    reveal: (filePath) => invoke('orvex:desktop:reveal', { path: filePath }),
  },
  hands: {
    run: (payload) => invoke('orvex:hands:run', payload),
    stop: () => invoke('orvex:hands:stop'),
    onEvent: (cb) => {
      const handler = (_event, data) => cb(data);
      ipcRenderer.on('orvex:hands:event', handler);
      return () => ipcRenderer.removeListener('orvex:hands:event', handler);
    },
  },
  gamePilot: {
    profiles: () => invoke('orvex:gamepilot:profiles'),
    status: () => invoke('orvex:gamepilot:status'),
    saveProfile: (profile) => invoke('orvex:gamepilot:saveProfile', profile),
    deleteProfile: (id) => invoke('orvex:gamepilot:deleteProfile', { id }),
    start: (id) => invoke('orvex:gamepilot:start', { id }),
    stop: () => invoke('orvex:gamepilot:stop'),
    onEvent: (cb) => {
      const handler = (_event, data) => cb(data);
      ipcRenderer.on('orvex:gamepilot:event', handler);
      return () => ipcRenderer.removeListener('orvex:gamepilot:event', handler);
    },
  },
  code: {
    info: () => invoke('orvex:code:info'),
    open: () => invoke('orvex:code:open'),
    openPath: (dir) => invoke('orvex:code:openPath', { dir }),
    close: () => invoke('orvex:code:close'),
    list: (path) => invoke('orvex:code:list', { path }),
    read: (path) => invoke('orvex:code:read', { path }),
    write: (path, content) => invoke('orvex:code:write', { path, content }),
    rename: (from, to) => invoke('orvex:code:rename', { from, to }),
    remove: (path) => invoke('orvex:code:remove', { path }),
    search: (query) => invoke('orvex:code:search', { query }),
    gitStatus: () => invoke('orvex:code:gitStatus'),
    gitDiff: (path, staged) => invoke('orvex:code:gitDiff', { path, staged }),
    gitStage: (paths) => invoke('orvex:code:gitStage', { paths }),
    gitUnstage: (paths) => invoke('orvex:code:gitUnstage', { paths }),
    gitCommit: (message) => invoke('orvex:code:gitCommit', { message }),
    gitLog: (limit) => invoke('orvex:code:gitLog', { limit }),
    gitInit: () => invoke('orvex:code:gitInit'),
    run: (script) => invoke('orvex:code:run', { script }),
    terminal: (command, cwd) => invoke('orvex:code:terminal', { command, cwd }),
    stop: (runId) => invoke('orvex:code:stop', { runId }),
    onOutput: (cb) => {
      const handler = (_event, data) => cb(data);
      ipcRenderer.on('orvex:code:output', handler);
      return () => ipcRenderer.removeListener('orvex:code:output', handler);
    },
    onChange: (cb) => {
      const handler = (_event, data) => cb(data);
      ipcRenderer.on('orvex:code:changed', handler);
      return () => ipcRenderer.removeListener('orvex:code:changed', handler);
    },
  },
  research: {
    info: () => invoke('orvex:research:info'),
    list: () => invoke('orvex:research:list'),
    get: (id) => invoke('orvex:research:get', { id }),
    remove: (id) => invoke('orvex:research:delete', { id }),
    start: (payload) => invoke('orvex:research:start', payload),
    stop: (runId) => invoke('orvex:research:stop', { runId }),
    readUrl: (url, maxChars) => invoke('orvex:research:readUrl', { url, maxChars }),
    readFile: () => invoke('orvex:research:readFile'),
    saveDocument: (document) => invoke('orvex:research:saveDocument', { document }),
    exportReport: (id) => invoke('orvex:research:export', { id }),
    openExternal: (url) => invoke('orvex:research:open', { url }),
    onEvent: (cb) => {
      const handler = (_event, data) => cb(data);
      ipcRenderer.on('orvex:research:event', handler);
      return () => ipcRenderer.removeListener('orvex:research:event', handler);
    },
  },
  integrations: {
    list: () => invoke('orvex:integrations:list'),
    save: (payload) => invoke('orvex:integrations:save', payload),
    remove: (id) => invoke('orvex:integrations:delete', { id }),
    test: (id) => invoke('orvex:integrations:test', { id }),
    run: (payload) => invoke('orvex:integrations:run', payload),
    health: () => invoke('orvex:integrations:health'),
    http: (payload) => invoke('orvex:integrations:http', payload),
    ws: (payload) => invoke('orvex:integrations:ws', payload),
    webhook: (payload) => invoke('orvex:integrations:webhook', payload),
    onChange: (cb) => {
      const handler = (_event, data) => cb(data);
      ipcRenderer.on('orvex:integrations:changed', handler);
      return () => ipcRenderer.removeListener('orvex:integrations:changed', handler);
    },
  },
  connectors: {
    list: () => invoke('orvex:connectors:list'),
    preview: (payload) => invoke('orvex:connectors:preview', payload),
    save: (payload) => invoke('orvex:connectors:save', payload),
    remove: (id) => invoke('orvex:connectors:delete', { id }),
    test: (id) => invoke('orvex:connectors:test', { id }),
    call: (payload) => invoke('orvex:connectors:call', payload),
    onChange: (cb) => {
      const handler = (_event, data) => cb(data);
      ipcRenderer.on('orvex:connectors:changed', handler);
      return () => ipcRenderer.removeListener('orvex:connectors:changed', handler);
    },
  },
  maker: {
    list: () => invoke('orvex:maker:list'),
    templates: () => invoke('orvex:maker:templates'),
    create: (payload) => invoke('orvex:maker:create', payload),
    files: (projectId, path) => invoke('orvex:maker:files', { projectId, path }),
    read: (projectId, path) => invoke('orvex:maker:read', { projectId, path }),
    write: (projectId, path, content) => invoke('orvex:maker:write', { projectId, path, content }),
    preview: (projectId) => invoke('orvex:maker:preview', { projectId }),
    stopPreview: (projectId) => invoke('orvex:maker:stopPreview', { projectId }),
    export: (projectId, destDir) => invoke('orvex:maker:export', { projectId, destDir }),
    run: (projectId, args) => invoke('orvex:maker:run', { projectId, args }),
    remove: (projectId) => invoke('orvex:maker:remove', { projectId }),
    open: (projectId) => invoke('orvex:maker:open', { projectId }),
    reveal: (projectId) => invoke('orvex:maker:reveal', { projectId }),
    onChange: (cb) => {
      const handler = (_event, data) => cb(data);
      ipcRenderer.on('orvex:maker:changed', handler);
      return () => ipcRenderer.removeListener('orvex:maker:changed', handler);
    },
  },
  oauth: {
    state: () => invoke('orvex:oauth:state'),
    device: (payload) => invoke('orvex:oauth:device', payload),
    pkce: (payload) => invoke('orvex:oauth:pkce', payload),
    flow: (id) => invoke('orvex:oauth:flow', { id }),
    cancel: (id) => invoke('orvex:oauth:cancel', { id }),
    remove: (id) => invoke('orvex:oauth:remove', { id }),
    tokenState: (id) => invoke('orvex:oauth:tokenState', { id }),
    check: (id) => invoke('orvex:oauth:check', { id }),
    onChange: (cb) => {
      const handler = (_event, data) => cb(data);
      ipcRenderer.on('orvex:oauth:changed', handler);
      return () => ipcRenderer.removeListener('orvex:oauth:changed', handler);
    },
  },
  permissions: {
    state: () => invoke('orvex:permissions:state'),
    set: (tool, policy) => invoke('orvex:permissions:set', { tool, policy }),
    reset: (tool) => invoke('orvex:permissions:reset', { tool }),
    addFloor: (floor) => invoke('orvex:permissions:addFloor', floor),
    removeFloor: (id) => invoke('orvex:permissions:removeFloor', { id }),
  },
  approvalAdvisor: {
    state: () => invoke('orvex:approval-advisor:state'),
    add: (rule) => invoke('orvex:approval-advisor:add', rule),
    accept: (id) => invoke('orvex:approval-advisor:accept', { id }),
    remove: (id) => invoke('orvex:approval-advisor:remove', { id }),
    learn: () => invoke('orvex:approval-advisor:learn'),
  },
  mcpServer: {
    status: () => invoke('orvex:mcp-server:status'),
    start: (payload) => invoke('orvex:mcp-server:start', payload),
    stop: () => invoke('orvex:mcp-server:stop'),
    setAllowRisky: (allowRisky) => invoke('orvex:mcp-server:config', { allowRisky }),
    onChange: (cb) => {
      const handler = (_event, data) => cb(data);
      ipcRenderer.on('orvex:mcp-server:changed', handler);
      return () => ipcRenderer.removeListener('orvex:mcp-server:changed', handler);
    },
  },
  dashboard: {
    snapshot: () => invoke('orvex:dashboard:snapshot'),
  },
  security: {
    status: () => invoke('orvex:security:status'),
    setPin: (current, next) => invoke('orvex:security:setPin', { current, next }),
    removePin: (current) => invoke('orvex:security:removePin', { current }),
    unlock: (pin) => invoke('orvex:security:unlock', { pin }),
    lock: () => invoke('orvex:security:lock'),
    touch: () => invoke('orvex:security:touch'),
    setRole: (role, pin) => invoke('orvex:security:role', { role, pin }),
    setSettings: (patch) => invoke('orvex:security:settings', patch),
    emergencyStop: (reason) => invoke('orvex:security:emergencyStop', { reason }),
    emergencyClear: () => invoke('orvex:security:emergencyClear'),
    scan: (text) => invoke('orvex:security:scan', { text }),
    audit: (filters) => invoke('orvex:security:audit', filters),
    secrets: () => invoke('orvex:security:secrets'),
    setSecret: (id, value) => invoke('orvex:security:secretSet', { id, value }),
    deleteSecret: (id) => invoke('orvex:security:secretDelete', { id }),
    backups: () => invoke('orvex:security:backups'),
    createBackup: (payload) => invoke('orvex:security:backup', payload),
    restoreBackup: (id, passphrase) => invoke('orvex:security:restore', { id, passphrase }),
    deleteBackup: (id) => invoke('orvex:security:deleteBackup', { id }),
    clearData: (what) => invoke('orvex:security:privacy', { what }),
    onChange: (cb) => {
      const handler = (_event, data) => cb(data);
      ipcRenderer.on('orvex:security:changed', handler);
      return () => ipcRenderer.removeListener('orvex:security:changed', handler);
    },
  },
  workflows: {
    list: () => invoke('orvex:workflows:list'),
    save: (definition) => invoke('orvex:workflows:save', definition),
    remove: (id) => invoke('orvex:workflows:delete', { id }),
    setEnabled: (id, enabled) => invoke('orvex:workflows:enabled', { id, enabled }),
    run: (id, input) => invoke('orvex:workflows:run', { id, input }),
    runs: (workflowId, limit) => invoke('orvex:workflows:runs', { workflowId, limit }),
    clearRuns: (workflowId) => invoke('orvex:workflows:clearRuns', { workflowId }),
    runDetail: (id) => invoke('orvex:workflows:detail', { id }),
    approve: (runId, allow) => invoke('orvex:workflows:approve', { runId, allow }),
    cancel: (runId) => invoke('orvex:workflows:cancel', { runId }),
    resume: (runId) => invoke('orvex:workflows:resume', { runId }),
    templates: () => invoke('orvex:workflows:templates'),
    fromTemplate: (templateId) => invoke('orvex:workflows:fromTemplate', { templateId }),
    tools: () => invoke('orvex:workflows:tools'),
    cron: (expression, from) => invoke('orvex:workflows:cron', { expression, from }),
    onChange: (cb) => {
      const handler = (_event, data) => cb(data);
      ipcRenderer.on('orvex:workflows:changed', handler);
      return () => ipcRenderer.removeListener('orvex:workflows:changed', handler);
    },
  },
  training: {
    status: () => invoke('orvex:training:status'),
    usage: () => invoke('orvex:training:usage'),
    setRoot: (dir) => invoke('orvex:training:setRoot', { dir }),
    pickRoot: () => invoke('orvex:training:pickRoot'),
    setQuota: (bytes) => invoke('orvex:training:setQuota', { bytes }),
    openRoot: () => invoke('orvex:training:openRoot'),
    episodes: (payload) => invoke('orvex:training:episodes', payload),
    episode: (id) => invoke('orvex:training:episode', { id }),
    deleteEpisode: (id) => invoke('orvex:training:deleteEpisode', { id }),
    clearEpisodes: () => invoke('orvex:training:clearEpisodes'),
    stats: () => invoke('orvex:training:stats'),
    scoreCurve: (payload) => invoke('orvex:training:scoreCurve', payload),
    evalPacks: (limit) => invoke('orvex:training:evalPacks', { limit }),
    buildEvalPack: (payload) => invoke('orvex:training:buildEvalPack', payload),
    onChange: (cb) => {
      const handler = (_event, data) => cb(data);
      ipcRenderer.on('orvex:training:changed', handler);
      return () => ipcRenderer.removeListener('orvex:training:changed', handler);
    },
  },
  localBrain: {
    status: () => invoke('orvex:localbrain:status'),
    models: (payload) => invoke('orvex:localbrain:models', payload),
    refresh: (hash) => invoke('orvex:localbrain:modelsRefresh', { hash }),
    config: (patch) => invoke('orvex:localbrain:config', patch || {}),
    runtime: () => invoke('orvex:localbrain:runtime'),
    start: (id) => invoke('orvex:localbrain:start', { id }),
    stop: () => invoke('orvex:localbrain:stop'),
    chat: (payload) => invoke('orvex:localbrain:chat', payload),
    route: (payload) => invoke('orvex:localbrain:route', payload),
    grammar: () => invoke('orvex:localbrain:grammar'),
    hash: (id) => invoke('orvex:localbrain:hash', { id }),
    onChange: (cb) => {
      const handler = (_event, data) => cb(data);
      ipcRenderer.on('orvex:localbrain:changed', handler);
      return () => ipcRenderer.removeListener('orvex:localbrain:changed', handler);
    },
  },
  learner: {
    status: () => invoke('orvex:learner:status'),
    suggestions: () => invoke('orvex:learner:suggestions'),
    skills: (payload) => invoke('orvex:learner:skills', payload),
    skillPrompt: (id) => invoke('orvex:learner:skillPrompt', { id }),
    trainKits: (limit) => invoke('orvex:learner:trainKits', { limit }),
    models: () => invoke('orvex:learner:models'),
    finetunes: (limit) => invoke('orvex:learner:finetunes', { limit }),
    nanos: () => invoke('orvex:learner:nanos'),
    predict: (payload) => invoke('orvex:learner:predict', payload),
    trainNano: (payload) => invoke('orvex:learner:trainNano', payload),
    rollbackNano: () => invoke('orvex:learner:rollbackNano'),
    compileSkill: (payload) => invoke('orvex:learner:compileSkill', payload),
    saveSkill: (payload) => invoke('orvex:learner:saveSkill', payload),
    exportSkill: (id) => invoke('orvex:learner:exportSkill', { id }),
    exportSkills: () => invoke('orvex:learner:exportSkills'),
    importSkill: (payload) => invoke('orvex:learner:importSkill', payload),
    setSkillStatus: (payload) => invoke('orvex:learner:setSkillStatus', payload),
    deleteSkill: (id) => invoke('orvex:learner:deleteSkill', { id }),
    buildTrainKit: (payload) => invoke('orvex:learner:buildTrainKit', payload),
    pickGguf: () => invoke('orvex:learner:pickGguf'),
    importGguf: (payload) => invoke('orvex:learner:importGguf', payload),
    deleteModel: (id) => invoke('orvex:learner:deleteModel', { id }),
    finetune: (payload) => invoke('orvex:learner:finetune', payload),
    finetuneStatus: (id) => invoke('orvex:learner:finetuneStatus', { id }),
    finetuneCancel: (id) => invoke('orvex:learner:finetuneCancel', { id }),
    cycle: () => invoke('orvex:learner:cycle'),
    onChange: (cb) => {
      const handler = (_event, data) => cb(data);
      ipcRenderer.on('orvex:learner:changed', handler);
      return () => ipcRenderer.removeListener('orvex:learner:changed', handler);
    },
  },
  workforce: {
    status: () => invoke('orvex:workforce:status'),
    agents: (payload) => invoke('orvex:workforce:agents', payload),
    agent: (id) => invoke('orvex:workforce:agent', { id }),
    createAgent: (payload) => invoke('orvex:workforce:createAgent', payload),
    updateAgent: (payload) => invoke('orvex:workforce:updateAgent', payload),
    deleteAgent: (id) => invoke('orvex:workforce:deleteAgent', { id }),
    pauseAgent: (id) => invoke('orvex:workforce:pauseAgent', { id }),
    resumeAgent: (id) => invoke('orvex:workforce:resumeAgent', { id }),
    startShift: (id, goal) => invoke('orvex:workforce:startShift', { id, goal }),
    shifts: (payload) => invoke('orvex:workforce:shifts', payload),
    shift: (id) => invoke('orvex:workforce:shift', { id }),
    inbox: (payload) => invoke('orvex:workforce:inbox', payload),
    readInbox: (payload) => invoke('orvex:workforce:readInbox', payload),
    clearInbox: () => invoke('orvex:workforce:clearInbox'),
    tick: () => invoke('orvex:workforce:tick'),
    onChange: (cb) => {
      const handler = (_event, data) => cb(data);
      ipcRenderer.on('orvex:workforce:changed', handler);
      return () => ipcRenderer.removeListener('orvex:workforce:changed', handler);
    },
  },
  advanced: {
    status: () => invoke('orvex:advanced:status'),
    mode: (mode) => invoke('orvex:advanced:mode', mode ? { mode } : {}),
    context: () => invoke('orvex:advanced:context'),
    suggest: (payload) => invoke('orvex:advanced:suggest', payload),
    approve: (id, allow) => invoke('orvex:advanced:approve', { id, allow }),
    rules: () => invoke('orvex:advanced:rules'),
    saveRule: (rule) => invoke('orvex:advanced:ruleSave', rule),
    deleteRule: (id) => invoke('orvex:advanced:ruleDelete', { id }),
    enableRule: (id, enabled) => invoke('orvex:advanced:ruleEnable', { id, enabled }),
    tickRules: () => invoke('orvex:advanced:rulesTick'),
    selfEval: (payload) => invoke('orvex:advanced:eval', payload),
    evalHistory: (limit) => invoke('orvex:advanced:evalHistory', { limit }),
    routeStats: (task, days) => invoke('orvex:advanced:routeStats', { task, days }),
    recommendRoute: (payload) => invoke('orvex:advanced:routeRecommend', payload),
    applyRoute: (task, chain) => invoke('orvex:advanced:routeApply', { task, chain }),
    learning: (status) => invoke('orvex:advanced:learning', { status }),
    mineLearning: (days) => invoke('orvex:advanced:learningMine', { days }),
    approveLearning: (id) => invoke('orvex:advanced:learningApprove', { id }),
    dismissLearning: (id) => invoke('orvex:advanced:learningDismiss', { id }),
    jobs: (limit) => invoke('orvex:advanced:jobs', { limit }),
    job: (id) => invoke('orvex:advanced:job', { id }),
    createJob: (job) => invoke('orvex:advanced:jobCreate', job),
    startJob: (id) => invoke('orvex:advanced:jobStart', { id }),
    pauseJob: (id) => invoke('orvex:advanced:jobPause', { id }),
    resumeJob: (id) => invoke('orvex:advanced:jobResume', { id }),
    cancelJob: (id) => invoke('orvex:advanced:jobCancel', { id }),
    deleteJob: (id) => invoke('orvex:advanced:jobDelete', { id }),
    recovery: () => invoke('orvex:advanced:recovery'),
    resumeRecovery: (payload) => invoke('orvex:advanced:recoveryResume', payload),
    discardRecovery: (kind, id) => invoke('orvex:advanced:recoveryDiscard', { kind, id }),
    collab: {
      agents: () => invoke('orvex:collab:agents'),
      saveAgent: (agent) => invoke('orvex:collab:agentSave', agent),
      deleteAgent: (id) => invoke('orvex:collab:agentDelete', { id }),
      sessions: (limit) => invoke('orvex:collab:sessions', { limit }),
      session: (id) => invoke('orvex:collab:session', { id }),
      start: (payload) => invoke('orvex:collab:start', payload),
      stop: (id) => invoke('orvex:collab:stop', { id }),
      deleteSession: (id) => invoke('orvex:collab:sessionDelete', { id }),
    },
    vision: {
      capture: (args) => invoke('orvex:vision:capture', args),
      ocr: (args) => invoke('orvex:vision:ocr', args),
      analyze: (payload) => invoke('orvex:vision:analyze', payload),
    },
    plugins: {
      list: () => invoke('orvex:plugins:list'),
      installDir: (dir) => invoke('orvex:plugins:installDir', { dir }),
      installCatalog: (id) => invoke('orvex:plugins:installCatalog', { id }),
      catalog: (refresh) => invoke('orvex:plugins:catalog', { refresh }),
      setCatalogUrl: (url) => invoke('orvex:plugins:catalogSet', { url }),
      catalogKeys: () => invoke('orvex:plugins:catalogKeys'),
      setCatalogKeys: (text) => invoke('orvex:plugins:catalogKeysSet', { text }),
      setRequireSignature: (value) => invoke('orvex:plugins:catalogRequire', { value }),
      enable: (id, enabled) => invoke('orvex:plugins:enable', { id, enabled }),
      uninstall: (id) => invoke('orvex:plugins:uninstall', { id }),
    },
    devices: {
      info: () => invoke('orvex:devices:info'),
      setName: (name) => invoke('orvex:devices:name', { name }),
      hostStart: (port) => invoke('orvex:devices:hostStart', { port }),
      hostStop: () => invoke('orvex:devices:hostStop'),
      pairCode: () => invoke('orvex:devices:pairCode'),
      discover: (timeoutMs) => invoke('orvex:devices:discover', { timeoutMs }),
      pair: (payload) => invoke('orvex:devices:pair', payload),
      check: (id) => invoke('orvex:devices:check', { id }),
      pull: (id) => invoke('orvex:devices:pull', { id }),
      push: (id) => invoke('orvex:devices:push', { id }),
      unpair: (id) => invoke('orvex:devices:unpair', { id }),
    },
    a2a: {
      status: () => invoke('orvex:a2a:status'),
      hostStart: (payload) => invoke('orvex:a2a:hostStart', payload || {}),
      hostStop: () => invoke('orvex:a2a:hostStop'),
      rotateToken: () => invoke('orvex:a2a:rotateToken'),
      peerAdd: (payload) => invoke('orvex:a2a:peerAdd', payload || {}),
      peerRemove: (id) => invoke('orvex:a2a:peerRemove', { id }),
      peerCard: (url) => invoke('orvex:a2a:peerCard', { url }),
      send: (payload) => invoke('orvex:a2a:send', payload || {}),
      tasks: (payload) => invoke('orvex:a2a:tasks', payload || {}),
      task: (id) => invoke('orvex:a2a:task', { id }),
      cancel: (id) => invoke('orvex:a2a:cancel', { id }),
    },
    onEvent: (cb) => {
      const handler = (_event, data) => cb(data);
      ipcRenderer.on('orvex:advanced:event', handler);
      return () => ipcRenderer.removeListener('orvex:advanced:event', handler);
    },
  },
  air: {
    onStop: (cb) => {
      const handler = () => cb();
      ipcRenderer.on('orvex:air-stop', handler);
      return () => ipcRenderer.removeListener('orvex:air-stop', handler);
    },
  },
});
