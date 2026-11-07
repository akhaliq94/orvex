export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }

export type OrvexToolResult = { ok: boolean; output: string; error: string | null; ms: number }

export type OrvexAgentProvider = {
  id?: string
  presetId?: string
  name?: string
  baseUrl: string
  apiKey?: string
  api: 'openai' | 'anthropic'
  model: string
}

export type OrvexPlanStep = {
  idx: number
  id: string
  title: string
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'replaced'
  goal?: string
  validate?: string
  readOnly: boolean
  parallelGroup: number
  dependsOn?: string[]
  attempts: number
}

export type OrvexRunRecord = {
  id: string
  goal: string | null
  status: string
  model: string | null
  provider: string | null
  agentId?: string | null
  steps: number
  startedAt: number
  endedAt: number | null
  summary: string | null
  checkpoint?: { mode?: string; status?: string; plan?: OrvexPlanStep[]; replans?: number } | null
}

export type OrvexRunStepRecord = {
  idx: number
  id: string | null
  title: string | null
  goal: string | null
  status: string
  output: string | null
  attempts: number
  error: string | null
  startedAt: number | null
  endedAt: number | null
}

export type OrvexTodoItem = {
  id: number
  title: string
  status: 'open' | 'done'
  createdAt: string
  completedAt: string | null
  reason: string | null
}

export type OrvexDelegateTask = {
  id: string
  agent: string
  goal: string
  status: 'running' | 'done' | 'failed' | 'cancelled'
  result: string | null
  error: string | null
  parentRunId: string
  startedAt: string
  endedAt: string | null
}

export type OrvexAgentEvent =
  | {
      type: 'run_start'
      runId: string
      goal: string
      model: string | null
      provider?: string
      candidates?: { id: string; name: string; model: string }[]
      localModel: string | null
      maxSteps?: number
      mode?: 'agent' | 'orchestrator'
      resumed?: boolean
      plan?: OrvexPlanStep[]
    }
  | { type: 'status'; runId: string; text: string }
  | { type: 'paused'; runId: string }
  | { type: 'resumed'; runId: string }
  | { type: 'assistant'; runId: string; text: string }
  /** Model text as it is written, already passed through the output tripwire. */
  | { type: 'answer_delta'; runId: string; text: string }
  | { type: 'tool_start'; runId: string; id: string; name: string; args: Record<string, unknown> }
  | {
      type: 'approval_request'
      runId: string
      id: string
      name: string
      args: Record<string, unknown>
      reason: string
    }
  | { type: 'approval_result'; runId: string; id: string; name: string; allow: boolean; auto?: boolean }
  | {
      type: 'tool_result'
      runId: string
      id: string
      name: string
      ok: boolean
      output: string
      error: string | null
      ms: number
    }
  | { type: 'compact'; runId: string; model: string; chars: number; to: number }
  | { type: 'context_compacted'; runId: string; removed: number; kept: number; chars: number }
  | { type: 'todos'; runId: string; items: OrvexTodoItem[]; remaining: number; total: number }
  | { type: 'delegate_start'; runId: string; task: OrvexDelegateTask }
  | { type: 'delegate_end'; runId: string; task: OrvexDelegateTask }
  | {
      type: 'delegate_progress'
      runId: string
      id: string
      agent: string
      event: { type: string; [key: string]: unknown }
    }
  | { type: 'plan_created'; runId: string; plan: OrvexPlanStep[]; replanned?: boolean; resumed?: boolean }
  | { type: 'plan_revised'; runId: string; plan: OrvexPlanStep[]; reason: string; replans: number }
  | {
      type: 'step_start'
      runId: string
      idx: number
      id: string
      title: string
      goal: string
      attempt: number
      parallel: boolean
      validate: string
      position: number
      total: number
    }
  | { type: 'step_retry'; runId: string; idx: number; id: string; attempt: number; reason: string; feedback: string }
  | {
      type: 'step_done'
      runId: string
      idx: number
      id: string
      title?: string
      ok: boolean
      skipped?: boolean
      summary: string
      attempts: number
      ms: number
      parallel?: boolean
      unverified?: boolean
    }
  | { type: 'validation'; runId: string; idx: number; id: string; ok: boolean; reason: string; unverified?: boolean; attempt: number }
  | { type: 'error'; runId: string; message: string }
  | {
      type: 'run_end'
      runId: string
      ok: boolean
      cancelled?: boolean
      summary: string
      steps: number
      ms: number
      mode?: 'agent' | 'orchestrator'
      plan?: OrvexPlanStep[]
    }

export type OrvexAuditEntry = {
  ts: string
  kind: string
  runId?: string | null
  tool?: string
  args?: string
  ok?: boolean
  ms?: number
  error?: string
}

export type OrvexEnv = {
  platform: string
  arch: string
  versions: { electron: string; node: string; chrome: string }
  home: string
  userData: string
  auditFile: string
  dev: boolean
  hotkey?: string | null
  approvalTimeoutMs?: number
}

export type OrvexMcpServer = {
  id: string
  name: string
  command: string
  args: string[]
  cwd?: string
  env?: Record<string, string>
  enabled: boolean
  autoApprove: boolean
  timeoutMs: number
  /** Tool names this server may run. Empty/absent lists every tool it advertises. */
  tools?: string[]
}

export type OrvexMcpStatus = {
  id: string
  name: string
  state: 'connecting' | 'ready' | 'error' | 'disabled'
  toolCount: number
  tools: string[]
  listedCount?: number
  hubCount?: number
  blockedCount?: number
  missing?: string[]
  error: string | null
  autoApprove: boolean
}

export type OrvexUsageRow = {
  id?: number
  ts: number
  runId?: string | null
  task?: string | null
  provider?: string | null
  model?: string | null
  promptTokens: number
  completionTokens: number
  tokens: number
  cost: number
  estimated?: number
  ms?: number
  ok?: number
  error?: string | null
}

export type OrvexUsageSummary = {
  since: string | null
  totals: {
    calls: number
    tokens: number
    cost: number
    estimated: number
    failures: number
    avgMs: number
  } | null
  byModel: { provider: string | null; model: string | null; calls: number; promptTokens: number; completionTokens: number; tokens: number; cost: number; estimated: number }[]
  byTask: { task: string; calls: number; tokens: number; cost: number }[]
}

export type OrvexRouteRef = { id?: string; providerId?: string; presetId?: string; model?: string; name?: string }

export type OrvexLLMEvent =
  | { requestId: string; type: 'delta'; text: string; full: string }
  | { requestId: string; type: 'reasoning'; text: string }
  | { requestId: string; type: 'first' }
  | { requestId: string; type: 'usage'; usage: Record<string, unknown> }
  | { requestId: string; type: 'gateway'; event: { type: string; [key: string]: unknown } }
  | {
      requestId: string
      type: 'done'
      text: string
      usage?: Record<string, unknown>
      provider?: { id: string; name: string; model: string }
      model?: string
      ms?: number
    }
  | { requestId: string; type: 'aborted' }
  | { requestId: string; type: 'error'; message: string }

export type OrvexEngineStartPayload = {
  goal: string
  agentId?: string
  provider: OrvexAgentProvider
  candidates?: OrvexAgentProvider[]
  local?: OrvexAgentProvider | null
  autoApprove?: boolean
  maxSteps?: number
  task?: string
  mode?: 'agent' | 'orchestrator'
  /** Send only the essential tools — spoken turns and token-tight providers. */
  compactTools?: boolean
}

export type OrvexCodeWorkspace = {
  root: string | null
  name: string | null
  isGit: boolean
  scripts: { name: string; command: string }[]
  branch: string | null
}

export type OrvexCodeEntry = { path: string; name: string; dir: boolean; size: number }

export type OrvexCodeRead = {
  path: string
  binary: boolean
  size: number
  content: string
  mtime: number
}

export type OrvexCodeSearchMatch = { path: string; line: number; column: number; text: string }

export type OrvexGitEntry = {
  path: string
  from: string | null
  index: string
  worktree: string
  untracked: boolean
  staged: boolean
  unstaged: boolean
}

export type OrvexGitStatus = {
  git: boolean
  branch: string | null
  ahead: number
  behind: number
  entries: OrvexGitEntry[]
}

export type OrvexGitLogEntry = { hash: string; author: string; date: string; subject: string }

export type OrvexCodeRunEvent = {
  runId: string
  type: 'start' | 'data' | 'exit'
  kind?: 'script' | 'terminal'
  command?: string
  cwd?: string
  stream?: 'stdout' | 'stderr'
  chunk?: string
  code?: number | null
  signal?: string | null
  ms?: number
  stopped?: boolean
}

export type OrvexResearchSource = {
  id: string
  n: number
  title: string
  url: string
  host: string
  snippet: string
  status: 'pending' | 'reading' | 'ok' | 'error'
  kind: string
  chars: number
  tables: number
  error: string | null
  used: boolean
  text?: string
}

export type OrvexResearchPlan = {
  engine: 'llm' | 'heuristic' | 'document' | null
  questions: string[]
  queries: string[]
}

export type OrvexResearchCitation = { n: number; title: string; url: string; host: string }

export type OrvexResearchStats = { queries: number; searched: number; fetched: number; failed: number; ms: number }

export type OrvexResearchReport = {
  id: string
  kind: 'research' | 'document'
  query: string
  title: string
  depth: 'quick' | 'standard' | 'deep' | null
  status: 'running' | 'done' | 'failed' | 'cancelled'
  phase?: string | null
  error: string | null
  createdAt: number
  finishedAt: number | null
  provider: { id?: string | null; name: string; model: string } | null
  mode: 'llm' | 'extractive' | 'document' | null
  plan: OrvexResearchPlan
  sources: OrvexResearchSource[]
  citations: OrvexResearchCitation[]
  report: string
  warnings: string[]
  stats: OrvexResearchStats
}

export type OrvexResearchSummary = {
  id: string
  kind: 'research' | 'document'
  query: string
  title: string
  depth: 'quick' | 'standard' | 'deep' | null
  status: 'running' | 'done' | 'failed' | 'cancelled'
  phase?: string | null
  error: string | null
  createdAt: number
  finishedAt: number | null
  provider: { id?: string | null; name: string; model: string } | null
  mode: 'llm' | 'extractive' | 'document' | null
  sources: number
  readable: number
  citations: number
  chars: number
}

export type OrvexResearchTable = { index: number; rows: number; cols: number; markdown: string }

export type OrvexResearchPage = { page: number; chars: number }

export type OrvexResearchDocument =
  | {
      ok: true
      kind: string
      mode: 'markdown' | 'text'
      title: string
      name: string
      text: string
      truncated: boolean
      chars: number
      tables: OrvexResearchTable[]
      pages: OrvexResearchPage[] | null
      pageCount: number | null
      warnings: string[]
      path?: string
      size?: number
      mtime?: number
    }
  | { ok: false; error: string; path?: string; size?: number; mtime?: number }

export type OrvexResearchEvent =
  | { runId: string | null; type: 'entry' | 'done' | 'saved'; entry: OrvexResearchSummary }
  | { runId: string; type: 'plan'; plan: OrvexResearchPlan }
  | { runId: string; type: 'search_start'; query: string }
  | {
      runId: string
      type: 'search'
      query: string
      count: number
      source?: string
      error?: string
      followup?: boolean
    }
  | { runId: string; type: 'sources'; sources: OrvexResearchSource[] }
  | { runId: string; type: 'source'; source: OrvexResearchSource }
  | { runId: string; type: 'progress'; phase: string; done: number; total: number }
  | { runId: string; type: 'delta'; text: string }
  | { runId: string; type: 'error' | 'cancelled'; message: string; entry?: OrvexResearchSummary }

export type OrvexMemoryKind =
  | 'fact'
  | 'preference'
  | 'project'
  | 'person'
  | 'procedure'
  | 'event'
  | 'insight'
  | 'legacy'

export type OrvexMemoryStatus = 'active' | 'superseded' | 'archived' | 'expired'

export type OrvexMemoryItem = {
  id: string
  kind: OrvexMemoryKind
  text: string
  tags: string[]
  importance: number
  source: string | null
  project: string
  status: OrvexMemoryStatus
  pinned: boolean
  createdAt: number
  updatedAt: number
  expiresAt: number | null
  lastUsedAt: number | null
  useCount: number
  meta: Record<string, unknown> | null
}

export type OrvexMemoryHit = OrvexMemoryItem & { score: number; fts: number; cosine: number; overlap: number }

export type OrvexMemoryConflict = {
  id: string
  a: string
  b: string
  kind: OrvexMemoryKind
  project: string
  score: number
  reason: 'similar' | 'negation'
  status: string
  resolution: string | null
  createdAt: number
  resolvedAt: number | null
  itemA: OrvexMemoryItem | null
  itemB: OrvexMemoryItem | null
}

export type OrvexMemoryProfile = {
  name: string
  role: string
  language: string
  timezone: string
  locations: string
  notes: string
  updatedAt: number | null
}

export type OrvexMemoryStats = {
  total: number
  active: number
  pinned: number
  superseded: number
  archived: number
  expired: number
  expiring: number
  projects: { project: string; count: number }[]
  kinds: { kind: OrvexMemoryKind; count: number }[]
  lastUpdated: number | null
  conflicts: number
  links: number
}

export type OrvexMemoryCitation = { n: number; id: string; kind: OrvexMemoryKind; text: string; score: number }

export type OrvexMemoryRagResult = {
  question: string
  answer: string
  mode: 'llm' | 'extractive' | 'empty'
  provider: { id?: string; name?: string; model?: string } | null
  model?: string | null
  citations: OrvexMemoryCitation[]
  hits: OrvexMemoryHit[]
  warning: string | null
}

export type OrvexMemoryGraph = {
  nodes: { id: string; kind: OrvexMemoryKind; text: string; project: string; pinned: boolean }[]
  edges: { source: string; target: string; rel: string; score: number }[]
}

export type OrvexFileRoot = { label: string; path: string }

/* ---------------------------------------------------------- Section 10 media */

export type OrvexMediaKind = 'image' | 'audio' | 'video' | 'model' | 'subtitle' | 'file'

export type OrvexMediaAsset = {
  id: string
  name: string
  kind: OrvexMediaKind
  ext: string
  mime: string
  bytes: number
  createdAt: number
  source: 'generation' | 'edit' | 'upscale' | 'tts' | 'music' | 'subtitles' | 'import' | string
  prompt: string | null
  provider: string | null
  model: string | null
  meta: Record<string, unknown> | null
  url: string
}

export type OrvexMediaLibrary = { total: number; assets: OrvexMediaAsset[] }

export type OrvexMediaInfo = {
  ready: boolean
  error: string | null
  libraryDir: string | null
  assets: number
  prompts: number
}

export type OrvexMediaPrompt = {
  id: string
  title: string
  text: string
  kind: string
  tags: string[]
  favorite: boolean
  uses: number
  createdAt: number
  updatedAt: number
}

export type OrvexMediaSubtitleSegment = { start: number; end: number; text: string }

export type OrvexMediaSubtitles = {
  asset: OrvexMediaAsset
  text: string
  format: 'srt' | 'vtt'
  cues: number
}

export type OrvexMediaTranscribe = {
  text: string
  segments: OrvexMediaSubtitleSegment[]
  language: string | null
  duration: number | null
  endpoint: string
  file: string
}

export type OrvexMediaGenerateResult = {
  assets: OrvexMediaAsset[]
  prompt: string
  provider: string | null
  model: string | null
}

export type OrvexMediaUpscaleResult = {
  asset: OrvexMediaAsset
  from: { width: number; height: number }
  to: { width: number; height: number }
  factor: number
}

export type OrvexMediaSource = { token: string; path: string; name: string; mime: string; bytes: number; url: string }

export type OrvexMediaEvent = { type: 'add' | 'update' | 'delete'; asset?: OrvexMediaAsset; id?: string }

export type OrvexFileEntry = {
  name: string
  path: string
  isDir: boolean
  size: number
  modifiedAt: number
  ext: string
  hidden: boolean
}

export type OrvexFileListing = {
  path: string
  name: string
  parent: string | null
  entries: OrvexFileEntry[]
  dirs: number
  files: number
  totalBytes: number
}

export type OrvexFilePreview = {
  kind: 'text' | 'image' | 'pdf' | 'binary'
  text?: string
  dataUrl?: string
  truncated?: boolean
}

export type OrvexFileMeta = {
  path: string
  name: string
  parent: string | null
  isDir: boolean
  isFile: boolean
  isSymlink: boolean
  size: number
  createdAt: number
  modifiedAt: number
  accessedAt: number
  ext: string
  mime: string
  mode: string
  hidden: boolean
  sha256: string | null
  hashPartial: boolean
  preview: OrvexFilePreview | null
}

export type OrvexFileSearch = {
  root: string
  query: string
  scanned: number
  results: OrvexFileEntry[]
  truncated: boolean
}

export type OrvexFileDuplicateGroup = { sha256: string; size: number; files: OrvexFileEntry[]; wasted: number }

export type OrvexFileDuplicates = {
  root: string
  scanned: number
  groups: OrvexFileDuplicateGroup[]
  duplicateFiles: number
  wasted: number
  tookMs: number
  truncated: boolean
}

export type OrvexFileVersion = {
  id: string
  path: string
  name: string
  bytes: number
  sha256: string
  createdAt: number
  reason: string
  stored: string
}

export type OrvexFileBackup = {
  id: string
  source: string
  name: string
  bytes: number
  sha256: string
  createdAt: number
  stored: string
}

export type OrvexFileWatchEvent = { id: string; type: string; path: string; at: number }

export type OrvexFileWatchStatus = {
  watching: { id: string; path: string; startedAt: number; events: number; last: OrvexFileWatchEvent[] }[]
}

export type OrvexFileWatch = { id: string; path: string; startedAt: number; reused: boolean }

export type OrvexPdfInfo = {
  path: string
  pages: number
  title: string
  author: string
  subject: string
  creator: string
  producer: string
  createdAt: string | null
  modifiedAt: string | null
  bytes: number
}

export type OrvexXlsxInfo = { path: string; bytes: number; sheets: { name: string; ref: string }[] }

export type OrvexXlsxRead = {
  path: string
  sheet: string
  sheets: string[]
  header: string[]
  rows: string[][]
  totalRows: number
  truncated: boolean
}

export type OrvexDiffResult = {
  a: string
  b: string
  lines: { type: 'add' | 'remove' | 'same'; text: string }[]
  added: number
  removed: number
  same: number
  truncated: boolean
  unified: string
}

export type OrvexZipResult = { path: string; bytes: number; entries: number; sources: string[] }

export type OrvexZipEntry = { path: string; size: number; isDir: boolean }

export type OrvexDocxResult = { path: string; bytes: number; paragraphs: number }

export type OrvexDesktopAction = { ok?: boolean; output: string }

export type OrvexDesktopDisplay = { id: number; x: number; y: number; w: number; h: number; primary: boolean }

export type OrvexDesktopScreenInfo = {
  output: string
  bounds: { x: number; y: number; w: number; h: number }
  displays: OrvexDesktopDisplay[]
  cursor: { x: number; y: number }
}

export type OrvexDesktopShot = {
  file: string
  url: string
  width: number
  height: number
  display: number
  origin: { x: number; y: number }
}

export type OrvexDesktopCapture = {
  output: string
  image: string
  file?: string
  url: string
  width?: number
  height?: number
  display?: number | null
  files: OrvexDesktopShot[]
  displays?: number
  origin?: { x: number; y: number }
  offset?: { x: number; y: number }
}

export type OrvexDesktopOcrWord = { text: string; x: number; y: number; w: number; h: number }

export type OrvexDesktopOcrLine = OrvexDesktopOcrWord & { words?: OrvexDesktopOcrWord[] }

export type OrvexDesktopOcr = {
  output: string
  file: string
  url: string
  image: string | null
  lines: OrvexDesktopOcrLine[]
  text: string
  lang: string
  width: number
  height: number
}

export type OrvexDesktopWindow = {
  hwnd: number
  pid: number
  title: string
  cls: string
  state: string
  x: number
  y: number
  w: number
  h: number
  foreground: boolean
}

export type OrvexDesktopProcess = {
  pid: number
  name: string
  cpu: number
  memMB: number
  title?: string
  started?: string
}

export type OrvexDesktopUiNode = {
  path: string
  name: string
  type: string
  id?: string
  enabled?: boolean
  offscreen?: boolean
  x?: number
  y?: number
  w?: number
  h?: number
  patterns?: string[]
  children?: OrvexDesktopUiNode[]
}

export type OrvexDesktopUiTree = {
  output: string
  tree: OrvexDesktopUiNode | null
  nodes: number
  depth: number
  title: string
  handle: number
}

export type OrvexDesktopApp = { name: string; appId: string }

export type OrvexScreenMatch = {
  source: 'uia' | 'ocr'
  name: string
  type: string
  path: string
  x: number
  y: number
  w: number
  h: number
  cx: number
  cy: number
  handle?: number | null
  window?: string
}

export type OrvexScreenFind = {
  output: string
  found: boolean
  matches: OrvexScreenMatch[]
  target: { hwnd: number; title: string; pid?: number | null } | null
  image?: string | null
}

export type OrvexHandsStep = {
  step: number
  what: string
  action?: string
  ok: boolean
  output?: string
  error?: string
  note?: string
  ms?: number
}

export type OrvexHandsResult = {
  ok: boolean
  output?: string
  error?: string
  completed: boolean
  note?: string
  goal: string
  steps: OrvexHandsStep[]
  done?: number
  attempted?: number
}

export type OrvexGameRegion = { x: number; y: number; width: number; height: number }
export type OrvexGameAction = { key: string; label: string }
export type OrvexGameMacroStep = { keys: string; waitMs: number }

export type OrvexGameProfile = {
  id: string
  name: string
  windowTitle: string
  goal: string
  policy: 'vision' | 'macro'
  actions: OrvexGameAction[]
  macro: OrvexGameMacroStep[]
  region: OrvexGameRegion | null
  scoreRegion: OrvexGameRegion | null
  scoreRegex: string
  targetScore: number | null
  intervalMs: number
  actMs: number
  reuseOnIdle: boolean
  maxMinutes: number
  autoFocus: boolean
  display: string
  createdAt?: number
  updatedAt?: number
}

export type OrvexGameHistory = { at: number; tick: number; score: number | null; action: string; note: string }

export type OrvexGameStatus = {
  running: boolean
  runId?: string
  profileId?: string
  name?: string
  goal?: string
  policy?: string
  startedAt?: number
  endsAt?: number
  endedAt?: number
  ticks?: number
  reused?: number
  bestScore?: number | null
  lastScore?: number | null
  targetScore?: number | null
  lastAction?: string
  lastNote?: string
  stopReason?: string | null
  stopReasonLabel?: string
  error?: string | null
  window?: { title: string; hwnd: number; pid?: number } | null
  history?: OrvexGameHistory[]
  hotkey: string
  hotkeyRegistered?: boolean
  nextTickAt?: number
  recorded?: boolean
  recordError?: string
}

export type OrvexGameEvent = OrvexGameStatus & { type: 'started' | 'tick' | 'finished' }

export type OrvexDesktopBattery = { present: boolean; percent: number | null; status: number; charging: boolean }

export type OrvexDesktopStatus = {
  output: string
  hostname: string
  user: string
  platform: string
  arch: string
  release: string
  uptimeSec: number
  cpu: string
  cores: number
  memory: { total: number; free: number; used: number }
  load: number[]
  node: string
  electron: string | null
  displays: number
  addresses: { name: string; address: string }[]
  battery: OrvexDesktopBattery | null
  volume: number | null
  muted: boolean
  brightness: number | null
}

export type OrvexDesktopVolume = { supported: boolean; volume: number | null; muted: boolean; output: string }

export type OrvexDesktopBrightness = { supported: boolean; level: number | null; output: string }

export type OrvexDesktopClipboard = {
  output: string
  kind: 'text' | 'image' | 'empty'
  text: string
  formats: string[]
  file: string | null
  url: string
  image?: string
  width?: number
  height?: number
}

export type OrvexDesktopRecording = {
  output: string
  file: string | null
  url?: string
  bytes?: number
  seconds?: number
  display?: number | null
  fps?: number
  audio?: string
  startedAt?: number
  active?: boolean
  error?: string | null
}

export type OrvexDesktopSource = {
  token: string
  path: string
  name: string
  mime: string
  bytes: number
  url: string
}

/* ------------------------------------------------- Section 12 integrations */

export type OrvexIntegrationField = { key: string; label: string; placeholder?: string; default?: string; type?: string }

export type OrvexIntegrationSecret = { key: string; label: string; required?: boolean }

export type OrvexIntegrationAction = { id: string; label: string; fields?: OrvexIntegrationField[] }

export type OrvexIntegrationKind = {
  id: string
  label: string
  hint: string
  fields: OrvexIntegrationField[]
  secrets: OrvexIntegrationSecret[]
  actions: OrvexIntegrationAction[]
}

export type OrvexIntegrationSchema = {
  kinds: OrvexIntegrationKind[]
  limits: { httpBytes: number; webhookBytes: number; dbRows: number }
}

export type OrvexIntegrationConnection = {
  id: string
  kind: string
  label: string
  config: Record<string, string>
  secretSet: Record<string, boolean>
  createdAt: string
  updatedAt: string
  lastTest: { ok: boolean; output: string; ts: string } | null
}

export type OrvexIntegrationList = { connections: OrvexIntegrationConnection[]; schema: OrvexIntegrationSchema }

export type OrvexIntegrationRun = {
  ok: boolean
  output: string
  connection?: OrvexIntegrationConnection
  rows?: Record<string, unknown>[]
  columns?: string[]
  events?: OrvexWebhookEvent[]
  health?: OrvexIntegrationHealth
  [key: string]: unknown
}

export type OrvexIntegrationHealthConn = {
  id: string
  label: string
  kind: string
  state: 'untested' | 'ok' | 'error'
  lastTest: { ok: boolean; output: string; ts: string } | null
  secretsMissing: string[]
}

export type OrvexIntegrationHealth = {
  connections: OrvexIntegrationHealthConn[]
  webhook: OrvexWebhookStatus
  checkedAt: string
}

export type OrvexConnectorParam = {
  name: string
  in: 'path' | 'query' | 'header'
  required: boolean
  type: string
  description: string
}

export type OrvexConnectorBody = {
  required: boolean
  properties: { name: string; type: string; required: boolean; description: string }[]
}

export type OrvexConnectorOperation = {
  id: string
  method: string
  path: string
  summary: string
  description: string
  deprecated: boolean
  params: OrvexConnectorParam[]
  body: OrvexConnectorBody | null
}

export type OrvexConnector = {
  id: string
  label: string
  sourceUrl: string
  specTitle: string
  specVersion: string
  baseUrl: string
  auth: { type: 'none' | 'bearer' | 'header' | 'query'; name: string }
  secretSet: boolean
  truncated: boolean
  operationCount: number
  ops: OrvexConnectorOperation[]
  createdAt: string
  updatedAt: string
}

export type OrvexConnectorPreview = {
  ok: boolean
  title: string
  version: string
  format: string
  baseUrl: string
  ops: OrvexConnectorOperation[]
  truncated: boolean
  sourceUrl: string
}

export type OrvexConnectorResult = {
  ok: boolean
  output?: string
  error?: string | null
  status?: number
  url?: string
  method?: string
  body?: string
  json?: unknown
  bytes?: number
  truncated?: boolean
  ms?: number
}

export type OrvexMakerPalette = {
  seed: string
  brand: string
  brandSoft: string
  accent: string
  ink: string
  body: string
  muted: string
  paper: string
  surface: string
  line: string
  success: string
  warning: string
  danger: string
}

export type OrvexMakerTemplate = {
  id: string
  label: string
  description: string
  kind: string
  previewable: boolean
}

export type OrvexMakerProject = {
  id: string
  name: string
  slug: string
  template: string
  title: string
  description: string
  dir: string
  createdAt: string
  updatedAt: string
  files: string[]
  palette: OrvexMakerPalette
  kind: string
  previewUrl: string | null
}

export type OrvexMakerFile = { path: string; name: string; dir: boolean; size?: number }

export type OrvexMakerFileContent = {
  project: OrvexMakerProject
  path: string
  binary: boolean
  size: number
  content: string | null
}

export type OrvexMakerRun = {
  ok: boolean
  code?: number
  error?: string
  stdout: string
  stderr: string
  project: OrvexMakerProject
}

export type OrvexAdvisorSeverity = 'critical' | 'high' | 'medium' | 'low'

export type OrvexAdvisorAction = { label: string; target: string; tab?: string }

export type OrvexAdvisorSuggestion = {
  id: string
  severity: OrvexAdvisorSeverity
  title: string
  detail: string
  action: OrvexAdvisorAction | null
  score: number
  rank: number
  count?: number
  url?: string
}

export type OrvexAdvisorBudget = {
  dailyUsd: number
  monthlyUsd: number
  todayUsd: number
  monthUsd: number
  dailyPct: number | null
  monthlyPct: number | null
  remainingTodayUsd: number | null
  remainingMonthUsd: number | null
  dailyReached: boolean
  monthlyReached: boolean
  dailyNear: boolean
  monthlyNear: boolean
}

export type OrvexAdvisorBrief = {
  at: number
  date: string
  version: string
  headline: string
  stats: {
    runsToday: number
    runsDone: number
    runsFailed: number
    runsRunning: number
    successRate: number | null
    spendToday: number
    spendMonth: number
    unread: number
    episodes: number | null
    backups: number | null
    lastBackupAt: number | null
    crashes24h: number
    suggestions: number
    dismissed: number
  }
  budget: OrvexAdvisorBudget
  highlights: string[]
  top: OrvexAdvisorSuggestion[]
  itemsCount: number
  dismissed: number
}

export type OrvexAdvisorSuggestions = {
  at: number
  items: OrvexAdvisorSuggestion[]
  dismissed: number
}

export type OrvexAdvisorUpdateResult = {
  configured: boolean
  ok: boolean
  current: string
  feedUrl: string
  checkedAt: number
  available: boolean
  latest?: string | null
  url?: string
  notes?: string
  publishedAt?: string
  error?: string | null
  note?: string
}

export type OrvexAdvisorUpdateInfo = {
  feedUrl: string
  last: OrvexAdvisorUpdateResult | null
}

export type OrvexUpdaterAsset = {
  name: string
  size: number
  url: string
  digest: string
  kind: 'setup' | 'portable' | 'other'
}

export type OrvexUpdaterChecksums = {
  name: string
  size: number
  url: string
}

export type OrvexUpdaterDownload = {
  status: 'ready'
  name: string
  path: string
  bytes: number
  verified: boolean
  hash: string
  hashSource: string
  at: number
}

export type OrvexUpdaterCheck = {
  current: string
  portable: boolean
  checkedAt: number
  ok: boolean
  configured: boolean
  available: boolean
  latest: string | null
  name?: string
  url?: string
  notes?: string
  publishedAt?: string
  prerelease?: boolean
  assets?: OrvexUpdaterAsset[]
  asset?: OrvexUpdaterAsset | null
  checksums?: OrvexUpdaterChecksums | null
  missing?: string
  download?: OrvexUpdaterDownload | null
  error?: string | null
}

export type OrvexUpdaterState = {
  repo: string
  autoCheck: boolean
  current: string
  portable: boolean
  packaged: boolean
  last: OrvexUpdaterCheck | null
}

export type OrvexUpdaterEvent = {
  phase: 'check' | 'download' | 'ready' | 'install' | 'available'
  name?: string
  received?: number
  total?: number
  pct?: number | null
  download?: OrvexUpdaterDownload
  result?: OrvexUpdaterCheck
}

export type OrvexHttpResult = {
  ok: boolean
  url: string
  method: string
  status: number
  statusText: string
  headers: Record<string, string>
  body: string
  json: unknown
  bytes: number
  truncated: boolean
  ms: number
}

export type OrvexWsResult = { ok: boolean; url: string; messages: unknown[]; sent: unknown; ms: number; closedBy: string }

export type OrvexWebhookStatus = {
  running: boolean
  port: number | null
  url: string | null
  startedAt: string | null
  events: number
  requests: number
  autostart: boolean
}

export type OrvexWebhookEvent = {
  id: string
  ts: string
  method: string
  path: string
  query: Record<string, string>
  headers: Record<string, string>
  body: unknown
  bytes: number
  remote: string
}

export type OrvexOAuthProvider = {
  id: string
  label: string
  scopes: string[]
  pkce: boolean
  device: boolean
  hint: string
}

export type OrvexOAuthAccount = {
  id: string
  provider: string
  providerLabel: string
  label: string
  email: string
  name: string
  scopes: string[]
  authType: string
  createdAt: string
  updatedAt: string
  tokenState: 'ready' | 'renewing'
}

export type OrvexOAuthFlow = {
  id: string
  kind: 'device' | 'pkce'
  provider: string
  status: 'pending' | 'done' | 'error' | 'denied' | 'expired' | 'cancelled'
  startedAt: string
  userCode: string | null
  verificationUrl: string | null
  authUrl: string | null
  redirectUri: string | null
  expiresIn: number | null
  error: string | null
  accountId: string | null
  label: string
  hint: string
}

export type OrvexOAuthState = {
  providers: OrvexOAuthProvider[]
  accounts: OrvexOAuthAccount[]
  flows: OrvexOAuthFlow[]
}

export type OrvexOAuthTokenState = {
  id: string
  connected: boolean
  scope?: string
  hasRefresh?: boolean
  tokenType?: string
  expiresAt?: string | null
  expiresIn?: number | null
  tokenState?: 'valid' | 'expired'
}

export type OrvexOAuthCheck = {
  id: string
  ok: boolean
  refreshed: boolean
  tokenState: 'valid' | 'expired'
  expiresAt: string | null
  expiresIn: number | null
}

export type OrvexToolPermission = {
  name: string
  description: string
  source: string
  policy: 'default' | 'allow' | 'ask' | 'deny'
}

export type OrvexPermissionFloor = {
  id: string
  tool: string
  pattern: string
  note: string
  addedAt: string
}

export type OrvexPermissionsState = {
  policies: Record<string, string>
  tools: OrvexToolPermission[]
  floors: OrvexPermissionFloor[]
  counts: { allow: number; ask: number; deny: number; floors: number; total: number }
}

export type OrvexEscalationRule = {
  id: string
  tool: string
  pattern: string
  reason: string
  status: 'active' | 'suggested'
  source: 'manual' | 'observed'
  hits: number
  evidence: number
  createdAt: string
}

export type OrvexApprovalAdvisorState = {
  rules: OrvexEscalationRule[]
  counts: { active: number; suggested: number; total: number }
  note: string
}

export type OrvexMcpServerStatus = {
  running: boolean
  enabled: boolean
  port: number | null
  url: string | null
  endpoint: string | null
  token: string | null
  authHeader: string | null
  allowRisky: boolean
  protocolVersion: string
  startedAt: string | null
  requests: number
  toolCalls: number
  sessions: number
  lastError: string | null
}

export type OrvexWorkflowNodeType = 'trigger' | 'tool' | 'condition' | 'loop' | 'delay' | 'notify' | 'approval' | 'transform'

export type OrvexWorkflowNodeConfig = {
  type?: 'manual' | 'schedule'
  cron?: string
  tool?: string
  args?: Record<string, unknown>
  retry?: { attempts: number; delayMs: number }
  onError?: 'stop' | 'continue'
  left?: string
  operator?: string
  right?: string
  mode?: 'count' | 'lines'
  count?: number
  source?: string
  itemVar?: string
  ms?: number
  title?: string
  message?: string
  template?: string
}

export type OrvexWorkflowNode = {
  id: string
  type: OrvexWorkflowNodeType
  label: string
  position: { x: number; y: number }
  config: OrvexWorkflowNodeConfig
}

export type OrvexWorkflowEdge = {
  id: string
  source: string
  target: string
  when: 'next' | 'true' | 'false' | 'body' | 'done'
}

export type OrvexWorkflowRunStatus =
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export type OrvexWorkflowRunSummary = {
  id: string
  workflowId: string
  workflowName: string
  status: OrvexWorkflowRunStatus
  trigger: string
  queuedAt: number
  startedAt: number | null
  endedAt: number | null
  steps: number
  error: string | null
  suspended: { nodeId: string; kind: 'tool' | 'approval'; tool?: string; reason: string; title: string; at: number } | null
  cancelRequested: boolean
  output: string
}

export type OrvexWorkflowRunStep = {
  nodeId: string
  label: string
  type: OrvexWorkflowNodeType
  at: number
  ok: boolean
  output: string
  error: string | null
  ms: number
  attempts?: number
  when?: 'true' | 'false'
  left?: string
  right?: string
  iteration?: number
  total?: number
  item?: string | null
}

export type OrvexWorkflow = {
  id: string
  name: string
  description: string
  enabled: boolean
  nodes: OrvexWorkflowNode[]
  edges: OrvexWorkflowEdge[]
  trigger: { type: 'manual' | 'schedule'; cron?: string }
  createdAt: number
  updatedAt: number
  nextRunAt: number | null
  nextRun: string | null
  lastRun: OrvexWorkflowRunSummary | null
}

export type OrvexWorkflowDraft = {
  id?: string
  name: string
  description?: string
  enabled?: boolean
  nodes: OrvexWorkflowNode[]
  edges: OrvexWorkflowEdge[]
}

export type OrvexWorkflowRun = OrvexWorkflowRunSummary & {
  input: Record<string, unknown>
  steps: OrvexWorkflowRunStep[]
  outputs: Record<string, { ok: boolean; output: string; error: string | null }>
  summary: OrvexWorkflowRunSummary
  workflow: OrvexWorkflow | null
}

export type OrvexWorkflowState = {
  workflows: OrvexWorkflow[]
  runs: OrvexWorkflowRunSummary[]
  stats: {
    workflows: number
    enabled: number
    scheduled: number
    queued: number
    running: number
    awaiting: number
    interrupted: number
    failed: number
  }
  concurrency: number
}

export type OrvexWorkflowTemplate = {
  id: string
  name: string
  description: string
  workflow: Omit<OrvexWorkflowDraft, 'id'> & { trigger: { type: 'manual' | 'schedule'; cron?: string } }
}

export type OrvexSystemMetrics = {
  ok: boolean
  at: number
  cpuPercent: number | null
  cores: number
  cpuModel: string
  memory: { total: number; free: number; used: number; percent: number | null }
  disk: { mount: string; total: number; free: number; used: number; percent: number } | null
  gpu: {
    available: boolean
    pending?: boolean
    name?: string
    percent?: number
    memoryUsed?: number | null
    memoryTotal?: number | null
    reason?: string
  }
  uptimeSec: number
  load: number[]
}

export type OrvexDashboardActivity = {
  ts: number
  kind: string
  tool: string | null
  args: string | null
  ok: number | null
  ms: number | null
  error: string | null
  runId: string | null
}

export type OrvexDashboardSnapshot = {
  at: number
  startedAt: number
  metrics: OrvexSystemMetrics
  system: {
    hostname: string
    user: string
    platform: string
    arch: string
    release: string
    cpu: string
    cores: number
    uptimeSec: number
    battery: OrvexDesktopBattery | null
    volume: number | null
    muted: boolean
    brightness: number | null
    displays: number
  }
  agent: {
    running: boolean
    paused: boolean
    runId: string | null
    goal: string | null
    agentId: string | null
    mode: string | null
  }
  workflows: { stats: OrvexWorkflowState['stats']; runs: OrvexWorkflowRunSummary[]; concurrency: number }
  runs: OrvexRunRecord[]
  activity: OrvexDashboardActivity[]
  usage: OrvexUsageSummary | null
  security: { role: string; roleLabel: string; hasPin: boolean; locked: boolean; stopped: boolean; stopReason: string | null }
  counts: {
    memory: { total: number; active: number; pinned: number; conflicts: number } | null
    media: { assets: number; prompts: number; ready: boolean } | null
    research: number | null
    connections: number | null
  }
}

export type OrvexAppPrefs = {
  launchAtLogin: boolean
  closeToTray: boolean
  packaged: boolean
  version?: string
  userData?: string
}

export type OrvexWindowState = {
  available: boolean
  visible: boolean
  focused: boolean
  minimized: boolean
  maximized: boolean
  fullscreen: boolean
  alwaysOnTop: boolean
  miniOpen: boolean
  miniVisible: boolean
  hotkey: string | null
  closeToTray: boolean
}

export type OrvexWindowAction =
  | 'state'
  | 'minimize'
  | 'maximize'
  | 'restore'
  | 'hide'
  | 'close'
  | 'showMain'
  | 'quit'
  | 'openMini'
  | 'closeMini'
  | 'toggleMini'
  | 'navigate'

export type OrvexNotifyPayload = {
  title: string
  body: string
  kind?: string
  target?: string
  runId?: string
  at?: number
}

export type OrvexWorkflowToolMeta = {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export type OrvexSecurityRole = 'owner' | 'operator' | 'viewer'

export type OrvexSecurityStatus = {
  role: OrvexSecurityRole
  roleLabel: string
  hasPin: boolean
  locked: boolean
  lockReason: string | null
  pinUpdatedAt: string | null
  attempts: number
  maxAttempts: number
  lockedUntil: number
  lockoutMs: number
  autolockMinutes: number
  command: { mode: 'blocklist' | 'allowlist'; allow: string[] }
  network: { mode: 'all' | 'allowlist'; hosts: string[] }
  sandbox: { shell: boolean }
  rate: { enabled: boolean; perMinute: number; perToolPerMinute: number }
  emergency: { stopped: boolean; reason: string | null; at: number | null }
  updatedAt: string | null
  dataDir: string | null
  backups: string | null
  atRest: { available: boolean; label: string; storeFile: string | null; exists: boolean }
  permissionCounts: { allow: number; ask: number; deny: number; total: number }
  secretCount: number
}

export type OrvexSecretSummary = {
  file: string | null
  exists: boolean
  encrypted: boolean
  bytes: number
  updatedAt: number | null
  ids: string[]
  count: number
  encryption: string
  storeFile: string | null
}

export type OrvexSecurityBackup = {
  id: string
  name: string
  size: number
  at: number
  encrypted: boolean
  note?: string
  files?: string[]
}

/* ------------------------------------------------ Section 15: monitoring */

export type OrvexMonitorSample = {
  ts: number
  cpu: number | null
  mem: number | null
  disk: number | null
  gpu: number | null
  netIn: number | null
  netOut: number | null
  appProcs: number | null
  appCpu: number | null
  appMemMB: number | null
  uptimeSec: number | null
}

export type OrvexMonitorPoint = {
  t: number
  cpu: number | null
  mem: number | null
  disk: number | null
  gpu: number | null
  netIn: number | null
  netOut: number | null
  appCpu: number | null
  appMemMB: number | null
  samples: number
}

export type OrvexMonitorSeries = { minutes: number; bucketMs: number; points: OrvexMonitorPoint[] }

export type OrvexMonitorCrash = {
  id: number
  at: number
  atIso: string | null
  pid: number | null
  startedAt: number | null
  sessionId: string | null
  reason: string | null
}

export type OrvexMonitorOverview = {
  at: number
  session: { id: string | null; pid: number; startedAt: number; uptimeSec: number; version: string | null }
  latest: OrvexMonitorSample | null
  series: OrvexMonitorSeries
  app: { pid: number; type: string; cpu: number | null; memMB: number | null }[]
  appTotals: { processes: number; cpu: number | null; memMB: number | null }
  today: { calls: number; tokens: number; cost: number; estimated: number; failures: number; avgMs: number } | null
  db: { ready: boolean; file: string | null; bytes: number | null }
  crashes: OrvexMonitorCrash | null
  sampleMs: number
  lastSampleAt: number | null
}

export type OrvexMonitorUsagePoint = {
  t: number
  at: string | null
  calls: number
  promptTokens: number
  completionTokens: number
  tokens: number
  cost: number
  estimated: number
  failures: number
  avgMs: number
}

export type OrvexMonitorUsage = {
  at: number
  windowMs: number
  since: string | null
  totals: OrvexUsageSummary['totals']
  byModel: OrvexUsageSummary['byModel']
  byTask: OrvexUsageSummary['byTask']
  byProvider: { provider: string; calls: number; tokens: number; cost: number; estimated: number; failures: number }[]
  series: { sinceMs: number; bucketMs: number; points: OrvexMonitorUsagePoint[] }
  recent: OrvexUsageRow[]
  budget: { dailyUsd: number; todayUsd: number; remainingUsd: number | null }
  db: { ready: boolean; file: string | null; error: string | null }
}

export type OrvexMonitorTraceRun = {
  id: string
  goal: string | null
  status: string
  model: string | null
  provider: string | null
  agentId: string | null
  steps: number
  startedAt: number
  endedAt: number | null
  summary: string | null
  stepCount: number
  toolCalls: number
  modelCalls: number
  modelFailures: number
  tokens: number
  cost: number
  startedAtIso: string | null
  endedAtIso: string | null
  durationMs: number | null
}

export type OrvexMonitorSpan = {
  id: string
  kind: 'run' | 'step' | 'tool' | 'model'
  label: string
  start: number
  end: number
  ms: number
  ok: boolean | null
  detail: string
  tokens?: number | null
  cost?: number | null
  estimated?: boolean
  stepIdx?: number
  status?: string
}

export type OrvexMonitorTraceDetail = {
  run: OrvexRunRecord
  spans: OrvexMonitorSpan[]
  totals: { steps: number; tools: number; models: number; tokens: number; cost: number; toolFailures: number; modelFailures: number }
  at: number
}

export type OrvexMonitorCompareResult = {
  id: string
  name: string
  model: string
  ok: boolean
  text?: string
  chars?: number
  ms: number
  error?: string
  usage?: {
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
    costUsd?: number
    estimated?: boolean
  } | null
  provider?: { id: string; name: string; model: string } | null
}

export type OrvexMonitorCompare = {
  at: number
  prompt: string
  system: string | null
  results: OrvexMonitorCompareResult[]
  summary: { candidates: number; ok: number; failed: number; fastestMs: number | null; tokens: number; cost: number }
}

export type OrvexMonitorHealthCheck = { id: string; label: string; status: 'ok' | 'warn' | 'fail'; detail: string }

export type OrvexMonitorHealth = {
  at: number
  checks: OrvexMonitorHealthCheck[]
  summary: { ok: number; warn: number; fail: number; total: number }
}

export type OrvexMonitorRecoverableRun = {
  id: string
  goal: string | null
  status: string
  steps: number
  startedAt: number
  startedAtIso: string | null
  endedAt: number | null
  summary: string | null
}

export type OrvexMonitorRecoverableWorkflow = {
  id: string
  workflowId: string
  workflowName: string
  status: string
  queuedAt: string | null
  startedAt: string | null
  steps: number
  canResume: boolean
}

export type OrvexMonitorRecoverables = {
  at: number
  runs: OrvexMonitorRecoverableRun[]
  workflows: OrvexMonitorRecoverableWorkflow[]
  crashes: OrvexMonitorCrash[]
  lastCrash: OrvexMonitorCrash | null
  interrupted: number
}

export type OrvexEvalCheck = { name: string; ok: boolean; detail?: string }

export type OrvexEvalCase = {
  id: string
  prompt: string
  system?: string
  checks: { contains?: string[]; notContains?: string[]; regex?: string[]; json?: boolean; maxMs?: number }
}

export type OrvexEvalSuite = {
  id: string
  name: string
  cases: OrvexEvalCase[]
  createdAt: number
  updatedAt: number
  caseCount: number
}

export type OrvexEvalDetail = {
  caseId: string
  provider: string
  model: string
  ms: number
  checks: OrvexEvalCheck[]
  output: string
  usage?: Record<string, unknown> | null
  error: string | null
}

export type OrvexEvalRow = {
  id: string
  suite: string
  caseId: string
  ok: boolean
  score: number
  detail: OrvexEvalDetail | null
  at: number
  atIso: string | null
}

export type OrvexEvalRunResult = {
  suite: { id: string; name: string }
  at: number
  rows: { caseId: string; ok: boolean; score: number; provider: string; model: string; ms: number; at: string; detail: OrvexEvalDetail }[]
  summary: { runs: number; passed: number; failed: number; score: number; candidates: string[]; avgMs: number }
}

export type OrvexProductivityPythonInfo = {
  available: boolean
  command?: string
  prefix?: string[]
  version?: string
  error?: string
}

export type OrvexProductivityCalc = { expression: string; value: number; display: string }

export type OrvexProductivityPythonRun = {
  command: string
  version: string
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  ms: number
  stdout: string
  stderr: string
  truncated: boolean
}

export type OrvexProductivityColumn = {
  name: string
  index: number
  type: 'number' | 'date' | 'text' | 'empty'
  nonEmpty: number
  missing: number
  unique: number
  top: { value: string; count: number }[]
  min?: number
  max?: number
  sum?: number
  mean?: number
  median?: number
  stddev?: number
}

export type OrvexProductivityAnalysis = {
  path: string
  bytes: number
  sheets: string[]
  sheet: string
  rows: number
  totalRows: number
  truncated: boolean
  columns: OrvexProductivityColumn[]
  sample: (string | number)[][]
  headers: string[]
}

export type OrvexProductivityChart = {
  path: string
  sheet: string
  kind: 'bar' | 'line' | 'pie' | 'scatter'
  x: string
  y: string
  agg?: string
  points: { label: string; value: number; x?: number; y?: number; count?: number }[]
  groups?: number
  truncated: boolean
}

export type OrvexProductivitySheet = {
  path: string
  bytes: number
  sheets: string[]
  sheet: string
  headers: string[]
  rows: (string | number)[][]
  totalRows: number
  truncated: boolean
}

export type OrvexProductivitySheetSave = {
  path: string
  sheet?: string
  bytes: number
  rows?: number
  columns?: number
  sheets: string[]
}

export type OrvexProductivitySqlResult = {
  kind: 'read' | 'write'
  columns: string[]
  rows: (string | number | null)[][]
  changes?: number
  lastInsertRowid?: number
  returned?: number
  truncated?: boolean
  ms: number
}

export type OrvexProductivityBlock =
  | { type: 'heading'; text: string; level?: number }
  | { type: 'text'; text: string }
  | { type: 'list'; items: string[] }
  | { type: 'kv'; items: { label: string; value: string }[] }
  | { type: 'table'; headers: string[]; rows: (string | number)[][] }
  | { type: 'chart'; kind?: string; x?: string; y?: string; points: { label: string; value: number }[] }
  | { type: 'code'; text: string }
  | { type: 'divider' }

export type OrvexProductivityReport = {
  path: string
  format: 'md' | 'html' | 'docx'
  bytes: number
  blocks: number
  preview: string
}

export type OrvexProductivityTranscript = {
  path: string
  text: string
  segments: { start: number; end: number; text: string }[]
  language: string | null
  duration: number | null
  endpoint: string
}

export type OrvexProductivityMeetingRequest = {
  title?: string
  transcript?: string
  audioPath?: string
  language?: string
  asr?: { url?: string; key?: string; model?: string }
  project?: string
}

export type OrvexProductivityMeeting = {
  title: string
  summary: string
  decisions: string[]
  actionItems: { task: string; owner: string; due: string }[]
  topics: string[]
  transcript: string
  transcriptChars: number
  transcriptTruncated: boolean
  language: string | null
  duration: number | null
  segments: { start: number; end: number; text: string }[]
  model: string | null
  usage: unknown
  path: string
  reportPath: string
  remembered: boolean
  warnings: string[]
  generatedAt: number
}

export type OrvexProductivityNote = {
  id: string
  title: string
  body: string
  tags: string[]
  project: string
  pinned: boolean
  createdAt: number
  updatedAt: number
  score?: number
}

export type OrvexProductivityTask = {
  id: string
  title: string
  notes: string
  status: 'open' | 'done'
  priority: number
  dueAt: number | null
  project: string
  createdAt: number
  updatedAt: number
  completedAt: number | null
}

export type OrvexProductivityTaskStats = {
  open: number
  done: number
  total: number
  overdue: number
  dueSoon: number
}

export type OrvexProductivityTranslation = {
  text: string
  source: string
  target: string
  model: string | null
  usage: unknown
  ms: number
}

export type OrvexProductivityTextFile = {
  name: string
  bytes: number
  mtime: number
  path?: string
  text?: string
}

export type OrvexProductivitySlides = {
  path: string
  bytes: number
  slides: number
  theme: 'dark' | 'light'
  title: string
}

export type OrvexProductivityCompare = {
  a: { path: string; name: string; chars: number; truncated: boolean }
  b: { path: string; name: string; chars: number; truncated: boolean }
  lines: { type: 'add' | 'remove' | 'same'; text: string }[]
  added: number
  removed: number
  same: number
  changed: boolean
  truncated: boolean
  unified: string
}

export type OrvexProductivityArtifact = {
  name: string
  path: string
  kind: string
  bytes: number
  mtime: number
}

export type OrvexProductivityCapabilities = {
  python: OrvexProductivityPythonInfo
  xlsx: boolean
  docx: boolean
  pptx: boolean
  sqlite: boolean
  stt: boolean
  model: boolean
  memory: boolean
  dirs: {
    root: string
    reports: string
    slides: string
    sheets: string
    texts: string
    meetings: string
    tmp: string
  }
}

export type OrvexAdvancedMode = 'cloud' | 'local-first' | 'hybrid' | 'offline'

export type OrvexAdvancedModeStatus = {
  mode: OrvexAdvancedMode
  online: boolean
  modes: OrvexAdvancedMode[]
  hostedAllowed: boolean
  localOnly: boolean
  updatedAt: number
}

export type OrvexAdvancedStatus = {
  mode: OrvexAdvancedModeStatus
  rules: number
  rulesFired: number
  jobs: number
  interruptedJobs: number
  suggestions: number
  selfEvals: number
  lastTick: {
    at: number
    rules: number
    fired: number
    signals: {
      at: number
      idleSec: number | null
      clipboard: string | null
      cpuPercent: number | null
      memoryPercent: number | null
      diskPercent: number | null
      interrupted: number
    }
  } | null
  version: string
}

export type OrvexAdvancedContext = {
  at: number
  mode: OrvexAdvancedMode
  online: boolean
  activeWindow: { title: string; cls: string; pid: number; state: string } | null
  windowCount?: number
  windowError?: string
  clipboard: { kind: string; text: string; file: string | null } | null
  clipboardError?: string
  metrics: { cpuPercent: number | null; memoryPercent: number | null; diskPercent: number | null } | null
  interrupted: number
  recentRuns: { id: string; goal: string; status: string; steps: number; startedAt: number }[]
}

export type OrvexAdvancedSuggestion = {
  id: string
  title: string
  why: string
  action: { type: string; page?: string; [key: string]: unknown }
  source?: string
}

export type OrvexProactiveRule = {
  id: string
  name: string
  condition: { type: string; minutes?: number; text?: string; percent?: number; at?: string; windowMinutes?: number }
  action: { type: string; workflowId?: string; jobId?: string; tool?: string; args?: Record<string, unknown> }
  enabled: boolean
  cooldownSec: number
  lastFired: number | null
  firedCount: number
  createdAt: number
}

export type OrvexProactiveRuleEvent = {
  id: number
  ruleId: string
  at: number
  ok: number
  detail: string
}

export type OrvexSelfEval = {
  id: string
  goal: string
  createdAt: number
  score: number
  verdicts?: { criterion: string; pass: boolean; reason: string }[]
  issues?: string[]
  method?: string
  heuristic?: Record<string, unknown>
  model: string | null
  note?: string
}

export type OrvexRouteStat = {
  providerId: string
  model: string
  calls: number
  okRate: number | null
  p50Ms: number | null
}

export type OrvexRouteRecommendation = {
  id: string
  name: string
  model: string
  baseUrl: string
  capability: number
  reliability: number | null
  p50Ms: number | null
  calls: number
  score: number
  reasons: string[]
}

export type OrvexRouteRecommendResult = {
  task: string
  ranked: OrvexRouteRecommendation[]
  stats?: OrvexRouteStat[]
  note?: string
}

export type OrvexLearningSuggestion = {
  id: string
  kind: 'workflow' | 'routing'
  key: string
  detail: {
    steps?: string[]
    support?: number
    runs?: number
    task?: string
    chain?: { providerId: string; model: string }[]
    calls?: number
    okRate?: number
  }
  support: number
  status: string
  updatedAt: number
}

export type OrvexAdvancedJobStep = { tool: string; args: Record<string, unknown>; label?: string | null }

export type OrvexAdvancedJob = {
  id: string
  title: string
  spec: { steps: OrvexAdvancedJobStep[]; stopOnError: boolean }
  status: 'queued' | 'running' | 'paused' | 'interrupted' | 'done' | 'failed' | 'cancelled'
  checkpoint: number
  results: { index: number; tool: string; ok: boolean; output: string; error: string | null; ms: number }[]
  error: string | null
  createdAt: number
  updatedAt: number
  endedAt: number | null
}

export type OrvexRecoveryOverview = {
  runs: { id: string; goal: string; status: string; steps: number; startedAt: number }[]
  workflows: { id: string; workflowId: string; name: string | null; status: string; startedAt: number }[]
  jobs: { id: string; title: string; status: string; checkpoint: number; createdAt: number; steps: number }[]
  crashes: { id: number; at: number; pid: number; startedAt: number; sessionId: string | null; reason: string }[]
  at: number
}

export type OrvexCollabAgent = {
  id: string
  name: string
  role: string
  prompt: string
  builtin?: boolean
  createdAt: number
  updatedAt: number
}

export type OrvexCollabMessage = { agent: string; role: string; round: number; text: string; at: number }

export type OrvexCollabSession = {
  id: string
  goal: string
  status: string
  rounds: number
  agents: string[]
  model: string | null
  result: string
  error: string | null
  createdAt: number
  updatedAt: number
}

export type OrvexCollabSessionDetail = OrvexCollabSession & { messages: OrvexCollabMessage[] }

export type OrvexVisionResult = {
  source: string
  file: string | null
  mime: string
  bytes: number
  width: number | null
  height: number | null
  url: string | null
  ocr: { text: string; lines: string[]; lang: string; width: number; height: number; file: string | null; url: string | null } | null
  ocrError: string | null
  analysis: string | null
  model: string | null
  note: string | null
}

export type OrvexPluginInfo = {
  id: string
  name: string
  version: string
  dir: string
  enabled: boolean
  source: string
  installedAt: number
  updatedAt: number
  tools: { name: string; description: string; parameters: Record<string, unknown> }[]
  description: string
  permissions: Record<string, unknown> | null
}

export type OrvexMarketplaceItem = {
  id: string
  name: string
  version: string
  description: string
  author: string
  url: string
  sha256: string
  tools: string[]
  installed: boolean
}

export type OrvexCatalogKey = { keyId: string; fingerprint: string }

export type OrvexMarketCatalog = {
  configured: boolean
  url: string
  items: OrvexMarketplaceItem[]
  cachedAt: number | null
  note?: string
  error?: string | null
  signed: boolean | null
  keyId: string | null
  fingerprint: string | null
  generatedAt?: string | null
  keys: OrvexCatalogKey[]
  requireSignature: boolean
  skipped?: number
}

export type OrvexA2aPeer = {
  id: string
  name: string
  url: string
  tokenPreview: string
  hasToken: boolean
  createdAt: number
  lastSeen: number | null
  lastError: string | null
}

export type OrvexA2aTaskStatus = {
  state: 'submitted' | 'working' | 'completed' | 'failed' | 'canceled'
  timestamp: string
  message?: { role: string; parts: { kind: string; text?: string }[] }
}

export type OrvexA2aTask = {
  kind: 'task'
  id: string
  contextId: string
  status: OrvexA2aTaskStatus
  artifacts?: { artifactId: string; name?: string; parts: { kind: string; text?: string }[] }[]
  metadata?: { direction?: string; peer?: string; created?: string; ended?: string | null; durationMs?: number }
  goal?: string
}

export type OrvexA2aCardSummary = {
  name: string
  description: string
  version: string
  protocolVersion: string
  skills: string[]
}

export type OrvexA2aAgentCard = {
  name: string
  description: string
  version: string
  protocolVersion: string
  url: string
  preferredTransport: string
  capabilities: { streaming: boolean; pushNotifications: boolean; stateTransitionHistory: boolean }
  defaultInputModes: string[]
  defaultOutputModes: string[]
  skills: { id: string; name: string; description: string; tags: string[] }[]
  securitySchemes: Record<string, { type: string; scheme: string }>
  security: Record<string, string[]>[]
  metadata: { host: string; device: string; pcControlForPeers: boolean }
}

export type OrvexA2aStatus = {
  hosting: boolean
  port: number
  expose: 'loopback' | 'lan'
  url: string
  card: OrvexA2aAgentCard
  token: string
  peers: OrvexA2aPeer[]
  tasks: OrvexA2aTask[]
  active: number
}

export type OrvexDeviceInfo = {
  id: string
  name: string
  platform: string
  version: string
  port: number
}

export type OrvexDeviceLink = {
  id: string
  name: string
  host: string
  port: number
  pairedAt: number | null
  lastSeen: number | null
  paired: boolean
}

export type OrvexDeviceHostStatus = {
  hosting: boolean
  port: number
  discoveryPort: number
  code: { code: string; expiresAt: number } | null
  device: OrvexDeviceInfo
  paired: { name: string; pairedAt: number }[]
}

export type OrvexSyncLogRow = {
  id: number
  at: number
  direction: string
  device: string
  items: string | null
  ok: number
  error: string | null
}

export type OrvexAdvancedEvent = {
  type: string
  scope?: string
  at?: number
  [key: string]: unknown
}

export type OrvexTrainingEpisodeKind = 'agent' | 'orchestrator' | 'workflow' | 'job' | 'chat' | 'manual'
export type OrvexTrainingEpisodeStatus = 'running' | 'done' | 'failed' | 'cancelled'

export type OrvexTrainingStatus = {
  root: string
  exists: boolean
  marker: string
  quotaBytes: number
  usedBytes: number
  categories: Record<string, number>
  freeBytes: number | null
  diskTotalBytes: number | null
  reserveBytes: number
  overQuota: boolean
  diskTight: boolean
  layout: string[]
  episodes: number
  lastEpisodeAt: number | null
  at: number
}

export type OrvexTrainingUsage = {
  root: string
  categories: Record<string, number>
  totalBytes: number
  quotaBytes: number
  freeBytes: number | null
  diskTotalBytes: number | null
  at: number
}

export type OrvexTrainingEpisode = {
  id: string
  runId: string | null
  kind: OrvexTrainingEpisodeKind
  goal: string | null
  status: OrvexTrainingEpisodeStatus
  score: number | null
  provider: string | null
  model: string | null
  steps: number
  promptTokens: number
  completionTokens: number
  cost: number
  ms: number
  error: string | null
  file: string | null
  createdAt: number
}

export type OrvexTrainingEpisodeDetail = OrvexTrainingEpisode & {
  plan: unknown
  actions: unknown
  outcome: unknown
}

export type OrvexTrainingStats = {
  count: number
  avgScore: number
  cost: number
  tokens: number
  steps: number
  byKind: { kind: string; count: number }[]
  lastAt: number | null
}

export type OrvexTrainingScorePoint = {
  day: string
  count: number
  avgScore: number | null
  passRate: number | null
  done: number
  failed: number
  cancelled: number
}

export type OrvexTrainingScoreCurve = {
  days: number
  kind: string | null
  points: OrvexTrainingScorePoint[]
  overall: { count: number; avgScore: number | null; passRate: number | null }
}

export type OrvexTrainingEvalPack = {
  id: string
  suite: string
  name: string
  cases: number
  path: string
  createdAt: number
  updatedAt: number
}

export type OrvexTrainingEvent = { type: string; at: number; [key: string]: unknown }

export type OrvexLearnerSuggestion = {
  id: string
  kind: 'eval' | 'skill' | 'train' | 'finetune'
  title: string
  detail: string
  episodeId?: string
}

export type OrvexLearnerNanoMetrics = {
  accuracy: number
  logLoss: number
  baseline: number
  holdout: boolean
}

export type OrvexLearnerNanoModel = {
  id: string
  name: string
  path: string
  bytes: number
  sha256: string | null
  meta: OrvexLearnerNanoMetrics | null
  status: string
  createdAt: number
}

export type OrvexLearnerNanoActive = {
  id: string
  model: { metrics?: OrvexLearnerNanoMetrics; createdAt?: number } & Record<string, unknown>
}

export type OrvexLearnerStatus = {
  root: string
  nano: {
    active: { id: string; accuracy: number | null; holdout: boolean; createdAt: number } | null
    models: number
    lastTrainedAt: number | null
  }
  skills: { suggested: number; active: number; disabled: number; total: number }
  kits: number
  fineTunes: { total: number; open: number }
  lastCycleAt: number | null
  suggestions: OrvexLearnerSuggestion[]
}

export type OrvexLearnerSkill = {
  id: string
  name: string
  version: string
  status: 'suggested' | 'active' | 'disabled'
  support: number
  score: number | null
  source: string | null
  createdAt: number
  updatedAt: number
  when: string
  steps: number
  tools: string[]
  avoid: number
  guide?: boolean
}

export type OrvexLearnerKit = {
  id: string
  name: string
  kind: string
  format: string
  path: string | null
  items: number
  bytes: number
  status: string
  meta: { manifest?: string; baseModel?: string }
  createdAt: number
  updatedAt: number
  dir: string
  exists: boolean
}

export type OrvexLearnerModel = {
  id: string
  name: string
  role: string
  format: string
  path: string | null
  bytes: number
  sha256: string | null
  source: string | null
  status: string
  meta: unknown
  createdAt: number
}

export type OrvexLearnerFinetune = {
  id: string
  status: string
  providerId: string | null
  baseUrl: string | null
  model: string | null
  remoteId: string | null
  dataset: string | null
  log: string
  startedAt: number
  endedAt: number | null
}

export type OrvexLearnerTrainResult = {
  model: OrvexLearnerNanoModel & { metrics: OrvexLearnerNanoMetrics; samples: Record<string, number> }
  promoted: boolean
  previous: string | null
  metrics: OrvexLearnerNanoMetrics
  samples: Record<string, number>
  path: string
}

export type OrvexLearnerCycle = {
  startedAt: number
  endedAt: number
  actions: { kind: string; id: string; [key: string]: unknown }[]
  skipped: { kind: string; reason: string }[]
  suggestions: OrvexLearnerSuggestion[]
}

export type OrvexLearnerEvent = { type: string; at: number; [key: string]: unknown }

export type OrvexWorkforceModel = {
  providerId: string
  presetId?: string
  name: string
  baseUrl: string
  model: string
  api: 'openai' | 'anthropic'
}

export type OrvexWorkforceAgent = {
  id: string
  name: string
  role: string
  mission: string
  model: OrvexWorkforceModel | null
  schedule: string | null
  status: 'active' | 'paused'
  budgetUsd: number
  spentUsd: number
  runs: number
  successes: number
  lastRunAt: number | null
  nextRunAt: number | null
  memory: { at: number; ok?: boolean; shiftId?: string; note: string }[]
  createdAt: number
  updatedAt: number
  budgetBlocked: boolean
}

export type OrvexWorkforceShift = {
  id: string
  agentId: string
  agentName: string | null
  goal: string
  status: 'running' | 'done' | 'failed' | 'cancelled'
  trigger: 'manual' | 'schedule'
  runId: string | null
  summary: string | null
  error: string | null
  costUsd: number
  tokens: number
  steps: number
  startedAt: number
  endedAt: number | null
}

export type OrvexWorkforceMessage = {
  id: string
  agentId: string | null
  agentName: string | null
  shiftId: string | null
  kind: string
  title: string
  body: string
  read: boolean
  createdAt: number
}

export type OrvexWorkforceStatus = {
  total: number
  active: number
  paused: number
  scheduled: number
  spent: number
  budget: number
  nextRunAt: number | null
  inFlight: number
  unread: number
  scheduler: boolean
  tickMs: number
  engineBusy: boolean
}

export type OrvexWorkforceEvent = { type: string; at: number; [key: string]: unknown }

export type OrvexBrainFit = {
  ok: boolean
  verdict: 'gpu-full' | 'gpu-partial' | 'cpu' | 'unknown'
  layerCount: number
  gpuLayers: number
  recommendedGpuLayers: number
  context: number
  kvBytes: number
  estimatedVramBytes: number
  estimatedRamBytes: number
  vramBytes: number
  fitsFully: boolean
  note: string | null
}

export type OrvexBrainModel = {
  id: string
  path: string
  name: string
  kind: 'model' | 'projector'
  size: number
  quant: string
  arch: string
  params: number | null
  blockCount: number | null
  contextLength: number | null
  sha256: string | null
  headerOk: boolean
  fit: OrvexBrainFit | null
}

export type OrvexBrainRuntime = {
  found: boolean
  path: string | null
  tried?: string[]
  source?: string
  reason?: string
}

export type OrvexBrainServer = {
  state: 'stopped' | 'starting' | 'running' | 'stopping' | 'error'
  pid: number | null
  port: number | null
  modelId: string | null
  modelPath: string | null
  startedAt: number | null
  lastRequestAt: number | null
  error: string | null
  baseUrl: string | null
  uptimeMs: number
  canStart: boolean
}

export type OrvexBrainConfig = {
  enabled: boolean
  prefer: 'local-first' | 'cloud-first' | 'offline-only'
  offline: boolean
  port: number
  context: number
  threads: number
  gpuLayers: number | 'auto'
  vramGb: number | null
  idleMinutes: number
  runtimePath: string
  modelsDir: string
  modelId: string
}

export type OrvexBrainCapability = { available: boolean; reason: string | null }

export type OrvexBrainStatus = {
  enabled: boolean
  offline: boolean
  prefer: string
  config: OrvexBrainConfig
  runtime: OrvexBrainRuntime
  server: OrvexBrainServer
  model: (OrvexBrainModel & { fit: OrvexBrainFit }) | null
  models: { count: number; totalBytes: number; scannedAt: number | null }
  vram: { bytes: number; source: string; available: boolean; reason?: string; adapters: { name: string; memoryBytes: number | null }[] }
  gpu: { available: boolean; adapters: { name: string; memoryBytes: number | null }[]; reason?: string | null }
  capabilities: Record<'chat' | 'vision' | 'embeddings' | 'speech' | 'reranker', OrvexBrainCapability>
  logs: { at: number; kind: string; line: string }[]
  bootAt: number
}

export type OrvexBrainScan = {
  dir: string
  models: OrvexBrainModel[]
  count: number
  totalBytes: number
  scannedAt: number
  selected: OrvexBrainModel | null
}

export type OrvexBrainRoute = { target: 'local' | 'cloud' | 'blocked'; reason: string; task: string }

export type OrvexBrainEvent = { type: string; [key: string]: unknown }

export type OrvexBridge = {
  isDesktop: true
  env: () => Promise<IpcResult<OrvexEnv>>
  tools: {
    run: (name: string, args?: Record<string, unknown>) => Promise<IpcResult<OrvexToolResult>>
  }
  agent: {
    start: (payload: OrvexEngineStartPayload) => Promise<IpcResult<{ runId: string }>>
    stop: () => Promise<IpcResult<{ stopped: boolean }>>
    pause: () => Promise<IpcResult<{ paused: boolean }>>
    resume: () => Promise<IpcResult<{ paused: boolean }>>
    approve: (id: string, allow: boolean) => Promise<IpcResult<{ resolved: boolean }>>
    status: () => Promise<IpcResult<{ running: boolean; paused: boolean; runId: string | null; agentId: string | null; goal?: string | null; mode?: string | null }>>
    onEvent: (cb: (event: OrvexAgentEvent) => void) => () => void
  }
  orchestrator: {
    start: (payload: OrvexEngineStartPayload) => Promise<IpcResult<{ runId: string }>>
    resume: (payload: OrvexEngineStartPayload & { runId: string }) => Promise<IpcResult<{ runId: string }>>
    runs: (limit?: number) => Promise<IpcResult<{ runs: OrvexRunRecord[]; resumable: OrvexRunRecord[]; autoResume?: boolean }>>
    run: (runId: string) => Promise<IpcResult<{ run: OrvexRunRecord; steps: OrvexRunStepRecord[] }>>
    setAutoResume: (enabled: boolean) => Promise<IpcResult<{ enabled: boolean }>>
  }
  app: {
    prefs: () => Promise<IpcResult<OrvexAppPrefs>>
    setPrefs: (patch: { launchAtLogin?: boolean; closeToTray?: boolean }) => Promise<IpcResult<OrvexAppPrefs>>
    window: (action: OrvexWindowAction, extra?: { id?: string; tab?: string | null }) => Promise<IpcResult<OrvexWindowState>>
    onWake: (cb: () => void) => () => void
    onWindowState: (cb: (state: OrvexWindowState) => void) => () => void
    onNavigate: (cb: (target: { id: string; tab?: string | null }) => void) => () => void
    onNotify: (cb: (note: OrvexNotifyPayload) => void) => () => void
  }
  dashboard: {
    snapshot: () => Promise<IpcResult<OrvexDashboardSnapshot>>
  }
  security: {
    status: () => Promise<IpcResult<OrvexSecurityStatus>>
    setPin: (current: string | null, next: string) => Promise<IpcResult<OrvexSecurityStatus>>
    removePin: (current: string) => Promise<IpcResult<OrvexSecurityStatus>>
    unlock: (pin: string) => Promise<IpcResult<{ ok: boolean; status: OrvexSecurityStatus }>>
    lock: () => Promise<IpcResult<OrvexSecurityStatus>>
    touch: () => Promise<IpcResult<{ at: number }>>
    setRole: (role: OrvexSecurityRole, pin?: string) => Promise<IpcResult<OrvexSecurityStatus>>
    setSettings: (patch: {
      autolockMinutes?: number
      command?: { mode?: 'blocklist' | 'allowlist'; allow?: string[] }
      network?: { mode?: 'all' | 'allowlist'; hosts?: string[] }
      sandbox?: { shell?: boolean }
      rate?: { enabled?: boolean; perMinute?: number; perToolPerMinute?: number }
    }) => Promise<IpcResult<OrvexSecurityStatus>>
    emergencyStop: (reason?: string) => Promise<IpcResult<OrvexSecurityStatus>>
    emergencyClear: () => Promise<IpcResult<OrvexSecurityStatus>>
    scan: (text: string) => Promise<IpcResult<{ suspicious: boolean; reasons: string[] }>>
    audit: (filters?: { limit?: number; kind?: string; tool?: string; ok?: boolean; query?: string }) => Promise<IpcResult<OrvexAuditEntry[]>>
    secrets: () => Promise<IpcResult<OrvexSecretSummary>>
    setSecret: (id: string, value: string) => Promise<IpcResult<OrvexSecretSummary>>
    deleteSecret: (id: string) => Promise<IpcResult<OrvexSecretSummary>>
    backups: () => Promise<IpcResult<OrvexSecurityBackup[]>>
    createBackup: (payload?: { note?: string; passphrase?: string }) => Promise<IpcResult<OrvexSecurityBackup>>
    restoreBackup: (id: string, passphrase?: string) => Promise<IpcResult<{ id: string; restartRequired: boolean; files: number }>>
    deleteBackup: (id: string) => Promise<IpcResult<{ removed: boolean }>>
    clearData: (what: 'audit' | 'runs' | 'usage' | 'memory' | 'media' | 'research' | 'workflows') => Promise<IpcResult<{ what: string; removed: Record<string, number | boolean>; at: number }>>
    onChange: (cb: (event: { reason: string; status: OrvexSecurityStatus }) => void) => () => void
  }
  monitor: {
    overview: () => Promise<IpcResult<OrvexMonitorOverview>>
    series: (minutes?: number) => Promise<IpcResult<OrvexMonitorSeries>>
    sample: () => Promise<IpcResult<OrvexMonitorSample | null>>
    usage: (sinceMs?: number) => Promise<IpcResult<OrvexMonitorUsage>>
    usageSeries: (sinceMs?: number) => Promise<IpcResult<OrvexMonitorUsage['series']>>
    usageCsv: (sinceMs?: number) => Promise<IpcResult<{ sinceMs: number; rows: number; csv: string; name: string }>>
    traces: (limit?: number) => Promise<IpcResult<{ limit: number; runs: OrvexMonitorTraceRun[] }>>
    trace: (runId: string) => Promise<IpcResult<OrvexMonitorTraceDetail>>
    compare: (payload: {
      prompt: string
      system?: string
      candidates: OrvexAgentProvider[]
      maxTokens?: number
      temperature?: number
      timeoutMs?: number
    }) => Promise<IpcResult<OrvexMonitorCompare>>
    health: (candidates?: OrvexAgentProvider[]) => Promise<IpcResult<OrvexMonitorHealth>>
    recoverables: () => Promise<IpcResult<OrvexMonitorRecoverables>>
    abandon: (runId: string) => Promise<IpcResult<{ id: string; status: string; at: number }>>
    crashes: (limit?: number) => Promise<IpcResult<OrvexMonitorCrash[]>>
    clearCrashes: () => Promise<IpcResult<{ removed: number }>>
    evalSuites: () => Promise<IpcResult<{ suites: OrvexEvalSuite[]; at: number }>>
    evalSave: (payload: { id?: string; name: string; cases: OrvexEvalCase[] }) => Promise<IpcResult<OrvexEvalSuite>>
    evalDelete: (id: string) => Promise<IpcResult<{ removed: number; id: string }>>
    evalRun: (payload: { suiteId: string; candidates: OrvexAgentProvider[]; timeoutMs?: number; maxTokens?: number }) => Promise<IpcResult<OrvexEvalRunResult>>
    evalHistory: (suite?: string, limit?: number) => Promise<IpcResult<{ rows: OrvexEvalRow[] }>>
    evalClear: (suite?: string) => Promise<IpcResult<{ removed: number }>>
  }
  audit: {
    tail: (limit?: number) => Promise<IpcResult<OrvexAuditEntry[]>>
  }
  llm: {
    start: (payload: {
      requestId: string
      provider: OrvexAgentProvider
      candidates?: OrvexAgentProvider[]
      messages: { role: 'user' | 'assistant' | 'system'; content: string }[]
      system?: string
      temperature?: number
      maxTokens?: number
      task?: string
      jsonSchema?: Record<string, unknown> | null
    }) => Promise<IpcResult<{ requestId: string; candidates: { id: string; name: string; model: string }[] }>>
    abort: (requestId: string) => Promise<IpcResult<{ aborted: boolean }>>
    onEvent: (cb: (event: OrvexLLMEvent) => void) => () => void
  }
  providers: {
    test: (provider: OrvexAgentProvider) => Promise<IpcResult<{ ok: boolean; label: string; detail: string }>>
    models: (provider: OrvexAgentProvider) => Promise<IpcResult<{ models: { id: string; free: boolean }[]; priced: boolean; skipped?: string[] } | null>>
  }
  stt: {
    transcribe: (payload: {
      url: string
      model?: string
      audio: ArrayBuffer
      type?: string
      timeoutMs?: number
      /** ISO language hint ('ur', 'hi', 'en'); ignored when empty. */
      language?: string
    }) => Promise<IpcResult<{ text: string }>>
    /** Record the endpoint speech input will use, so local Whisper only runs when it is needed. */
    setEndpoint: (url: string) => Promise<IpcResult<{ local: boolean }>>
    /** Copy an already-saved provider key into the STT vault slot. The value never comes back. */
    useProviderKey: (url: string) => Promise<IpcResult<{ linked: boolean; provider: string }>>
    /** Model names this endpoint reports for transcription. */
    models: (url: string) => Promise<IpcResult<{ models: string[]; endpoint: string; source: string }>>
    /**
     * Extra keys for the same endpoint. Only labels and status cross this
     * bridge — a stored key is never sent back to the renderer.
     */
    keys: {
      list: (url: string) => Promise<
        IpcResult<{
          limit: number
          keys: {
            id: string
            label: string
            addedAt: number
            state: 'working' | 'quota' | 'key' | 'cooling'
            stateLabel: string
            fails: number
            detail: string
            retryInMs: number
          }[]
          savedFor: string
          /** Keys kept for other endpoints, so a source switch cannot look like data loss. */
          others: number
          hasSingleKey: boolean
        }>
      >
      add: (key: string, label: string, url: string) => Promise<IpcResult<{ added: boolean; count: number; reason?: string }>>
      remove: (id: string, url: string) => Promise<IpcResult<{ count: number }>>
      reset: () => Promise<IpcResult<{ cleared: boolean }>>
    }
    /** Live microphone streaming; the socket and the key stay in the main process. */
    realtime: {
      start: (payload?: {
        model?: string
        language?: string
        silenceSecs?: number
      }) => Promise<IpcResult<{ id: string; sampleRate: number; model: string; commitStrategy: string; sessionId: string }>>
      audio: (id: string, audio: string, commit?: boolean) => Promise<IpcResult<{ sent: boolean; bytes: number }>>
      commit: (id: string) => Promise<IpcResult<{ sent: boolean; bytes: number }>>
      stop: (id?: string) => Promise<IpcResult<{ stopped: boolean }>>
      onEvent: (
        cb: (event: {
          id: string
          type: 'ready' | 'partial' | 'committed' | 'warning' | 'error' | 'closed'
          text?: string
          message?: string
          error?: string
          code?: number
          sampleRate?: number
          model?: string
          commitStrategy?: string
          sessionId?: string
        }) => void,
      ) => () => void
    }
  }
  routing: {
    get: () => Promise<IpcResult<{ routing: Record<string, OrvexRouteRef[]>; tasks: string[] }>>
    set: (task: string, chain: OrvexRouteRef[]) => Promise<IpcResult<{ routing: Record<string, OrvexRouteRef[]> }>>
    clear: (task?: string) => Promise<IpcResult<{ routing: Record<string, OrvexRouteRef[]> }>>
  }
  usage: {
    summary: (sinceMs?: number) => Promise<IpcResult<OrvexUsageSummary>>
    recent: (limit?: number) => Promise<IpcResult<OrvexUsageRow[]>>
    clear: () => Promise<IpcResult<{ cleared: boolean }>>
  }
  budget: {
    get: () => Promise<IpcResult<OrvexAdvisorBudget>>
    set: (dailyUsd?: number, monthlyUsd?: number) => Promise<IpcResult<OrvexAdvisorBudget>>
  }
  advisor: {
    brief: () => Promise<IpcResult<OrvexAdvisorBrief>>
    suggestions: () => Promise<IpcResult<OrvexAdvisorSuggestions>>
    dismiss: (id: string, hours?: number) => Promise<IpcResult<{ id: string; until: number; dismissed: number }>>
    restore: (id?: string) => Promise<IpcResult<{ restored: string; dismissed: number }>>
    budget: () => Promise<IpcResult<OrvexAdvisorBudget>>
    setBudget: (payload: { dailyUsd?: number; monthlyUsd?: number }) => Promise<IpcResult<OrvexAdvisorBudget>>
    update: () => Promise<IpcResult<OrvexAdvisorUpdateInfo>>
    setUpdateFeed: (url: string) => Promise<IpcResult<OrvexAdvisorUpdateInfo>>
    checkUpdate: (url?: string) => Promise<IpcResult<OrvexAdvisorUpdateResult>>
  }
  updater: {
    state: () => Promise<IpcResult<OrvexUpdaterState>>
    setRepo: (repo: string) => Promise<IpcResult<OrvexUpdaterState>>
    setAutoCheck: (enabled: boolean) => Promise<IpcResult<OrvexUpdaterState>>
    check: (repo?: string) => Promise<IpcResult<OrvexUpdaterCheck>>
    download: () => Promise<IpcResult<{ download: OrvexUpdaterDownload; state: OrvexUpdaterState }>>
    install: () => Promise<IpcResult<{ installed: boolean; revealed: boolean; note: string }>>
    reveal: () => Promise<IpcResult<{ path: string }>>
    openRelease: () => Promise<IpcResult<{ url: string }>>
    onEvent: (cb: (event: OrvexUpdaterEvent) => void) => () => void
  }
  health: {
    reset: () => Promise<IpcResult<{ reset: boolean }>>
  }
  db: {
    info: () => Promise<IpcResult<{ ready: boolean; file: string | null; error: string | null }>>
  }
  secrets: {
    get: () => Promise<IpcResult<{ available: boolean; keys: Record<string, boolean> }>>
    set: (id: string, key: string, baseUrl?: string) => Promise<IpcResult<{ saved: boolean; hasKey: boolean }>>
  }
  memory: {
    get: () => Promise<IpcResult<{ text: string; bytes: number }>>
    set: (text: string) => Promise<IpcResult<{ bytes: number }>>
    clear: () => Promise<IpcResult<{ cleared: boolean }>>
    info: () => Promise<IpcResult<{ ready: boolean; error: string | null; kinds: string[]; dimensions: number }>>
    stats: () => Promise<IpcResult<OrvexMemoryStats>>
    list: (filters?: {
      kind?: string
      project?: string
      status?: string
      tag?: string
      pinned?: boolean
      limit?: number
    }) => Promise<IpcResult<OrvexMemoryItem[]>>
    item: (id: string) => Promise<IpcResult<OrvexMemoryItem>>
    add: (payload: {
      text: string
      kind?: string
      project?: string
      tags?: string[]
      importance?: number
      source?: string
      pinned?: boolean
      expiresAt?: number | null
    }) => Promise<IpcResult<OrvexMemoryItem & { duplicate: boolean; conflicts?: number }>>
    update: (
      id: string,
      patch: {
        text?: string
        kind?: string
        project?: string
        tags?: string[]
        importance?: number
        pinned?: boolean
        status?: string
        expiresAt?: number | null
      },
    ) => Promise<IpcResult<OrvexMemoryItem>>
    remove: (id: string) => Promise<IpcResult<{ removed: boolean; id: string }>>
    search: (
      query: string,
      opts?: { kind?: string; project?: string; limit?: number },
    ) => Promise<IpcResult<OrvexMemoryHit[]>>
    ask: (payload: {
      question: string
      candidates?: OrvexAgentProvider[]
      project?: string
      limit?: number
    }) => Promise<IpcResult<OrvexMemoryRagResult>>
    profile: () => Promise<IpcResult<OrvexMemoryProfile>>
    saveProfile: (patch: Partial<OrvexMemoryProfile>) => Promise<IpcResult<OrvexMemoryProfile>>
    conflicts: (status?: string) => Promise<IpcResult<OrvexMemoryConflict[]>>
    resolve: (
      id: string,
      action: 'keep_a' | 'keep_b' | 'merge' | 'dismiss',
      mergedText?: string,
    ) => Promise<IpcResult<OrvexMemoryConflict>>
    links: (id: string, limit?: number) => Promise<IpcResult<(OrvexMemoryItem & { score: number })[]>>
    graph: (opts?: { project?: string; limit?: number }) => Promise<IpcResult<OrvexMemoryGraph>>
    context: (opts?: { goal?: string; project?: string; limit?: number; maxChars?: number }) => Promise<IpcResult<{ text: string }>>
    importLegacy: () => Promise<IpcResult<{ imported: number; skipped: number; unchanged?: boolean }>>
    sweep: () => Promise<IpcResult<{ expired: number; ids: string[] }>>
  }
  files: {
    info: () => Promise<
      IpcResult<{ ready: boolean; error: string | null; versionsDir: string | null; backupsDir: string | null; watching: { id: string; path: string; events: number; startedAt: number }[] }>
    >
    roots: () => Promise<IpcResult<OrvexFileRoot[]>>
    list: (path: string) => Promise<IpcResult<OrvexFileListing>>
    search: (path: string, query: string, limit?: number) => Promise<IpcResult<OrvexFileSearch>>
    stat: (path: string) => Promise<IpcResult<OrvexFileMeta>>
    read: (path: string, maxBytes?: number) => Promise<IpcResult<{ path: string; text: string; bytes: number; truncated: boolean }>>
    write: (path: string, content: string) => Promise<IpcResult<OrvexFileMeta>>
    mkdir: (path: string, recursive?: boolean) => Promise<IpcResult<OrvexFileMeta>>
    rename: (from: string, to: string) => Promise<IpcResult<OrvexFileMeta>>
    copy: (from: string, to: string, overwrite?: boolean) => Promise<IpcResult<OrvexFileMeta>>
    remove: (path: string, recursive?: boolean) => Promise<IpcResult<{ removed: boolean; path: string; isDir: boolean }>>
    duplicates: (
      path: string,
      opts?: { minSize?: number; maxFiles?: number },
    ) => Promise<IpcResult<OrvexFileDuplicates>>
    zip: (dest: string, sources: string[]) => Promise<IpcResult<OrvexZipResult>>
    unzip: (zipPath: string, destDir: string) => Promise<IpcResult<{ path: string; extracted: number }>>
    zipList: (zipPath: string) => Promise<IpcResult<{ path: string; entries: OrvexZipEntry[] }>>
    pdfInfo: (path: string) => Promise<IpcResult<OrvexPdfInfo>>
    pdfMerge: (paths: string[], dest: string) => Promise<IpcResult<OrvexPdfInfo>>
    pdfSplit: (path: string, ranges: string, destDir: string) => Promise<IpcResult<{ created: string[]; pages: number; destDir: string }>>
    pdfRotate: (path: string, pages: string, degrees: number, dest?: string) => Promise<IpcResult<OrvexPdfInfo>>
    pdfSetMeta: (
      path: string,
      meta: { title?: string; author?: string; subject?: string; keywords?: string; creator?: string },
      dest?: string,
    ) => Promise<IpcResult<OrvexPdfInfo>>
    pdfCreate: (dest: string, title: string, text: string) => Promise<IpcResult<OrvexPdfInfo>>
    xlsxInfo: (path: string) => Promise<IpcResult<OrvexXlsxInfo>>
    xlsxRead: (path: string, sheet?: string, limit?: number) => Promise<IpcResult<OrvexXlsxRead>>
    xlsxToCsv: (path: string, dest: string, sheet?: string) => Promise<IpcResult<{ path: string; bytes: number; sheet: string }>>
    xlsxWrite: (
      dest: string,
      sheets: { name: string; rows: (string | number)[][] }[],
    ) => Promise<IpcResult<OrvexXlsxInfo>>
    docxMake: (dest: string, markdown: string, title?: string) => Promise<IpcResult<OrvexDocxResult>>
    diff: (a: string, b: string) => Promise<IpcResult<OrvexDiffResult>>
    backup: (path: string) => Promise<IpcResult<OrvexFileBackup>>
    backups: (path?: string) => Promise<IpcResult<OrvexFileBackup[]>>
    restoreBackup: (id: string) => Promise<IpcResult<OrvexFileMeta>>
    removeBackup: (id: string) => Promise<IpcResult<{ removed: boolean; id: string }>>
    versions: (path: string) => Promise<IpcResult<OrvexFileVersion[]>>
    restoreVersion: (id: string) => Promise<IpcResult<OrvexFileMeta>>
    watchStart: (path: string) => Promise<IpcResult<OrvexFileWatch>>
    watchStop: (id?: string) => Promise<IpcResult<{ stopped: string; path: string }>>
    watchStatus: () => Promise<IpcResult<OrvexFileWatchStatus>>
    pickFolder: () => Promise<IpcResult<{ cancelled: boolean; path: string | null }>>
    pickFile: (filters?: { name: string; extensions: string[] }[]) => Promise<IpcResult<{ cancelled: boolean; path: string | null }>>
    pickSave: (
      defaultPath?: string,
      filters?: { name: string; extensions: string[] }[],
    ) => Promise<IpcResult<{ cancelled: boolean; path: string | null }>>
    reveal: (path: string) => Promise<IpcResult<{ revealed: boolean }>>
    openPath: (path: string) => Promise<IpcResult<{ opened: boolean }>>
    onChange: (cb: (event: OrvexFileWatchEvent) => void) => () => void
  }
  mcp: {
    get: () => Promise<IpcResult<{ servers: OrvexMcpServer[]; status: OrvexMcpStatus[] }>>
    set: (servers: OrvexMcpServer[]) => Promise<IpcResult<{ status: OrvexMcpStatus[] }>>
    reconnect: () => Promise<IpcResult<{ status: OrvexMcpStatus[] }>>
  }
  media: {
    assets: () => Promise<IpcResult<{ baseUrl: string; token: string; running: boolean }>>
    info: () => Promise<IpcResult<OrvexMediaInfo>>
    library: (filters?: { kind?: OrvexMediaKind | 'all'; query?: string; limit?: number }) => Promise<IpcResult<OrvexMediaLibrary>>
    get: (id: string) => Promise<IpcResult<OrvexMediaAsset>>
    remove: (id: string) => Promise<IpcResult<{ deleted: string; name: string }>>
    rename: (id: string, name: string) => Promise<IpcResult<OrvexMediaAsset>>
    importFile: (path: string) => Promise<IpcResult<OrvexMediaAsset>>
    importPick: () => Promise<IpcResult<{ cancelled: boolean; asset: OrvexMediaAsset | null }>>
    pickFile: (filters?: { name: string; extensions: string[] }[]) => Promise<IpcResult<{ cancelled: boolean; path: string | null }>>
    exportAsset: (id: string, destPath?: string) => Promise<IpcResult<{ cancelled?: boolean; path: string | null; bytes?: number }>>
    reveal: (id: string) => Promise<IpcResult<{ revealed: boolean; path: string }>>
    open: (id: string) => Promise<IpcResult<{ opened: boolean }>>
    source: (path: string) => Promise<IpcResult<OrvexMediaSource>>
    generate: (payload: {
      provider: OrvexAgentProvider
      prompt: string
      model?: string
      size?: string
      n?: number
    }) => Promise<IpcResult<OrvexMediaGenerateResult>>
    edit: (payload: {
      provider: OrvexAgentProvider
      prompt: string
      assetId?: string
      path?: string
      maskAssetId?: string
      maskPath?: string
      model?: string
      size?: string
    }) => Promise<IpcResult<{ assets: OrvexMediaAsset[]; prompt: string }>>
    removeBackground: (payload: {
      provider: OrvexAgentProvider
      assetId?: string
      path?: string
      model?: string
    }) => Promise<IpcResult<{ assets: OrvexMediaAsset[]; prompt: string }>>
    upscale: (payload: { assetId?: string; path?: string; factor?: number; sharpen?: boolean }) => Promise<IpcResult<OrvexMediaUpscaleResult>>
    analyze: (payload: {
      candidates?: OrvexAgentProvider[]
      provider?: OrvexAgentProvider
      prompt?: string
      system?: string
      assetId?: string
      images?: { mime?: string; data?: string; dataUrl?: string }[]
      maxTokens?: number
      task?: string
    }) => Promise<IpcResult<{ text: string; provider: { name: string; model: string } | null; model: string | null; usage: unknown }>>
    transcribe: (payload: {
      url: string
      key?: string
      model?: string
      path: string
      language?: string
      responseFormat?: string
    }) => Promise<IpcResult<OrvexMediaTranscribe>>
    subtitles: (payload: {
      url?: string
      key?: string
      model?: string
      path?: string
      language?: string
      format?: 'srt' | 'vtt'
      maxChars?: number
      name?: string
      segments?: OrvexMediaSubtitleSegment[]
    }) => Promise<IpcResult<OrvexMediaSubtitles & { transcript?: string; segments?: OrvexMediaSubtitleSegment[]; language?: string | null }>>
    srt: (payload: { segments: OrvexMediaSubtitleSegment[]; format?: 'srt' | 'vtt'; maxChars?: number }) => Promise<
      IpcResult<{ format: 'srt' | 'vtt'; text: string; cues: number; segments: OrvexMediaSubtitleSegment[] }>
    >
    tts: (payload: {
      url: string
      key?: string
      path?: string
      body: Record<string, unknown>
      ext?: string
      name?: string
    }) => Promise<IpcResult<{ asset: OrvexMediaAsset; bytes: number; contentType: string | null; synthPath: string | null }>>
    heygenVoices: (payload?: { type?: 'public' | 'private' }) => Promise<
      IpcResult<{ voices: { voiceId: string; name: string; language: string; gender: string; preview: string }[]; type: string; pages?: number; complete?: boolean }>
    >
    heygenTtsStream: (payload: {
      id: string
      text: string
      voiceId: string
      model?: string
      language?: string
      speed?: number
    }) => Promise<IpcResult<{ asset: OrvexMediaAsset; model: string; voiceId: string; duration: number | null }>>
    stopHeygenTts: (id: string) => Promise<IpcResult<{ stopped: boolean }>>
    onHeygenAudio: (cb: (event: { id: string; index: number; audio: string }) => void) => () => void
    /** ElevenLabs speech output. Frames are base64 PCM, played as they arrive. */
    elevenVoices: () => Promise<
      IpcResult<{ voices: { voiceId: string; name: string; category: string; labels: Record<string, string> }[]; endpoint: string }>
    >
    elevenModels: () => Promise<IpcResult<{ models: string[]; endpoint: string; source: string }>>
    elevenTtsStream: (payload: {
      id: string
      text: string
      voiceId: string
      model?: string
      speed?: number
      stability?: number
    }) => Promise<IpcResult<{ model: string; voiceId: string; bytes: number; frames: number; sampleRate: number; duration: number }>>
    stopElevenTts: (id: string) => Promise<IpcResult<{ stopped: boolean }>>
    onElevenAudio: (cb: (event: { id: string; index: number; audio: string; sampleRate: number }) => void) => () => void
    heygenTts: (payload: {
      text: string
      voiceId: string
      model?: string
      language?: string
      speed?: number
      pitch?: number
      expressiveness?: number
      seed?: number
    }) => Promise<IpcResult<{ asset: OrvexMediaAsset; model: string; voiceId: string; duration: number | null }>>
    music: (payload: {
      url: string
      key?: string
      body: Record<string, unknown>
      ext?: string
      name?: string
    }) => Promise<IpcResult<{ asset: OrvexMediaAsset; bytes: number; contentType: string | null }>>
    inspect3d: (path: string) => Promise<
      IpcResult<{ name: string; path: string; ext: string; bytes: number; meta: Record<string, unknown> }>
    >
    saveText: (name: string, text: string, ext?: 'txt' | 'md' | 'json') => Promise<IpcResult<OrvexMediaAsset>>
    saveSubtitle: (name: string, text: string, format?: 'srt' | 'vtt') => Promise<IpcResult<OrvexMediaAsset>>
    saveImage: (dataUrl: string, name?: string) => Promise<IpcResult<OrvexMediaAsset>>
    prompts: (filters?: { kind?: string; query?: string; limit?: number }) => Promise<IpcResult<{ total: number; prompts: OrvexMediaPrompt[] }>>
    savePrompt: (payload: {
      id?: string
      title?: string
      text: string
      kind?: string
      tags?: string[]
      favorite?: boolean
    }) => Promise<IpcResult<OrvexMediaPrompt>>
    deletePrompt: (id: string) => Promise<IpcResult<{ deleted: string }>>
    usePrompt: (id: string) => Promise<IpcResult<OrvexMediaPrompt>>
    assetUrl: (id: string) => string
    onChange: (cb: (event: OrvexMediaEvent) => void) => () => void
  }
  code: {
    info: () => Promise<IpcResult<OrvexCodeWorkspace>>
    open: () => Promise<IpcResult<{ cancelled: boolean; info: OrvexCodeWorkspace }>>
    openPath: (dir: string) => Promise<IpcResult<OrvexCodeWorkspace>>
    close: () => Promise<IpcResult<OrvexCodeWorkspace>>
    list: (path: string) => Promise<IpcResult<{ path: string; entries: OrvexCodeEntry[] }>>
    read: (path: string) => Promise<IpcResult<OrvexCodeRead>>
    write: (path: string, content: string) => Promise<IpcResult<{ path: string; bytes: number; mtime: number }>>
    rename: (from: string, to: string) => Promise<IpcResult<{ from: string; to: string }>>
    remove: (path: string) => Promise<IpcResult<{ removed: string; dir: boolean }>>
    search: (
      query: string,
    ) => Promise<IpcResult<{ query: string; matches: OrvexCodeSearchMatch[]; scanned: number; limited: boolean }>>
    gitStatus: () => Promise<IpcResult<OrvexGitStatus>>
    gitDiff: (path?: string, staged?: boolean) => Promise<IpcResult<{ diff: string; truncated: boolean; staged: boolean }>>
    gitStage: (paths: string[]) => Promise<IpcResult<{ staged: string[] }>>
    gitUnstage: (paths: string[]) => Promise<IpcResult<{ unstaged: string[] }>>
    gitCommit: (message: string) => Promise<IpcResult<{ hash: string; output: string }>>
    gitLog: (limit?: number) => Promise<IpcResult<{ entries: OrvexGitLogEntry[] }>>
    gitInit: () => Promise<IpcResult<{ created: boolean }>>
    run: (script: string) => Promise<IpcResult<{ runId: string; command: string; kind: 'script'; cwd: string }>>
    terminal: (
      command: string,
      cwd?: string,
    ) => Promise<IpcResult<{ runId: string; command: string; kind: 'terminal'; cwd: string }>>
    stop: (runId: string) => Promise<IpcResult<{ stopped: boolean }>>
    onOutput: (cb: (event: OrvexCodeRunEvent) => void) => () => void
    onChange: (cb: (info: OrvexCodeWorkspace) => void) => () => void
  }
  research: {
    info: () => Promise<IpcResult<{ reports: number; running: string[]; file: string }>>
    list: () => Promise<IpcResult<OrvexResearchSummary[]>>
    get: (id: string) => Promise<IpcResult<OrvexResearchReport>>
    remove: (id: string) => Promise<IpcResult<{ removed: boolean }>>
    start: (payload: {
      query: string
      depth?: 'quick' | 'standard' | 'deep'
      maxSources?: number
      candidates?: OrvexAgentProvider[]
    }) => Promise<IpcResult<{ runId: string; entry: OrvexResearchSummary }>>
    stop: (runId?: string) => Promise<IpcResult<{ stopped: boolean }>>
    readUrl: (url: string, maxChars?: number) => Promise<IpcResult<OrvexResearchDocument>>
    readFile: () => Promise<IpcResult<{ cancelled: boolean; document: OrvexResearchDocument | null }>>
    saveDocument: (document: {
      title?: string
      url?: string
      kind?: string
      text: string
      mode?: 'markdown' | 'text'
      tables?: number
      warnings?: string[]
    }) => Promise<IpcResult<OrvexResearchReport>>
    exportReport: (id: string) => Promise<IpcResult<{ cancelled: boolean; path: string | null }>>
    openExternal: (url: string) => Promise<IpcResult<{ opened: boolean }>>
    onEvent: (cb: (event: OrvexResearchEvent) => void) => () => void
  }
  desktop: {
    system: () => Promise<IpcResult<OrvexDesktopStatus>>
    metrics: () => Promise<IpcResult<OrvexSystemMetrics>>
    power: (action: 'lock') => Promise<IpcResult<{ locked: true }>>
    volume: (payload?: { level?: number; mute?: boolean }) => Promise<IpcResult<OrvexDesktopVolume>>
    brightness: (payload?: { level?: number }) => Promise<IpcResult<OrvexDesktopBrightness>>
    screenInfo: () => Promise<IpcResult<OrvexDesktopScreenInfo>>
    capture: (payload?: {
      display?: string
      all?: boolean
      region?: { x: number; y: number; width: number; height: number }
    }) => Promise<IpcResult<OrvexDesktopCapture>>
    ocr: (payload?: {
      path?: string
      display?: string
      region?: { x: number; y: number; width: number; height: number }
      lang?: string
    }) => Promise<IpcResult<OrvexDesktopOcr>>
    uiTree: (payload?: {
      title?: string
      handle?: number
      depth?: number
      max?: number
    }) => Promise<IpcResult<OrvexDesktopUiTree>>
    uiAction: (payload: {
      title?: string
      handle?: number
      path: string
      action: 'invoke' | 'click' | 'set_value' | 'toggle' | 'select' | 'expand' | 'collapse' | 'focus' | 'scroll'
      value?: string
    }) => Promise<IpcResult<OrvexDesktopAction>>
    mouseMove: (x: number, y: number) => Promise<IpcResult<OrvexDesktopAction>>
    mouseClick: (payload: { x: number; y: number; button?: string; count?: number }) => Promise<IpcResult<OrvexDesktopAction>>
    mouseScroll: (payload: { amount?: number; x?: number; y?: number }) => Promise<IpcResult<OrvexDesktopAction>>
    mouseDrag: (payload: {
      fromX: number
      fromY: number
      toX: number
      toY: number
      button?: string
      durationMs?: number
    }) => Promise<IpcResult<OrvexDesktopAction>>
    mouseDown: (button?: string) => Promise<IpcResult<OrvexDesktopAction>>
    mouseUp: (button?: string) => Promise<IpcResult<OrvexDesktopAction>>
    keyType: (text: string) => Promise<IpcResult<OrvexDesktopAction>>
    keyPress: (keys: string) => Promise<IpcResult<OrvexDesktopAction>>
    windows: (filters?: {
      filter?: string
      limit?: number
      visibleOnly?: boolean
    }) => Promise<IpcResult<{ output: string; windows: OrvexDesktopWindow[] }>>
    windowAction: (payload: {
      title?: string
      handle?: number
      action: 'focus' | 'minimize' | 'maximize' | 'restore' | 'close'
    }) => Promise<IpcResult<OrvexDesktopAction>>
    apps: (filters?: { filter?: string; limit?: number; force?: boolean }) => Promise<
      IpcResult<{ output: string; apps: OrvexDesktopApp[]; total: number }>
    >
    appLaunch: (payload: { name?: string; appId?: string; path?: string }) => Promise<
      IpcResult<OrvexDesktopAction & { app?: OrvexDesktopApp }>
    >
    screenFind: (payload: {
      text: string
      window?: string
      handle?: number
      source?: 'auto' | 'uia' | 'ocr'
      exact?: boolean
      display?: string
      region?: { x: number; y: number; width: number; height: number }
      lang?: string
      limit?: number
    }) => Promise<IpcResult<OrvexScreenFind>>
    screenClickText: (payload: {
      text: string
      window?: string
      handle?: number
      source?: 'auto' | 'uia' | 'ocr'
      exact?: boolean
      occurrence?: number
      method?: 'auto' | 'mouse'
      uiaAction?: 'click' | 'invoke'
      button?: string
      count?: number
      dryRun?: boolean
      display?: string
      region?: { x: number; y: number; width: number; height: number }
    }) => Promise<IpcResult<OrvexDesktopAction & { match?: OrvexScreenMatch; method?: string }>>
    processes: (filters?: {
      filter?: string
      sort?: 'memory' | 'cpu' | 'name' | 'pid'
      limit?: number
    }) => Promise<IpcResult<{ output: string; processes: OrvexDesktopProcess[]; sort: string }>>
    processKill: (payload: { pid?: number; name?: string }) => Promise<IpcResult<OrvexDesktopAction>>
    clipboardRead: () => Promise<IpcResult<OrvexDesktopClipboard>>
    clipboardWrite: (payload: { text?: string; imagePath?: string }) => Promise<IpcResult<OrvexDesktopAction>>
    recordStart: (payload?: {
      display?: string
      fps?: number
      audio?: 'none' | 'mic' | 'system'
      bitrate?: number
    }) => Promise<IpcResult<OrvexDesktopRecording>>
    recordStop: () => Promise<IpcResult<OrvexDesktopRecording>>
    recordStatus: () => Promise<IpcResult<OrvexDesktopRecording>>
    source: (filePath: string) => Promise<IpcResult<OrvexDesktopSource>>
    exportFile: (filePath: string, name?: string) => Promise<IpcResult<{ cancelled: boolean; path: string | null }>>
    reveal: (filePath: string) => Promise<IpcResult<{ revealed: boolean; path: string }>>
  }
  hands: {
    run: (payload: { goal: string; maxSteps?: number; display?: string }) => Promise<IpcResult<OrvexHandsResult>>
    stop: () => Promise<IpcResult<{ stopped: boolean }>>
    onEvent: (cb: (event: OrvexHandsStep & { type: string; goal?: string }) => void) => () => void
  }
  gamePilot: {
    profiles: () => Promise<IpcResult<OrvexGameProfile[]>>
    status: () => Promise<IpcResult<OrvexGameStatus>>
    saveProfile: (profile: Partial<OrvexGameProfile>) => Promise<IpcResult<OrvexGameProfile>>
    deleteProfile: (id: string) => Promise<IpcResult<{ removed: string }>>
    start: (id: string) => Promise<IpcResult<OrvexGameStatus>>
    stop: () => Promise<IpcResult<{ stopping: boolean }>>
    onEvent: (cb: (event: OrvexGameEvent) => void) => () => void
  }
  integrations: {
    list: () => Promise<IpcResult<OrvexIntegrationList>>
    save: (payload: {
      id?: string
      kind?: string
      label?: string
      config?: Record<string, string>
      secrets?: Record<string, string>
    }) => Promise<IpcResult<OrvexIntegrationConnection>>
    remove: (id: string) => Promise<IpcResult<{ removed: string }>>
    test: (id: string) => Promise<IpcResult<{ ok: boolean; output: string }>>
    run: (payload: { id: string; action: string; args?: Record<string, unknown> }) => Promise<IpcResult<OrvexIntegrationRun>>
    health: () => Promise<IpcResult<OrvexIntegrationHealth>>
    http: (payload: {
      method?: string
      url: string
      headers?: Record<string, string>
      body?: string
      json?: unknown
      timeoutMs?: number
    }) => Promise<IpcResult<OrvexHttpResult>>
    ws: (payload: {
      url: string
      message?: unknown
      messages?: number
      timeoutMs?: number
      headers?: Record<string, string>
      protocols?: string[]
    }) => Promise<IpcResult<OrvexWsResult>>
    webhook: (payload: {
      op: 'status' | 'start' | 'stop' | 'events' | 'clear' | 'test'
      limit?: number
      port?: number
      autostart?: boolean
    }) => Promise<IpcResult<OrvexWebhookStatus & { events?: OrvexWebhookEvent[]; delivery?: OrvexWebhookEvent | null; ok?: boolean }>>
    onChange: (cb: (event: { kind: string; [key: string]: unknown }) => void) => () => void
  }
  connectors: {
    list: () => Promise<IpcResult<{ connectors: OrvexConnector[] }>>
    preview: (payload: { url?: string; spec?: unknown; sourceUrl?: string }) => Promise<IpcResult<OrvexConnectorPreview>>
    save: (payload: {
      id?: string
      label?: string
      url?: string
      spec?: unknown
      sourceUrl?: string
      baseUrl?: string
      auth?: { type: 'none' | 'bearer' | 'header' | 'query'; name?: string }
      secret?: string
      clearSecret?: boolean
    }) => Promise<IpcResult<OrvexConnector>>
    remove: (id: string) => Promise<IpcResult<{ deleted: string }>>
    test: (id: string) => Promise<IpcResult<OrvexConnectorResult>>
    call: (payload: {
      connector: string
      operation: string
      args?: { path?: Record<string, unknown>; query?: Record<string, unknown>; headers?: Record<string, string>; body?: unknown; params?: Record<string, unknown> }
    }) => Promise<IpcResult<OrvexConnectorResult>>
    onChange: (cb: (event: { kind: string; [key: string]: unknown }) => void) => () => void
  }
  maker: {
    list: () => Promise<IpcResult<{ projects: OrvexMakerProject[]; root: string }>>
    templates: () => Promise<IpcResult<OrvexMakerTemplate[]>>
    create: (payload: {
      template: string
      name: string
      title?: string
      description?: string
      paletteSeed?: string
    }) => Promise<IpcResult<OrvexMakerProject>>
    files: (projectId: string, path?: string) => Promise<IpcResult<{ project: OrvexMakerProject; files: OrvexMakerFile[] }>>
    read: (projectId: string, path: string) => Promise<IpcResult<OrvexMakerFileContent>>
    write: (projectId: string, path: string, content: string) => Promise<IpcResult<{ project: OrvexMakerProject; path: string; bytes: number }>>
    preview: (projectId: string) => Promise<IpcResult<{ project: OrvexMakerProject; url: string; port: number; base: string; reused?: boolean }>>
    stopPreview: (projectId: string) => Promise<IpcResult<{ stopped: boolean; project: OrvexMakerProject }>>
    export: (projectId: string, destDir?: string) => Promise<IpcResult<{ project: OrvexMakerProject; file: string; bytes: number }>>
    run: (projectId: string, args?: string[]) => Promise<IpcResult<OrvexMakerRun>>
    remove: (projectId: string) => Promise<IpcResult<{ removed: string }>>
    open: (projectId: string) => Promise<IpcResult<{ opened: boolean; path: string }>>
    reveal: (projectId: string) => Promise<IpcResult<{ revealed: boolean; path: string }>>
    onChange: (cb: (event: { type: string; project?: OrvexMakerProject;[key: string]: unknown }) => void) => () => void
  }
  oauth: {
    state: () => Promise<IpcResult<OrvexOAuthState>>
    device: (payload: {
      provider: string
      clientId: string
      clientSecret?: string
      scopes?: string[]
      label?: string
      deviceUrl?: string
      tokenUrl?: string
      userinfoUrl?: string
    }) => Promise<IpcResult<OrvexOAuthFlow>>
    pkce: (payload: {
      provider: string
      clientId: string
      clientSecret?: string
      scopes?: string[]
      label?: string
      authUrl?: string
      tokenUrl?: string
      userinfoUrl?: string
    }) => Promise<IpcResult<OrvexOAuthFlow>>
    flow: (id: string) => Promise<IpcResult<OrvexOAuthFlow>>
    cancel: (id: string) => Promise<IpcResult<OrvexOAuthFlow>>
    remove: (id: string) => Promise<IpcResult<{ ok: boolean; removed: string }>>
    tokenState: (id: string) => Promise<IpcResult<OrvexOAuthTokenState>>
    check: (id: string) => Promise<IpcResult<OrvexOAuthCheck>>
    onChange: (cb: (event: { kind: string; [key: string]: unknown }) => void) => () => void
  }
  permissions: {
    state: () => Promise<IpcResult<OrvexPermissionsState>>
    set: (tool: string, policy: 'allow' | 'ask' | 'deny' | 'default') => Promise<IpcResult<OrvexPermissionsState>>
    reset: (tool?: string) => Promise<IpcResult<OrvexPermissionsState>>
    addFloor: (floor: { tool: string; pattern: string; note?: string }) => Promise<IpcResult<OrvexPermissionsState>>
    removeFloor: (id: string) => Promise<IpcResult<OrvexPermissionsState>>
  }
  approvalAdvisor: {
    state: () => Promise<IpcResult<OrvexApprovalAdvisorState>>
    add: (rule: { tool: string; pattern: string; reason: string }) => Promise<IpcResult<OrvexApprovalAdvisorState>>
    accept: (id: string) => Promise<IpcResult<OrvexApprovalAdvisorState>>
    remove: (id: string) => Promise<IpcResult<OrvexApprovalAdvisorState>>
    learn: () => Promise<IpcResult<OrvexApprovalAdvisorState & { created: OrvexEscalationRule[] }>>
  }
  mcpServer: {
    status: () => Promise<IpcResult<OrvexMcpServerStatus>>
    start: (payload?: { port?: number; allowRisky?: boolean }) => Promise<IpcResult<OrvexMcpServerStatus>>
    stop: () => Promise<IpcResult<OrvexMcpServerStatus>>
    setAllowRisky: (allowRisky: boolean) => Promise<IpcResult<OrvexMcpServerStatus>>
    onChange: (cb: (event: { kind: string; [key: string]: unknown }) => void) => () => void
  }
  workflows: {
    list: () => Promise<IpcResult<OrvexWorkflowState>>
    save: (definition: OrvexWorkflowDraft) => Promise<IpcResult<OrvexWorkflow>>
    remove: (id: string) => Promise<IpcResult<{ removed: string }>>
    setEnabled: (id: string, enabled: boolean) => Promise<IpcResult<OrvexWorkflow>>
    run: (id: string, input?: Record<string, unknown>) => Promise<IpcResult<OrvexWorkflowRunSummary>>
    runs: (workflowId?: string, limit?: number) => Promise<IpcResult<{ runs: OrvexWorkflowRunSummary[] }>>
    clearRuns: (workflowId?: string) => Promise<IpcResult<{ removed: number; kept: number }>>
    runDetail: (id: string) => Promise<IpcResult<OrvexWorkflowRun>>
    approve: (runId: string, allow: boolean) => Promise<IpcResult<OrvexWorkflowRunSummary>>
    cancel: (runId: string) => Promise<IpcResult<OrvexWorkflowRunSummary>>
    resume: (runId: string) => Promise<IpcResult<OrvexWorkflowRunSummary>>
    templates: () => Promise<IpcResult<{ templates: OrvexWorkflowTemplate[] }>>
    fromTemplate: (templateId: string) => Promise<IpcResult<OrvexWorkflow>>
    tools: () => Promise<IpcResult<{ tools: OrvexWorkflowToolMeta[] }>>
    cron: (expression: string, from?: number) => Promise<IpcResult<{ expression: string; nextAt: number; next: string }>>
    onChange: (cb: (event: { type: string; at: number }) => void) => () => void
  }
  productivity: {
    capabilities: () => Promise<IpcResult<OrvexProductivityCapabilities>>
    calc: (expression: string) => Promise<IpcResult<OrvexProductivityCalc>>
    pythonInfo: () => Promise<IpcResult<OrvexProductivityPythonInfo>>
    runPython: (payload: { code: string; timeoutMs?: number }) => Promise<IpcResult<OrvexProductivityPythonRun>>
    dataAnalyze: (payload: { path: string; sheet?: string }) => Promise<IpcResult<OrvexProductivityAnalysis>>
    dataChart: (payload: { path: string; sheet?: string; x?: string; y: string; kind?: string; agg?: string; limit?: number }) => Promise<IpcResult<OrvexProductivityChart>>
    sheetOpen: (payload: { path: string; sheet?: string; limit?: number }) => Promise<IpcResult<OrvexProductivitySheet>>
    sheetSave: (payload: { path?: string; sheet?: string; headers: string[]; rows: (string | number)[][] }) => Promise<IpcResult<OrvexProductivitySheetSave>>
    sheetCreate: (payload: { path?: string; sheets: { name: string; headers: string[]; rows: (string | number)[][] }[] }) => Promise<IpcResult<OrvexProductivitySheetSave>>
    sqlRun: (payload: { sql: string; limit?: number }) => Promise<IpcResult<OrvexProductivitySqlResult>>
    sqlTables: () => Promise<IpcResult<{ tables: { name: string; type: string; rows: number | null }[]; path: string }>>
    sqlSchema: (table: string) => Promise<IpcResult<{ table: string; sql: string }>>
    reportBuild: (payload: { title: string; format?: 'md' | 'html' | 'docx'; blocks: OrvexProductivityBlock[] }) => Promise<IpcResult<OrvexProductivityReport>>
    transcribeAudio: (payload: { audioPath: string; language?: string; asr?: { url?: string; key?: string; model?: string } }) => Promise<IpcResult<OrvexProductivityTranscript>>
    meetingSummarize: (payload: OrvexProductivityMeetingRequest) => Promise<IpcResult<OrvexProductivityMeeting>>
    noteList: (payload?: { query?: string; project?: string; limit?: number }) => Promise<IpcResult<{ notes: OrvexProductivityNote[]; total: number; query: string | null }>>
    noteCreate: (payload: { title: string; body: string; tags?: string | string[]; project?: string }) => Promise<IpcResult<{ note: OrvexProductivityNote; duplicate: boolean }>>
    noteUpdate: (payload: { id: string; title?: string; body?: string; tags?: string | string[]; project?: string }) => Promise<IpcResult<{ note: OrvexProductivityNote }>>
    noteDelete: (id: string) => Promise<IpcResult<{ removed: string }>>
    noteAsk: (payload: { question: string; project?: string; limit?: number }) => Promise<IpcResult<OrvexMemoryRagResult>>
    taskList: (payload?: { status?: 'open' | 'done' | 'all'; project?: string; query?: string; limit?: number }) => Promise<IpcResult<{ tasks: OrvexProductivityTask[]; status: string }>>
    taskCreate: (payload: { title: string; notes?: string; priority?: number; due?: string | number; project?: string }) => Promise<IpcResult<{ task: OrvexProductivityTask }>>
    taskUpdate: (payload: { id: string; patch: Partial<Pick<OrvexProductivityTask, 'title' | 'notes' | 'priority' | 'dueAt' | 'project' | 'status'>> }) => Promise<IpcResult<{ task: OrvexProductivityTask }>>
    taskToggle: (id: string) => Promise<IpcResult<{ task: OrvexProductivityTask }>>
    taskRemove: (id: string) => Promise<IpcResult<{ removed: string }>>
    taskStats: () => Promise<IpcResult<OrvexProductivityTaskStats>>
    translate: (payload: { text: string; target: string; source?: string }) => Promise<IpcResult<OrvexProductivityTranslation>>
    textList: () => Promise<IpcResult<{ files: OrvexProductivityTextFile[]; dir: string }>>
    textOpen: (name: string) => Promise<IpcResult<OrvexProductivityTextFile>>
    textSave: (payload: { name: string; text: string }) => Promise<IpcResult<OrvexProductivityTextFile>>
    textRemove: (name: string) => Promise<IpcResult<{ removed: string }>>
    textRename: (name: string, newName: string) => Promise<IpcResult<{ from: string; to: string }>>
    slidesBuild: (payload: { title: string; subtitle?: string; theme?: 'dark' | 'light'; slides: { title: string; bullets?: string[]; notes?: string }[] }) => Promise<IpcResult<OrvexProductivitySlides>>
    compareDocs: (payload: { a: string; b: string }) => Promise<IpcResult<OrvexProductivityCompare>>
    artifacts: (payload?: { limit?: number }) => Promise<IpcResult<{ artifacts: OrvexProductivityArtifact[]; total: number; dirs: Record<string, string> }>>
  }
  training: {
    status: () => Promise<IpcResult<OrvexTrainingStatus>>
    usage: () => Promise<IpcResult<OrvexTrainingUsage>>
    setRoot: (dir: string) => Promise<IpcResult<OrvexTrainingStatus>>
    pickRoot: () => Promise<IpcResult<{ cancelled: boolean; status: OrvexTrainingStatus }>>
    setQuota: (bytes: number | string) => Promise<IpcResult<OrvexTrainingStatus>>
    openRoot: () => Promise<IpcResult<{ opened: boolean; root: string }>>
    episodes: (payload?: {
      limit?: number
      kind?: OrvexTrainingEpisodeKind | ''
      status?: OrvexTrainingEpisodeStatus | ''
      query?: string
    }) => Promise<IpcResult<OrvexTrainingEpisode[]>>
    episode: (id: string) => Promise<IpcResult<OrvexTrainingEpisodeDetail | null>>
    deleteEpisode: (id: string) => Promise<IpcResult<{ removed: number }>>
    clearEpisodes: () => Promise<IpcResult<{ removed: number }>>
    stats: () => Promise<IpcResult<OrvexTrainingStats>>
    scoreCurve: (payload?: { days?: number; kind?: OrvexTrainingEpisodeKind | '' }) => Promise<IpcResult<OrvexTrainingScoreCurve>>
    evalPacks: (limit?: number) => Promise<IpcResult<{ packs: OrvexTrainingEvalPack[] }>>
    buildEvalPack: (payload?: { limit?: number; kind?: OrvexTrainingEpisodeKind | ''; name?: string }) => Promise<IpcResult<{
      id: string
      suite: string
      name: string
      builtAt: number
      source: string
      criteria: string[]
      cases: unknown[]
      path: string
      bytes: number
    }>>
    onChange: (cb: (event: OrvexTrainingEvent) => void) => () => void
  }
  localBrain: {
    status: () => Promise<IpcResult<OrvexBrainStatus>>
    models: (payload?: { hash?: boolean; dir?: string }) => Promise<IpcResult<OrvexBrainScan>>
    refresh: (hash?: boolean) => Promise<IpcResult<OrvexBrainScan>>
    config: (patch?: Partial<OrvexBrainConfig>) => Promise<IpcResult<OrvexBrainConfig>>
    runtime: () => Promise<IpcResult<OrvexBrainRuntime>>
    start: (id?: string) => Promise<IpcResult<OrvexBrainStatus>>
    stop: () => Promise<IpcResult<OrvexBrainStatus>>
    chat: (payload: {
      messages: { role: string; content: string }[]
      temperature?: number
      maxTokens?: number
      grammar?: string
      jsonSchema?: Record<string, unknown>
    }) => Promise<IpcResult<{ choices?: { message?: { content?: string } }[] } & Record<string, unknown>>>
    route: (payload?: { task?: string }) => Promise<IpcResult<OrvexBrainRoute>>
    grammar: () => Promise<IpcResult<{ grammar: string }>>
    hash: (id: string) => Promise<IpcResult<{ id: string; sha256: string; bytes: number }>>
    onChange: (cb: (event: OrvexBrainEvent) => void) => () => void
  }
  learner: {
    status: () => Promise<IpcResult<OrvexLearnerStatus>>
    suggestions: () => Promise<IpcResult<{ suggestions: OrvexLearnerSuggestion[] }>>
    skills: (payload?: { status?: string; limit?: number }) => Promise<IpcResult<{ skills: OrvexLearnerSkill[] }>>
    skillPrompt: (id: string) => Promise<IpcResult<{ prompt: string | null }>>
    trainKits: (limit?: number) => Promise<IpcResult<{ kits: OrvexLearnerKit[] }>>
    models: () => Promise<IpcResult<{ models: OrvexLearnerModel[] }>>
    finetunes: (limit?: number) => Promise<IpcResult<{ runs: OrvexLearnerFinetune[] }>>
    nanos: () => Promise<IpcResult<{ models: OrvexLearnerNanoModel[]; active: OrvexLearnerNanoActive | null }>>
    predict: (payload: { goal: string; kind?: string; steps?: number; promptTokens?: number; completionTokens?: number; cost?: number }) => Promise<IpcResult<{
      modelId: string
      probability: number
      verdict: 'likely-success' | 'likely-failure'
      accuracy: number | null
      holdout: boolean
    } | null>>
    trainNano: (payload?: { minSamples?: number; epochs?: number }) => Promise<IpcResult<OrvexLearnerTrainResult>>
    rollbackNano: () => Promise<IpcResult<{ from: string; to: string | null }>>
    compileSkill: (payload: { episodeId: string; name?: string }) => Promise<IpcResult<{
      id: string
      name: string
      version: string
      when: string
      steps: unknown[]
      successCheck: string
      avoid: string[]
      status: string
      updated: boolean
    }>>
    setSkillStatus: (payload: { id: string; status: 'suggested' | 'active' | 'disabled' }) => Promise<IpcResult<{ id: string; status: string }>>
    saveSkill: (payload: {
      id?: string
      name: string
      when: string
      steps: { tool: string; args?: Record<string, unknown>; ok?: boolean }[]
      successCheck?: string
      avoid?: string[]
      activate?: boolean
    }) => Promise<IpcResult<{ id: string; name: string; version: string; status: string; when: string; steps: number; updated: boolean }>>
    exportSkill: (id: string) => Promise<IpcResult<{
      bundle: {
        format: 'orvex-skill'
        formatVersion: number
        id: string
        name: string
        version: string
        status: string
        skill: { name: string; when: string; steps: { tool: string; args: Record<string, unknown>; ok: boolean }[]; successCheck: string; avoid: string[]; guide?: string; allowedTools?: string[] }
      }
    }>>
    exportSkills: () => Promise<IpcResult<{
      format: 'orvex-skill-pack'
      formatVersion: number
      exportedAt: number
      skills: { name: string; when: string; steps: { tool: string; args: Record<string, unknown>; ok: boolean }[]; successCheck: string; avoid: string[]; guide?: string; allowedTools?: string[] }[]
    }>>
    importSkill: (payload: { skill?: unknown; text?: string; filename?: string; activate?: boolean }) => Promise<IpcResult<{
      id?: string
      name?: string
      status?: string
      count?: number
      imported?: unknown[]
    }>>
    deleteSkill: (id: string) => Promise<IpcResult<{ removed: number }>>
    buildTrainKit: (payload?: { limit?: number; name?: string }) => Promise<IpcResult<{
      id: string
      name: string
      items: number
      baseModel: string
      path: string
      dataset: string
      datasetBytes: number
      files: { name: string; bytes: number; sha256: string }[]
    }>>
    pickGguf: () => Promise<IpcResult<{ cancelled: boolean; file: string | null }>>
    importGguf: (payload: { source: string; name?: string }) => Promise<IpcResult<{
      imported: boolean
      duplicate: boolean
      path: string
      sha256: string
      id?: string
      name?: string
      bytes?: number
      meta?: unknown
    }>>
    deleteModel: (id: string) => Promise<IpcResult<{ removed: number; path: string }>>
    finetune: (payload: {
      providerId: string
      baseUrl: string
      model: string
      trainKitId: string
      suffix?: string
      epochs?: number
      batchSize?: number
      learningRateMultiplier?: number
    }) => Promise<IpcResult<{ id: string; remoteId: string; fileId: string; status: string; model: string }>>
    finetuneStatus: (id: string) => Promise<IpcResult<{ id: string; status: string; remoteStatus?: string; fineTunedModel: string | null }>>
    finetuneCancel: (id: string) => Promise<IpcResult<{ id: string; status: string }>>
    cycle: () => Promise<IpcResult<OrvexLearnerCycle>>
    onChange: (cb: (event: OrvexLearnerEvent) => void) => () => void
  }
  workforce: {
    status: () => Promise<IpcResult<OrvexWorkforceStatus>>
    agents: (payload?: { status?: string }) => Promise<IpcResult<{ agents: OrvexWorkforceAgent[] }>>
    agent: (id: string) => Promise<IpcResult<OrvexWorkforceAgent | null>>
    createAgent: (payload: {
      name: string
      role?: string
      mission: string
      model?: OrvexWorkforceModel | null
      schedule?: string | null
      budgetUsd?: number
    }) => Promise<IpcResult<OrvexWorkforceAgent>>
    updateAgent: (payload: {
      id: string
      name?: string
      role?: string
      mission?: string
      model?: OrvexWorkforceModel | null
      schedule?: string | null
      budgetUsd?: number
      status?: 'active' | 'paused'
    }) => Promise<IpcResult<OrvexWorkforceAgent>>
    deleteAgent: (id: string) => Promise<IpcResult<{ deleted: string }>>
    pauseAgent: (id: string) => Promise<IpcResult<OrvexWorkforceAgent>>
    resumeAgent: (id: string) => Promise<IpcResult<OrvexWorkforceAgent>>
    startShift: (id: string, goal?: string) => Promise<IpcResult<OrvexWorkforceShift>>
    shifts: (payload?: { agentId?: string; limit?: number }) => Promise<IpcResult<{ shifts: OrvexWorkforceShift[] }>>
    shift: (id: string) => Promise<IpcResult<OrvexWorkforceShift | null>>
    inbox: (payload?: { limit?: number; unreadOnly?: boolean }) => Promise<IpcResult<{ messages: OrvexWorkforceMessage[] }>>
    readInbox: (payload: { id?: string; all?: boolean }) => Promise<IpcResult<{ updated: number; unread: number }>>
    clearInbox: () => Promise<IpcResult<{ removed: number }>>
    tick: () => Promise<IpcResult<{ started: string[]; skipped: string | null }>>
    onChange: (cb: (event: OrvexWorkforceEvent) => void) => () => void
  }
  advanced: {
    status: () => Promise<IpcResult<OrvexAdvancedStatus>>
    mode: (mode?: OrvexAdvancedMode) => Promise<IpcResult<OrvexAdvancedModeStatus>>
    context: () => Promise<IpcResult<OrvexAdvancedContext>>
    suggest: (payload?: { provider?: OrvexAgentProvider; candidates?: OrvexAgentProvider[]; task?: string }) => Promise<IpcResult<{ suggestions: OrvexAdvancedSuggestion[]; method: string; model?: string | null; note?: string }>>
    approve: (id: string, allow: boolean) => Promise<IpcResult<{ resolved: boolean }>>
    rules: () => Promise<IpcResult<{ rules: OrvexProactiveRule[]; events: OrvexProactiveRuleEvent[] }>>
    saveRule: (rule: {
      id?: string
      name?: string
      condition: OrvexProactiveRule['condition']
      action: OrvexProactiveRule['action']
      enabled?: boolean
      cooldownSec?: number
    }) => Promise<IpcResult<OrvexProactiveRule>>
    deleteRule: (id: string) => Promise<IpcResult<{ removed: number }>>
    enableRule: (id: string, enabled: boolean) => Promise<IpcResult<{ id: string; enabled: boolean }>>
    tickRules: () => Promise<IpcResult<OrvexAdvancedStatus['lastTick']>>
    selfEval: (payload: {
      goal: string
      output: string
      criteria?: string[]
      provider?: OrvexAgentProvider
      candidates?: OrvexAgentProvider[]
    }) => Promise<IpcResult<OrvexSelfEval>>
    evalHistory: (limit?: number) => Promise<IpcResult<OrvexSelfEval[]>>
    routeStats: (task?: string, days?: number) => Promise<IpcResult<OrvexRouteStat[]>>
    recommendRoute: (payload: { task?: string; provider?: OrvexAgentProvider; candidates?: OrvexAgentProvider[] }) => Promise<IpcResult<OrvexRouteRecommendResult>>
    applyRoute: (task: string, chain: { providerId?: string; id?: string; model: string }[]) => Promise<IpcResult<{ task: string; chain: { providerId: string; model: string }[] }>>
    learning: (status?: string) => Promise<IpcResult<OrvexLearningSuggestion[]>>
    mineLearning: (days?: number) => Promise<IpcResult<{ suggested: number; items: OrvexLearningSuggestion[] }>>
    approveLearning: (id: string) => Promise<IpcResult<{ id: string; status: string; applied?: boolean }>>
    dismissLearning: (id: string) => Promise<IpcResult<{ id: string; status: string }>>
    jobs: (limit?: number) => Promise<IpcResult<OrvexAdvancedJob[]>>
    job: (id: string) => Promise<IpcResult<OrvexAdvancedJob | null>>
    createJob: (job: { title?: string; steps: OrvexAdvancedJobStep[]; stopOnError?: boolean }) => Promise<IpcResult<OrvexAdvancedJob>>
    startJob: (id: string) => Promise<IpcResult<OrvexAdvancedJob>>
    pauseJob: (id: string) => Promise<IpcResult<OrvexAdvancedJob>>
    resumeJob: (id: string) => Promise<IpcResult<OrvexAdvancedJob>>
    cancelJob: (id: string) => Promise<IpcResult<OrvexAdvancedJob>>
    deleteJob: (id: string) => Promise<IpcResult<{ removed: number }>>
    recovery: () => Promise<IpcResult<OrvexRecoveryOverview>>
    resumeRecovery: (payload: {
      kind: 'run' | 'workflow' | 'job'
      id: string
      provider?: OrvexAgentProvider
      candidates?: OrvexAgentProvider[]
    }) => Promise<IpcResult<unknown>>
    discardRecovery: (kind: 'run' | 'workflow' | 'job', id: string) => Promise<IpcResult<unknown>>
    collab: {
      agents: () => Promise<IpcResult<{ agents: OrvexCollabAgent[]; caps: { maxAgents: number; maxRounds: number } }>>
      saveAgent: (agent: { id?: string; name: string; role?: string; prompt: string }) => Promise<IpcResult<OrvexCollabAgent>>
      deleteAgent: (id: string) => Promise<IpcResult<{ removed: number }>>
      sessions: (limit?: number) => Promise<IpcResult<OrvexCollabSession[]>>
      session: (id: string) => Promise<IpcResult<OrvexCollabSessionDetail | null>>
      start: (payload: {
        goal: string
        agentIds?: string[]
        rounds?: number
        provider?: OrvexAgentProvider
        candidates?: OrvexAgentProvider[]
        sensitive?: boolean
      }) => Promise<IpcResult<OrvexCollabSession>>
      stop: (id: string) => Promise<IpcResult<{ stopped: boolean }>>
      deleteSession: (id: string) => Promise<IpcResult<{ removed: number }>>
    }
    vision: {
      capture: (args?: { display?: string | number; region?: { x: number; y: number; width: number; height: number }; all?: boolean }) => Promise<IpcResult<{ ok: boolean; file: string; url: string; width?: number; height?: number }>>
      ocr: (args?: { path?: string; display?: string | number; region?: { x: number; y: number; width: number; height: number } }) => Promise<IpcResult<{ text: string; lines: unknown[]; lang: string; width: number; height: number; file: string | null; url: string | null }>>
      analyze: (payload: {
        prompt?: string
        provider?: OrvexAgentProvider
        candidates?: OrvexAgentProvider[]
        path?: string
        dataUrl?: string
        capture?: Record<string, unknown>
        ocr?: boolean
        sensitive?: boolean
      }) => Promise<IpcResult<OrvexVisionResult>>
    }
    plugins: {
      list: () => Promise<IpcResult<{ plugins: OrvexPluginInfo[]; catalogUrl: string }>>
      installDir: (dir?: string) => Promise<IpcResult<{ cancelled: boolean; plugin: OrvexPluginInfo | null }>>
      installCatalog: (id: string) => Promise<IpcResult<OrvexPluginInfo>>
      catalog: (refresh?: boolean) => Promise<IpcResult<OrvexMarketCatalog>>
      setCatalogUrl: (url: string) => Promise<IpcResult<{ url: string }>>
      catalogKeys: () => Promise<IpcResult<{ keys: OrvexCatalogKey[]; requireSignature: boolean }>>
      setCatalogKeys: (text: string) => Promise<IpcResult<{ keys: OrvexCatalogKey[] }>>
      setRequireSignature: (value: boolean) => Promise<IpcResult<{ requireSignature: boolean }>>
      enable: (id: string, enabled: boolean) => Promise<IpcResult<{ id: string; enabled: boolean }>>
      uninstall: (id: string) => Promise<IpcResult<{ removed: number }>>
    }
    devices: {
      info: () => Promise<IpcResult<{ device: OrvexDeviceInfo; host: OrvexDeviceHostStatus; devices: OrvexDeviceLink[]; log: OrvexSyncLogRow[] }>>
      setName: (name: string) => Promise<IpcResult<{ name: string }>>
      hostStart: (port?: number) => Promise<IpcResult<OrvexDeviceHostStatus & { code: string; expiresAt: number }>>
      hostStop: () => Promise<IpcResult<OrvexDeviceHostStatus>>
      pairCode: () => Promise<IpcResult<{ code: string; expiresAt: number }>>
      discover: (timeoutMs?: number) => Promise<IpcResult<{ devices: (OrvexDeviceInfo & { host: string; port: number })[]; note: string | null }>>
      pair: (payload: { host: string; port?: number; code: string; name?: string }) => Promise<IpcResult<{ device: OrvexDeviceInfo & { host: string; port: number }; pairedAt: number }>>
      check: (id: string) => Promise<IpcResult<{ ok: boolean; device: OrvexDeviceInfo }>>
      pull: (id: string) => Promise<IpcResult<{ applied: Record<string, number>; from: OrvexDeviceInfo | null }>>
      push: (id: string) => Promise<IpcResult<{ applied: Record<string, number> }>>
      unpair: (id: string) => Promise<IpcResult<{ removed: number }>>
    }
    a2a: {
      status: () => Promise<IpcResult<OrvexA2aStatus>>
      hostStart: (payload?: { port?: number; expose?: 'loopback' | 'lan' }) => Promise<IpcResult<OrvexA2aStatus>>
      hostStop: () => Promise<IpcResult<OrvexA2aStatus>>
      rotateToken: () => Promise<IpcResult<{ token: string }>>
      peerAdd: (payload: { name?: string; url: string; token: string }) => Promise<IpcResult<{ peer: OrvexA2aPeer }>>
      peerRemove: (id: string) => Promise<IpcResult<{ removed: number }>>
      peerCard: (url: string) => Promise<IpcResult<{ url: string; card: OrvexA2aCardSummary }>>
      send: (payload: { peerId: string; text: string; timeoutMs?: number }) => Promise<IpcResult<{ task: OrvexA2aTask; remoteId: string | null; error?: string }>>
      tasks: (payload?: { limit?: number; direction?: 'inbound' | 'outbound' }) => Promise<IpcResult<{ tasks: OrvexA2aTask[] }>>
      task: (id: string) => Promise<IpcResult<OrvexA2aTask | null>>
      cancel: (id: string) => Promise<IpcResult<OrvexA2aTask>>
    }
    onEvent: (cb: (event: OrvexAdvancedEvent) => void) => () => void
  }
  air: {
    onStop: (cb: () => void) => () => void
  }
}

declare global {
  interface Window {
    orvex?: OrvexBridge
  }
}
