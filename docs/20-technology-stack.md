# ORVEX — Technology Stack (Section 20)

Verified against `package.json`, `electron/`, `src/` and the built artifacts in `release/win-unpacked` on 2026-11-03.

## 1. Runtime and shell

| Layer | Technology | Version | Role |
| --- | --- | --- | --- |
| Desktop shell | Electron | 33.4.11 | Native windows, tray, global shortcuts, screen capture, safeStorage (DPAPI), child processes |
| Embedded Node | Node.js | 20.18.3 (inside Electron) | Main-process modules, plugin sandbox, test harnesses |
| Packaged output | electron-builder | 26.18.0 | `release/win-unpacked/ORVEX.exe`, NSIS installer, portable build |
| Single-instance | Electron `requestSingleInstanceLock` | — | One window per profile; second launch focuses the first |

The renderer is sandboxed (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`). All privileged work happens in the main process behind an IPC contract of `{ ok: true, data }` / `{ ok: false, error }`.

## 2. Renderer

| Concern | Technology | Version | Notes |
| --- | --- | --- | --- |
| UI library | React | 18.3.1 | Function components, hooks only |
| Language | TypeScript | 5.6.3 | `tsc -b` runs before every build; no `any` in page code |
| Bundler | Vite | 5.4.x | `dist/` is loaded from disk by the packaged app |
| Styling | Hand-written CSS + Tailwind 3.4 | — | Page-scoped stylesheets (`advanced.css`, `productivity.css`, …) imported in `src/main.tsx` |
| Graphs | React Flow | 11.11.4 | Workflow builder on the Automation page |
| Motion | framer-motion | 11.x | Page transitions and panels |
| Icons | lucide-react | 0.469.0 | Single icon set across all pages |
| Markdown | react-markdown + remark-gfm | 9.x / 4.x | Chat, research and note rendering |
| Charts | Custom CSS/SVG | — | Real values from IPC; no charting library |

Renderer structure:

- `src/App.tsx` — shell, navigation (27 destinations), page router, lock screen mount.
- `src/pages/` — 26 routed pages; `AdvancedPage.tsx` is the Section 19 surface with 10 tabs.
- `src/types/desktop.d.ts` — the full `window.orvex` bridge type contract.
- `src/data/routing.ts` — candidate ordering, task presets and routing persistence shared by Chat/Engine.
- `src/hooks/` — bridge wrappers, event subscription, voice/air-touch state.
- `src/voice/`, `src/airtouch/` — MediaPipe hand tracking and speech pipeline.

## 3. Main process modules

| Module | Responsibility |
| --- | --- |
| `main.cjs` | Window lifecycle, all IPC handlers, gateway wiring, quit cleanup, tool registry composition |
| `preload.cjs` | `contextBridge` surface (`window.orvex`), event subscription, no Node access |
| `db.cjs` | SQLite schema, settings, usage, routing, audit, runs/checkpoints |
| `guardrails.cjs` | Path/command/URL policy; blocks system folders, credential stores, private keys, whole drives |
| `permissions.cjs` | Per-tool allow / ask / deny policy plus always-on approval floors that auto-approve cannot skip |
| `security.cjs` | PIN + lockout, RBAC, rate limits, command/network allowlists, emergency stop, backups, injection scan |
| `vault.cjs` | Encrypted secret storage via Electron safeStorage; values never returned to the renderer |
| `model-gateway.cjs` | Provider calls, local/cloud candidates, failover, health, outcome observer, token/cost accounting, inter-chunk stall watchdog |
| `agent.cjs` | Tool-calling loop, approvals, checkpoints, resume |
| `orchestrator.cjs` | Multi-step plans over agent runs |
| `tools.cjs` | Tool definitions and execution adapters |
| `browser.cjs` / `web.cjs` | Playwright-core automation and HTTP fetch/search |
| `code.cjs` | Workspace fs, git, process runner, terminal |
| `research.cjs` / `documents.cjs` | Document extraction (PDF, DOCX, OCR), research orchestration, library |
| `memory.cjs` | SQLite FTS5 + embeddings, RAG search |
| `files.cjs` | Real fs operations, duplicates, archive, versions, watcher, backup |
| `media-server.cjs` / `creative.cjs` | Provider-backed image/video/music/TTS generation (incl. HeyGen Voice Turbo), media library, protocol URLs |
| `productivity.cjs` | Calculator, Python, spreadsheet, SQL console, reports, notes, tasks, text, slides, diff |
| `desktop.cjs` / `monitor.cjs` | System status, volume/brightness/media keys, health probes, metrics; UI Automation tree/act with post-action verification |
| `integrations.cjs` / `oauth.cjs` / `mcp.cjs` / `mcp-server.cjs` | Connections, REST/WS/webhooks, OAuth, MCP client and server |
| `workflows.cjs` | Graph execution, cron, queue, approvals, history, resume |
| `advanced.cjs` | Privacy modes, proactive rules, self-eval, autonomous jobs, routing advice, learning, recovery (Section 19) |
| `collab.cjs` | Multi-agent teams: planner, researcher, builder, critic, synthesizer |
| `vision.cjs` | Windows OCR + multimodal model calls on screen/file/camera frames |
| `plugins.cjs` | Manifest validation, sandboxed child host, tool registration, sha256 marketplace |
| `devices.cjs` | LAN pairing (6-digit code), HTTP sync, UDP discovery, whitelisted bundles |
| `training.cjs` / `local-brain.cjs` / `learner.cjs` | Episode vault and quota, daily score curve, eval packs; llama.cpp runtime manager and GGUF cache; skills with a progressive catalog and `skill_load`, nano scorer, Train Kit and fine-tune client |
| `workforce.cjs` / `connectors.cjs` | Persistent scheduled agents with budget pause, shift reports and inbox; real OpenAPI connectors bound to the vault |
| `hands.cjs` / `maker.cjs` | Bounded vision-action loop with stop/emergency stop; project scaffolding, palette/logo, live preview, zip export and 20 s CLI runner |
| `advisor.cjs` | Real-state signal collection, ranked suggestions with dismissals, daily brief, daily/monthly budgets and the update-feed check |
| `plan-todos.cjs` / `delegates.cjs` | Run-scoped todo plan injected into the agent prompt; background sub-agent registry with concurrency caps, parent-abort propagation and unattended tool refusal |
| `tool-args.cjs` / `stream-watchdog.cjs` | Schema-guided argument repair applied before permission floors and approval; inter-chunk stream stall detector that aborts and fails over |
| `pricing.cjs` | Model pricing tables for honest cost accounting |

## 4. Data layer

One SQLite database per profile (`%APPDATA%\orvex\orvex.db`, isolated in tests via `ORVEX_USER_DATA_DIR`) through **better-sqlite3 11.10.0** (native, unpacked from asar). The portable build keeps its profile in `ORVEX-data` beside the executable so the whole app moves with the `.exe`.

Table groups:

- Core: `settings`, `usage`, `provider_health`, `routing`, `conversations`, `messages`, `memory_items`.
- Execution: `runs`, `run_steps`, `workflows`, `workflow_runs`, `jobs`, `tasks`.
- Observability: `audit`, `assets`, `evals`, `metrics`, `eval_suites`, `crashes`, `prompts`.
- Section 19: `adv_agents`, `adv_sessions`, `adv_messages`, `adv_rules`, `adv_rule_events`, `adv_jobs`, `adv_selfevals`, `adv_route_outcomes`, `adv_learning`, `adv_devices`, `adv_sync_log`, `adv_plugins`, `adv_market_cache`.

WAL mode, single writer, prepared statements, and JSON columns for flexible specs. The renderer never touches the file directly; every read/write is an IPC call.

Large tool output is spilled to `<userData>\tool-outputs\<runId>\` as plain `.txt` (256 KB cap, pruned after 7 days or 500 files) and never stored when the credential tripwire matches. Per-run todo plans and background sub-agent state are in-memory only and are cleared with their parent run.

## 5. AI and media integration

| Capability | Implementation |
| --- | --- |
| Providers | OpenAI-compatible and Anthropic APIs over `fetch`; presets for OpenAI, Anthropic, Gemini (OpenAI-compatible), Groq, Mistral, DeepSeek, xAI, OpenRouter, Together, Cerebras, Ollama, LM Studio, llama.cpp, custom |
| Local models | Any OpenAI-compatible localhost endpoint; local endpoints are detected for privacy modes |
| Failover | Ordered candidates, health circuit breaker, per-call outcome recording, measured stats (calls, success rate, p50 latency) |
| Vision | Windows OCR via OS APIs + image blocks to multimodal models; screen, file path or base64 camera frame |
| Image generation | `@mediapipe/tasks-vision` 1.2.0 for in-app vision tasks; generation only through configured provider keys (no synthetic results) |
| Speech | System speech APIs + local TTS servers + HeyGen Voice Turbo (cloud, vault-bound key); wake word, barge-in, speaker verification |
| Documents | `pdfjs-dist`, `mammoth`, `xlsx`, `docx`, `pptxgenjs`, `pdf-lib`, `sharp` |
| Media | `music-metadata`, provider TTS/music, video frame extraction |
| Email | `nodemailer`, `imapflow`, `mailparser` |
| Databases | Scratch SQLite console; `pg` for user PostgreSQL connections |

## 6. Security stack

1. **Guardrails** — path checks before every file operation; command analysis; URL policy.
2. **Permissions** — every tool is allow / ask / deny; mutating tools always pass through approval.
3. **Approvals** — renderer banner for agent runs and autonomous jobs (`jobId:stepIndex`, 120 s timeout, denial is final for that step).
4. **Secrets** — write-only vault; API keys are never printed, returned to the renderer, or included in audit rows, bundles or backups in plaintext.
5. **At-rest** — Electron `safeStorage` (Windows DPAPI); optional PIN lock with scrypt hashing and escalating lockouts.
6. **Runtime policy** — RBAC role, sliding-window rate limits, command allowlist, network allowlist, emergency stop.
7. **Plugin isolation** — Node permission model: read only the plugin folder, write only its data folder; child processes, workers and native addons denied; network explicitly documented as unrestricted.
8. **Device sync** — LAN-only server plus a required sync header (blocks drive-by web requests), 6-digit code with 10-minute TTL, five-attempt lockout, bearer token, sha256 integrity, a validated privacy mode, whitelisted tables (no secrets, vault, usage or audit), and discovery replies limited to private addresses.
9. **Escalation rules** — owner-defined regex rules over a tool and its arguments can only add an approval prompt or a denial; there is no allow path, auto-approve cannot skip a match, unattended sub-agents refuse it, and rules learned from repeated refusals stay inactive until the owner accepts them.
10. **Durable delegation** — child tasks are recorded in SQLite, open ones are marked `interrupted` at startup, and a resume link prevents the same task being re-run twice.

## 7. Build, test and release tooling

| Script | Purpose |
| --- | --- |
| `npm run build` | `tsc -b` + Vite production build |
| `npm run dist:dir` | Unpacked Windows build in `release/win-unpacked` |
| `npm run dist` | NSIS installer + portable executable |
| `npm run test` | Vitest unit + adversarial security suites (362 tests) |
| `npm run test:smoke` | Self-contained backend smokes for advanced, memory and productivity |
| `npm run test:e2e` / `test:e2e:source` | Playwright Electron e2e, packaged / source (122 checks) |
| `npm run test:visual` | Sharp pixel comparison against `tests/visual/baselines` |
| `npm run test:bench` | Real micro-benchmarks with p50/p95 (19 suites) |
| `npm run test:eval` | Agent evaluation CLI; exits 2 with an honest SKIP when no eval credentials are supplied |
| `smoke:*` | 44+ backend and CDP UI suites, one pair per feature section |
| `smoke:advanced` / `smoke:advanced-ui` | Section 19 backend (92 checks) / UI (42 checks) |

## 8. Version matrix (production dependencies)

`@mediapipe/tasks-vision` 1.2.0 · `ajv` 8.20 · `archiver` 7.0.1 · `better-sqlite3` 11.10 · `chokidar` 4.0.3 · `diff` 9.0 · `docx` 9.15 · `framer-motion` 11.11.17 · `imapflow` 2.10 · `lucide-react` 0.469 · `mailparser` 3.14.1 · `mammoth` 1.9.1 · `music-metadata` 7.14 · `nodemailer` 10.3.1 · `pdf-lib` 1.17.1 · `pdfjs-dist` 4.10.38 · `pg` 8.23.1 · `playwright-core` 1.64.1 · `pptxgenjs` 4.0.1 · `prebuild-install` 7.1.3 · `react`/`react-dom` 18.3.1 · `react-markdown` 9.0.3 · `reactflow` 11.11.4 · `remark-gfm` 4.0.0 · `sharp` 0.33.5 · `unzipper` 0.12.5 · `ws` 8.22.1 · `xlsx` 0.18.5.

## 9. Why these choices

- **Electron + React** keeps one codebase for a desktop-class UI with real OS access, required for screen OCR, window control, global shortcuts and device sync.
- **better-sqlite3** gives synchronous, transactional local state without a server; the DB is the single source of truth for routing, learning and recovery.
- **Node 20 permission model for plugins** reuses the OS runtime's own isolation instead of a custom JS sandbox, so escapes require Node itself to fail.
- **Playwright** is used both for browser automation (user feature) and for e2e verification (test feature) — the same real Chromium path in both cases.
- **MediaPipe Tasks Vision** runs hand tracking locally in the renderer, avoiding a cloud round trip for Air Touch.
- **MCP** is implemented on both sides (client and server), so ORVEX can consume external tools and expose its own with the same schema.
