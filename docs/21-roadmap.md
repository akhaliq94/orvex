# ORVEX — Five-Phase Roadmap (Section 21)

Status as of 2026-11-03: all five original phases are implemented in the v1.0.0 codebase, and the post-release phases 6–10 are in place with honest limits recorded below. Every "done" item is backed by code, a smoke suite and a green test run; items that need a dependency this machine does not have are listed as unavailable instead of claimed.

## Phase 1 — Foundation and desktop shell (done)

**Goal:** a secure Electron shell with local state and a typed bridge.

| Deliverable | Where | Verification |
| --- | --- | --- |
| Electron main + preload bridge (`{ok,data}` contract) | `electron/main.cjs`, `electron/preload.cjs` | e2e bridge check, 30 namespaces |
| SQLite schema, settings, audit, usage | `electron/db.cjs` | unit + e2e DB probe |
| Window controls, tray, mini window, command palette | `electron/main.cjs`, `src/MiniWindow.tsx` | `smoke:window-ui`, `smoke:desktop` |
| Guardrails for paths, commands, URLs | `electron/guardrails.cjs` | 14 unit tests + 21 adversarial tests |
| Permissions and approvals | `electron/permissions.cjs`, agent loop | `smoke:security`, approval smoke |
| Encrypted vault | `electron/vault.cjs` | security suite, secret-metadata check |
| Installer and unpacked build | `electron-builder` config | `release/win-unpacked/ORVEX.exe` |

**Exit criteria met:** app boots with all 27 navigation destinations; DB opens in the isolated profile; no demo copy on any page.

## Phase 2 — Agent runtime, models and tools (done)

**Goal:** a real tool-calling agent with provider failover and honest accounting.

| Deliverable | Where | Verification |
| --- | --- | --- |
| Model gateway, presets, local endpoints, health, failover | `electron/model-gateway.cjs` | gateway smoke, e2e prefs/usage |
| Agent loop with provider failover and step limits | `electron/agent.cjs` | agent smoke, e2e |
| Orchestrator for resumable multi-step plans | `electron/orchestrator.cjs` | `smoke:orchestrator` |
| Stale-run normalization and plan auto-resume on launch | `electron/db.cjs`, `electron/run-recovery.cjs`, `electron/main.cjs` | recovery unit tests, `smoke:advanced` |
| Tool registry and 90 permission entries | `electron/tools.cjs` | e2e permissions count, security smoke |
| Routing persistence and task presets | `src/data/routing.ts`, `db.routing` | routing unit tests, e2e |
| Usage, cost and pricing | `db.usage`, `electron/pricing.cjs` | usage unit tests, bench |

**Exit criteria met:** no provider key is required to boot; missing models fail with explicit messages; every call is measured.

## Phase 3 — Knowledge, content and productivity (done)

**Goal:** real files, documents, memory and content creation without placeholders.

| Deliverable | Where | Verification |
| --- | --- | --- |
| Document extraction (PDF/DOCX/XLSX/OCR) and library | `electron/documents.cjs`, `electron/research.cjs` | documents unit tests, research smokes |
| Memory: FTS5 + embeddings + RAG | `electron/memory.cjs` | memory smoke + UI smoke |
| Files: duplicates, archive, versions, watcher, backups | `electron/files.cjs` | files smokes |
| Media: library, provider generation, frames, TTS/music, 3D | `electron/media-server.cjs`, `electron/creative.cjs` | media smokes; generation refused without keys |
| Productivity workbench (calculator → slides) | `electron/productivity.cjs` | 22 unit tests, 65-check backend smoke, 12-tab e2e |
| Code workspace, git and terminal | `electron/code.cjs` | code smokes |
| Browser automation | `electron/browser.cjs` | browser smoke |

**Exit criteria met:** every artifact is written to disk and indexed; unavailable services return errors instead of fabricated output.

## Phase 4 — Operations, control and defense (done)

**Goal:** command the machine and the network with policy in front of every action.

| Deliverable | Where | Verification |
| --- | --- | --- |
| Desktop control: volume, brightness, media keys, status | `electron/desktop.cjs` | control smokes |
| Monitoring: 12 live health probes, metrics, crashes | `electron/monitor.cjs` | 99-check monitor smoke |
| Integrations: REST/WS, webhooks, OAuth, Postgres, storage | `electron/integrations.cjs`, `electron/oauth.cjs` | integrations smokes |
| MCP client and server | `electron/mcp.cjs`, `electron/mcp-server.cjs` | integrations + MCP smoke |
| Workflow engine: graph, cron, approvals, resume | `electron/workflows.cjs` | 22 workflow unit tests, automation e2e |
| Security: PIN, RBAC, rate limits, allowlists, emergency stop, backups | `electron/security.cjs` | 82-check security smoke, 17 unit tests |
| Notifications, inbox and action routing | main + shell | window/security smokes |

**Exit criteria met:** policy denials are audited; the emergency stop halts tools and workflows; the app leaves no lock or PIN behind in tests.

## Phase 5 — Advanced autonomy, ecosystem and release (done for v1.0.0)

**Goal:** turn the assistant into a bounded autonomous operator and open a plugin ecosystem, then prove it end to end.

| Deliverable | Where | Verification |
| --- | --- | --- |
| Multi-agent collaboration (5 built-ins, up to 5 agents × 3 rounds, synthesizer) | `electron/collab.cjs` | backend smoke (5/5 messages), UI smoke |
| Autonomous jobs with checkpoints, pause/resume, approval per risky step, stop conditions | `electron/advanced.cjs` | 87-check backend smoke, approval-denial UI test |
| Computer vision agent (Windows OCR + multimodal models) | `electron/vision.cjs` | live OCR test on screen/file/camera |
| Context-aware assistance and proactive rules (7 condition types, 4 action types, cooldowns) | `electron/advanced.cjs` | rule tick/cooldown/mutating-block tests |
| Self-evaluation (heuristic + model reviewer, history) | `electron/advanced.cjs` | deterministic-case unit tests, UI 67% run |
| Adaptive model routing from measured outcomes | `model-gateway.cjs`, `advanced.cjs` | route-stats and ranking tests |
| Local-first / hybrid / offline / cloud privacy modes | `advanced.cjs` + gateway filter | mode plan tests, UI mode persistence |
| Multi-device pairing and whitelisted sync | `electron/devices.cjs` | header/no-token refusal, self-pair check/push/pull, integrity tamper test, unknown-mode rejection |
| Personal workflow learning from audit + usage | `advanced.cjs` | mining/approve/dismiss tests |
| Plugin SDK with OS permission sandbox | `electron/plugins.cjs` | sandbox read/write/spawn denial tests |
| Tool marketplace with mandatory sha256 | `electron/plugins.cjs` | wrong-hash rejection, verified install test |
| Recovery manager (runs, workflows, jobs, crashes) | `advanced.cjs` | interrupted-job recovery/discard test |
| Full verification stack | `tests/`, `scripts/` | 137 unit, 90 e2e (source + packaged), 6 visual, 19 bench suites, all smokes |

**Exit criteria met:** every Section 19 capability is reachable from the Advanced page, backed by live IPC, and fails honestly when its dependency is missing. Packaged verification is green on `release/win-unpacked/ORVEX.exe`.

## Phase 6 — Self-improvement and local brain (in progress)

**Goal:** ORVEX records what it does, scores itself, learns from that record, and runs a local model when no provider key is configured.

| Batch | Deliverable | Where | Verification |
| --- | --- | --- | --- |
| 6.1 (done) | Training vault: configurable root, layout marker, hard quota with 20 GB reserve, live disk scan | `electron/training.cjs`, Training → Vault & quota | `smoke:training` 30/30 |
| 6.1 (done) | Episode index in SQLite plus daily JSONL mirror, credential scrubbing, detail/delete/clear | `electron/training.cjs`, `train_episodes` schema | `smoke:training`, 12 unit tests |
| 6.1 (done) | Training page with overview, vault/quota and episode browser | `src/pages/TrainingPage.tsx` | e2e page walk, 95/95 |
| 6.2 (done) | Local Brain runtime manager: llama.cpp discovery, GGUF header reader, SHA-256 cache, VRAM fit estimator, managed server lifecycle, local-first/offline routing, GBNF tool calls | `electron/local-brain.cjs`, Training → Local brain | `smoke:brain` 20/20, 17 unit tests |
| 6.2 (pending) | Bundle an automated llama.cpp runtime download. The manager is real but `llama-server` is not installed on this machine, so the UI reports it as unavailable until the binary is added to the vault `runtime` folder. | `electron/local-brain.cjs` | blocked on the runtime binary |
| 6.3 (done) | Episode recorder wired into agent/orchestrator/workflow/job runs with real usage and cost from the ledger, daily score curve, and eval packs frozen from recorded runs | `electron/training.cjs`, `electron/main.cjs`, `electron/workflows.cjs` | `smoke:training` 30/30, e2e 101/101 |
| 6.4 (done) | Skill compiler, nano scorer with held-out promotion and rollback, Train Kit exporter with notebook and manifest, GGUF import, OpenAI-compatible fine-tune client with key binding | `electron/learner.cjs`, Training → Skills & scorer / Train kit / Fine-tune | `smoke:learner` 62/62, 18 unit tests |
**Design rules:** every promotion is reversible and audited; the recorder writes through the quota gate; secrets never reach episode files; missing runtimes report unavailable instead of fabricating results.

## Phase 7 — Digital workforce (7.1–7.3 done)

**Goal:** long-lived agents that do real work on a schedule, remember their own shifts, stay inside a budget, and leave a report a human can read.

| Batch | Deliverable | Where | Verification |
| --- | --- | --- | --- |
| 7.1 (done) | Persistent agents: role, mission, cloud/local model assignment, five-field cron schedule, budget with automatic pause, memory notes, shift history | `electron/workforce.cjs`, `wf_agents` / `wf_shifts` / `wf_inbox` schema | `smoke:workforce` 60/60, 14 unit tests |
| 7.2 (done) | Real shifts: each shift is a normal engine run started through `startEngine`, with approvals still interactive (timeout = denied), usage-linked steps/tokens/cost and memory written from the actual outcome | `electron/main.cjs` (`runWorkforceShift`, `onFinish`), `electron/workforce.cjs` | workforce smoke + e2e 110/110 |
| 7.3 (done) | Deliverable inbox, read/clear, desktop notification, manual "run due shifts", Workforce page and sidebar entry | `src/pages/WorkforcePage.tsx`, `src/workforce.css`, `src/data/nav.ts` | e2e page walk + workforce IPC checks |

**Design rules:** an agent never stores an API key — main resolves the vault key at run time from the endpoint binding; a shift that cannot reach a model fails honestly instead of inventing output; the scheduler starts at most one shift at a time because the engine itself is single-flight; reaching the budget pauses the agent rather than overspending silently.

## Phase 8 — Ecosystem (8.1–8.2 done)

**Goal:** let the tool reach outside itself and reuse what it learns — real APIs through connectors, and a skill library a human and the agent can both edit.

| Batch | Deliverable | Where | Verification |
| --- | --- | --- | --- |
| 8.1 (done) | OpenAPI 3 / Swagger 2 connectors: import from URL or paste, local `$ref` resolution, server variables and relative servers, operation preview, run any operation, auth none/bearer/header/query bound to the vault (`connector:<id>:secret`), path values encoded and held to the declared origin, network-policy check, 4 MB response cap, non-GET calls require approval | `electron/connectors.cjs`, Integrations → API connectors, `connector_list` / `connector_call` tools | `smoke:connectors` 31/31, 14 unit tests, e2e source 114/114 |
| 8.2 (done) | Manual skills v1: create/update ordered steps that call real registry tools, enable/disable, version bump on edit, export a single bundle or a full pack, import bundle/pack as suggested, skill CRUD tools guarded by approval because they change future agent prompts | `electron/learner.cjs` (`saveSkill` / `exportSkill` / `exportSkills` / `importSkill`, skill tools), Training → Skills & scorer → Skill studio | `smoke:learner` 62/62 |

**Already present before this phase:** plugin manifests and sandboxed runs (`electron/plugins.cjs`), the MCP client and the ORVEX MCP server (`electron/mcp.cjs`, `electron/mcp-server.cjs`). Phase 8 adds the connector layer and human-editable skills on top of them.

**Design rules:** a connector stores its secret in the vault, never in `connectors.json`; a call with no saved secret fails with a clear message instead of sending an unauthenticated request; a malformed or non-OpenAPI spec is refused with the reason; importing skills never silently activates them.

## Phase 9 — Hands: human-like computer control (9.1–9.4 done)

**Goal:** operate the real Windows desktop toward a stated goal — open apps, find labels on screen and click them — under a hard step budget, approval and a stop control.

| Batch | Deliverable | Where | Verification |
| --- | --- | --- | --- |
| 9.1 (done) | App discovery from the Start menu (5-minute cache, name/appId, ambiguity listed), launch by appId through `shell:AppsFolder` or by path; screen grounding that tries the foreground UIA tree first and falls back to Windows OCR over a fresh screenshot; click by UIA invoke or by real SendInput coordinates | `electron/desktop.cjs` (`app_list`, `app_launch`, `screen_find`, `screen_click_text`), Control PC → Hands & apps | 11 unit tests, `smoke:hands` |
| 9.2 (done) | Bounded vision-action loop: screenshot → one JSON action from a vision model → validate/clamp → execute → settle; 12-step cap, strict action set, two consecutive failures abort, user stop and emergency stop honoured, single-flight IPC | `electron/hands.cjs`, `hands_run` tool, `orvex:hands:run/stop/event` | 19 unit tests, `smoke:hands` 17/17 |
| 9.3 (done) | Hands UI: goal and step budget, live step log, Find & click over UIA/OCR matches, installed-app search and launch from Control PC | `src/pages/ControlPcPage.tsx`, `src/control.css` | e2e page walk |
| 9.4 (done) | Tests and bridge surface | `tests/unit/hands.test.mjs`, `tests/unit/desktop-match.test.mjs`, `scripts/smoke-hands.cjs` | e2e source 116/116, bridge exposes 36 modules |

**Design rules:** the model never executes raw text — only parsed actions from a fixed set with clamped values; `app_launch` and `hands_run` ask for approval by default; every step is emitted to the UI; no vision model means an explicit error, never a fake click. **Honest limits:** the loop needs a configured multimodal provider (none is bundled); UIA grounding depends on the target app exposing accessibility names; OCR uses the installed Windows language packs; app launching is Windows-only.

## Phase 10 — Maker Suite (10.1–10.4 done)

**Goal:** turn a request into real project files — a website, landing page, design kit, CLI or React app — then preview, edit, run and export them without leaving ORVEX.

| Batch | Deliverable | Where | Verification |
| --- | --- | --- | --- |
| 10.1 (done) | Six working templates (website, landing, design kit, Node CLI, Python CLI, React + Vite), deterministic HSL palette and SVG logo, project registry with atomic writes, file-tree limits (120 projects, 400 files, 1–2 MB edits), write/read tools, zip export, 20-second CLI runner | `electron/maker.cjs` | 19 unit tests, `smoke:maker` 13/13 |
| 10.2 (done) | Tools (`maker_*`), approval for run/delete, IPC, preload bridge and typed surface; previews stop on quit | `electron/tools.cjs`, `electron/main.cjs`, `electron/preload.cjs`, `src/types/desktop.d.ts` | tsc, e2e bridge check |
| 10.3 (done) | Maker page and sidebar entry: template gallery/create form, project list, palette swatches, live preview iframe, file list and text editor with unsaved-change guard, run output, export/open/reveal/delete | `src/pages/MakerPage.tsx`, `src/pages/maker.css`, `src/data/nav.ts` | e2e page walk, Vite build |
| 10.4 (done) | Live preview server and tests: 127.0.0.1 random port, GET/HEAD only, traversal guard, no-store, React serves only a real `dist/`, CLI execution for Node/Python | `electron/maker.cjs` (`serveStatic`, `preview`, `run`) | unit + smoke above, e2e source 116/116 |

**Design rules:** every generated file is ordinary source the user can keep; generated copy is HTML-escaped; names and paths are slugged and confined to the project folder; a React preview refuses until `dist/index.html` exists; running or deleting generated code asks for approval. **Honest limits:** Maker does not run `npm install` or `npm run build` for React projects, only opens the folder; the editor handles text files up to 2 MB and does not edit binaries; CLI execution is limited to the Node and Python templates with a 20-second timeout.

## Phase 11 — Advisor and operations (11.1–11.4 done)

**Goal:** turn the tool's own state into a ranked, actionable plan — what failed, what is near a limit, what needs review — plus daily/monthly spend limits, backup status and an honest update check.

| Batch | Deliverable | Where | Verification |
| --- | --- | --- | --- |
| 11.1 (done) | Signal collector over real modules and the database: today's runs/failures/running, usage-ledger spend, model chain, workforce inbox, 24 h crashes, backups, training quota/disk/episodes, local-brain runtime, learner skills/kits, advanced suggestions and interrupted jobs, cached update result. Severity scoring (`critical 100`, `high 70`, `medium 45`, `low 20`, count boost ≤20), stable rank order, dismissals with a 1–720 h TTL stored in settings | `electron/advisor.cjs` | 13 unit tests, `smoke:advisor` 25/25 |
| 11.2 (done) | Budget state (daily + monthly, 0 disables), brief, dismiss/restore, update feed and read-only agent tools (`advisor_brief`, `advisor_suggestions`); IPC, preload bridge and typed surface; budget handlers now delegate to the Advisor module | `electron/main.cjs`, `electron/preload.cjs`, `electron/tools.cjs`, `src/types/desktop.d.ts` | tsc, e2e bridge check (`budget` exposes daily and monthly) |
| 11.3 (done) | Advisor page: headline and six stat tiles, budget bars and editor, ranked suggestions with severity/rank/dismiss/action, restore-dismissed, backup card, update feed form and cached result; sidebar entry and deep links (`onNavigate(page, tab)`) | `src/pages/AdvisorPage.tsx`, `src/pages/advisor.css`, `src/data/nav.ts`, `src/App.tsx` | e2e page walk, source + packaged visual |
| 11.4 (done) | Unit, smoke, e2e and visual coverage: semver/feed parsing, budget math and validation, every suggestion rule, dismissal expiry and ranking, collection against a real temp database, tool registration and read-only enforcement | `tests/unit/advisor.test.mjs`, `scripts/smoke-advisor.cjs`, `tests/e2e/app.e2e.mjs` | `npm test` 294/294, e2e 120/120 source and packaged, `smoke:advisor` 25/25 |

**Design rules:** every suggestion comes from a real module status call or database row; a provider that throws makes its signal unavailable instead of inventing one; dismissals expire and are stored in settings, not hidden in the renderer; the update feed is https-only, public-host-only, 10 s timeout, 512 KB cap, cached, and only suggests — it never downloads or installs. **Honest limits:** budgets are advisory (they raise a suggestion and show usage, but do not hard-stop paid runs; workforce agents keep their own budget pause); an update check requires a user-supplied JSON feed (GitHub release or `{version,url,notes}`) and stays `configured: false` until one is set; no background daily-brief notification is scheduled — the brief is computed on demand.

## Phase 12 — Agent guards and skill efficiency (12.1–12.4 done)

**Goal:** close the gaps found while reviewing five working-agent codebases: a deny rule that full-auto cannot skip, skill details loaded on demand instead of pasted into every prompt, and a final-answer check for leaked secrets.

| Batch | Deliverable | Where | Verification |
| --- | --- | --- | --- |
| 12.1 (done) | Approval floors: persisted `{tool, pattern, note}` rules, case-insensitive regex over `<tool> <json args>`, validated and capped at 100, checked in `runTool` and in the agent loop before the approval gate so auto-approve/full-auto can never skip them; owner-only IPC, preload bridge, typed surface and a Security → Permissions editor | `electron/permissions.cjs`, `electron/tools.cjs`, `electron/agent.cjs`, `electron/main.cjs`, `electron/preload.cjs`, `src/types/desktop.d.ts`, `src/pages/SecurityPage.tsx` | 9 unit tests, `smoke:agent-guard` floor checks, e2e bridge check |
| 12.2 (done) | Progressive skill disclosure: the prompt lists enabled skills as one line (`[id] name version — when (N steps)`) and a read-only `skill_load` tool expands the full steps on demand; disabled/unknown ids are refused; the old always-on full-prompt injection is removed | `electron/learner.cjs`, `electron/main.cjs` | 2 unit tests, `smoke:agent-guard` catalog checks, `smoke:learner` 62/62 |
| 12.3 (done) | Final-answer tripwire: detects private keys, API/GitHub/AWS/Slack tokens, bearer tokens, credential assignments and registered vault values; redacts them from assistant text and run summaries and emits a `guard` event | `electron/security.cjs`, `electron/agent.cjs` | 4 unit tests, `smoke:agent-guard` tripwire checks |
| 12.4 (done) | Tests, smoke, e2e and docs: floor persistence/damage recovery, catalog/load behavior, tripwire coverage, bridge surface, source e2e | `tests/unit/permissions.test.mjs`, `tests/unit/security.test.mjs`, `tests/unit/learner.test.mjs`, `scripts/smoke-agent-guard.cjs`, `tests/e2e/app.e2e.mjs` | `npm test` 309/309, e2e 121/121 source, `smoke:agent-guard` 25/25 |

**Design rules:** a floor is checked before approval, so it is stricter than `ask`, not another approval hint; floors are user-defined (nothing silently protects itself), validated on write, and a damaged entry is skipped instead of blocking startup; the skill catalog carries ids, not steps, and the full prompt is only fetched for an enabled skill; the tripwire redacts visible text only — the agent's internal transcript keeps the original so a task can still use a value it legitimately read. **Honest limits:** floors match the tool name plus serialized arguments, so a differently-shaped argument object can avoid a pattern; floors are not a sandbox and do not replace the path/command guardrails; the tripwire is pattern-based and cannot catch a secret in an unknown format; skill references are local ids, not `@org/name@version` registry coordinates.

### What the repo review changed

| Repo (MIT) | Idea studied | Decision |
| --- | --- | --- |
| Hermes | `approval_floors.py` — deny rules that bypass yolo/auto-approve | Ported as approval floors (12.1) |
| Hermes | Durable async delegation with a completion queue | Not ported: ORVEX already has persisted runs, the orchestrator and scheduled workforce shifts; a queue that delivers a finished sub-task as a new chat turn remains future work |
| Hermes / ECC | Context compression, verification loop | Already present: `compactHistory`, eval packs, smokes |
| ECC | Unified memory scopes (project/team/user) and agent sort | Partial fit: ORVEX memory is profile + project scoped; team scope has no meaning in a single-user desktop install |
| OpenAI Agents SDK | Input/output guardrails with a tripwire | Output side ported (12.3); untrusted tool-output wrapping already existed |
| CrewAI | Progressive skill disclosure and a `load_skill` tool | Ported as the skill catalog + `skill_load` (12.2); registry refs are not applicable to a local single-instance app, while cross-machine messaging now exists as A2A (23.1) |
| ruflo | Swarm consensus, claims/work stealing | Not applicable: single-window, single-flight engine; guard concepts already covered by gateways and permissions |

## Phase 13 — Planning and background agents (13.1–13.7 done)

**Goal:** close the gaps found while reviewing six more working-agent codebases — a per-run plan the model has to keep honest, background sub-agents that work in parallel without asking the user anything, and large tool output preserved on disk instead of silently cut at 6 000 characters — then a third review of Hermes and vercel-labs/agent-desktop added argument repair, a stalled-stream watchdog and post-action verification for computer use.

| Batch | Deliverable | Where | Verification |
| --- | --- | --- | --- |
| 13.1 (done) | Per-run todo plan: `todo_add`, `todo_complete`, `todo_remove`, `todo_list`; deduplicated open titles, 40-item cap, 200-char titles, run-scoped so two runs never share a list; the list plus its instructions are appended to the system prompt on every step; a `todos` event updates the status line; cleared when the run finishes | `electron/plan-todos.cjs`, `electron/tools.cjs`, `electron/agent.cjs`, `electron/main.cjs` | 6 unit tests, `smoke:planning` checks |
| 13.2 (done) | Background sub-agent delegation: `delegate_start` / `status` / `wait` / `result` / `cancel`, 2 concurrent and 20 total children per parent, per-parent scoping, parent-abort propagation, no nested delegation, children run unattended with every risky tool refused (no approval prompts) and a 20-step limit; child runs have their own id (`<parent>~<id>`) and memory context | `electron/delegates.cjs`, `electron/tools.cjs`, `electron/agent.cjs`, `electron/main.cjs` | 9 unit tests, `smoke:planning` checks |
| 13.3 (done) | Large-output spill: any `runTool` result over 6 000 chars is written to `<userData>/tool-outputs/<run>/<timestamp>-<tool>.txt` (256 KB cap) and replaced with a head plus a pointer; `fs_read`/`shell_exec` now return full text before spilling; retention prunes files older than 7 days or past 500 files; output that matches the credential tripwire is **not** written to disk | `electron/tools.cjs` | 4 unit tests, `smoke:planning` checks |
| 13.4 (done) | Tests, smoke, e2e and docs: plan add/dedupe/complete/missing ids/cap, delegation success/failure/concurrency/timeout/cancel/parent-abort/scoping, unattended refusal, spill/credential block/pruning; e2e asserts every new tool is registered | `tests/unit/plan-todos.test.mjs`, `tests/unit/delegates.test.mjs`, `tests/unit/tool-spill.test.mjs`, `scripts/smoke-planning.cjs`, `tests/e2e/app.e2e.mjs` | `npm test` 333/333 (26 files), e2e 122/122 source, `smoke:planning` 22/22 |
| 13.5 (done) | Fast web path: `browser_task` (`open` / `search` / `play_first`) resolves site + query to a search URL, clicks the first YouTube result and starts playback in one tool call; Chrome launches with `--autoplay-policy=no-user-gesture-required`; the system prompt now forbids `app_launch`, `app_list` and `window_list` for website goals so a simple "open YouTube and play X" finishes in ~2 model steps | `electron/browser.cjs`, `electron/agent.cjs` | 5 unit tests, real Chrome search + playback verified |
| 13.6 (done) | Spoken text cleanup: `forSpeech` (moved to `src/data/speech-text.ts`) strips emoji, joined family flags, keycaps, skin tones and variation selectors before any TTS engine speaks, so chat replies read aloud no longer say "smiling face" | `src/data/speech-text.ts`, `src/data/voice.tsx` | 5 unit tests, `npm test` 338/338 (27 files) |
| 13.7a (done) | Schema-guided argument repair: before any gate sees a tool call, scalars are coerced to the tool's declared types — `"true"`→`true`, `"7"`→`7` for integer/number, a JSON-string or bare value in an array slot becomes an array, a JSON-string in an object slot is parsed, `"null"`→`null` only where the schema allows null; every repair is audited as `tool-args-coerced`, and ambiguous values (`42` for a string, `"12 px"` for a number, `"7.5"` for an integer) are left untouched so the tool still refuses them | `electron/tool-args.cjs`, `electron/tools.cjs`, `electron/agent.cjs` | 5 unit tests |
| 13.7b (done) | Stalled-stream watchdog: a stream that stops producing chunks after it started answering is aborted as a retryable `ModelError` (75 s hosted, 150 s local) so the candidate fallback chain moves on instead of waiting for the whole-request timeout; distinct from that timeout because it only arms once output has begun and re-arms on every chunk | `electron/stream-watchdog.cjs`, `electron/model-gateway.cjs` | 4 unit tests (`vi.useFakeTimers`), `smoke:gateway` |
| 13.7c (done) | Computer-use post-action verification: `ui_action` captures the element state before the action, polls it four times over 800 ms, and reports `verified` (the element now reports the new value/toggle/expand state), `changed` (the element vanished or its state moved) or neither — the model is told that NOT confirmed means re-check the screen instead of assuming success; password fields never report a value | `electron/desktop.cjs`, `electron/agent.cjs` | `smoke:desktop` focus + set_value verification checks |
| 13.7d (done) | Tests, smoke and docs for the third review; desktop smoke harness now opens Notepad through `app_open` and spawns `ping` directly, so neither step can hold the shell pipe | `tests/unit/tool-args.test.mjs`, `tests/unit/stream-watchdog.test.mjs`, `scripts/smoke-desktop.cjs` | `npm test` 347/347 (29 files), e2e 122/122 source, `smoke:desktop` 31/31 |
| 13.7e (done) | Instrumentation: a `model_stall` event is emitted with provider, model and window when the watchdog fires, so the UI/status line can show which provider stalled | `electron/model-gateway.cjs` | gateway smoke |

**Design rules:** the plan belongs to one run and is cleared with it, so nothing stale leaks into the next goal; a child run can only touch its own parent's tasks and is cancelled with the parent; an unattended child never waits on a prompt — a risky tool is refused with an explicit reason instead of auto-approved; spill files live under the app's own data folder, are bounded, are pruned by age and count, and refuse to persist anything the credential tripwire flags; argument repair happens before the permission floor and the approval gate, and only ever narrows a value to the tool's own declared schema — it never retypes a value the schema does not distinguish; the stall watchdog only fires after output began, so a slow first token is still governed by the ordinary request timeout; a UI action reports what it actually observed, and an unobservable state is reported as unknown rather than success. **Honest limits:** the todo list is in-memory for the run (it is not a durable task board — `task_add` and the orchestrator own persistence); delegation started foreground-free and became durable in 15.1 — the parent still cancels a child that is running when the parent ends, and resuming is an explicit `delegate_resume`; children cannot ask for approval, so they cannot perform risky actions at all; spill covers tool output only, not model streaming or chat text; the watchdog covers streaming calls only — a non-stream request has no inter-chunk progress to measure; post-action verification shipped for single and batched actions (14.1–14.4) but a custom-drawn control can still change without a readable state.

### What the second review changed

| Repo (license) | Idea studied | Decision |
| --- | --- | --- |
| microsoft/agent-framework (MIT) | `_todo.py` plan state, `_background_agents.py`, judge loop, tool approval, checkpointing | Todo state ported (13.1); background agents ported with stricter unattended rules (13.2); judge loop already covered by the orchestrator's `validate`; checkpoints already in advanced jobs |
| voltagent (MIT) | `write_todos` plan tool, `subagent`, `createToolResultEvictor` | Plan tool and sub-agent patterns studied; evicting tool results replaced by spill-to-disk (13.3) because ORVEX wants the full text recoverable for the rest of the run |
| simular-ai/agent-s (Apache-2.0) | `agent_s4` island/variant evolution | Not ported for v1: ORVEX learning is skill/nano-trainer based; population search would need a scoring harness it does not have yet |
| getzep/graphiti (Apache-2.0) | Bi-temporal edges, MMR + cross-encoder search | Not ported now: ORVEX memory already has graph edges and conflict detection; bi-temporal validity and MMR reranking are future memory work |
| vercel-labs/agent-desktop (Apache-2.0) | Accessibility-tree grounding | Already present as `ui_tree` in Hands |
| dbos-inc/durable-swarm (MIT) | Durable workflow wrapper over agents | Not ported: would require the DBOS runtime; ORVEX keeps its own persisted runs and jobs |

### What the third review changed (NousResearch/hermes-agent, vercel-labs/agent-desktop)

| Repo (license) | Idea studied | Decision |
| --- | --- | --- |
| NousResearch/hermes-agent (MIT) | `tools/arg_coercion.py` — repair model-typed arguments against the tool schema | Ported (13.7a); ORVEX had none, so a model sending `"true"` for a boolean or a bare string for an array failed a call it meant to make |
| NousResearch/hermes-agent (MIT) | `agent/auxiliary_stream_watchdog.py` — abort a stream that goes silent mid-answer | Ported (13.7b) as a retryable stall error so the provider chain fails over; local endpoints get a wider window because a local model can pause while loading |
| NousResearch/hermes-agent (MIT) | `approval_floors.py` | Already ported in 12.1 |
| NousResearch/hermes-agent (MIT) | Durable async delegation with a completion queue | Ported (15.1): tasks persist in SQLite, interrupted runs are marked on restart, and `delegate_resume` re-runs a failed/interrupted/cancelled task with a link that prevents double resume |
| NousResearch/hermes-agent (MIT) | "Smart" LLM approval guardian | Not ported as an LLM judge. The deterministic version shipped (16.1): rules learned from declined approvals and floor hits can only *add* a prompt or denial, never approve |
| NousResearch/hermes-agent (MIT) | Recovery hints for abandoned delegations | Partly: `delegate_queue` lists the last tasks with status, error and resume link, which is the recovery path for an abandoned child |
| vercel-labs/agent-desktop (Apache-2.0) | Accessibility-tree grounding | Already present as `ui_tree` |
| vercel-labs/agent-desktop (Apache-2.0) | `crates/core/src/actions/post_action.rs` + `actionability/*` — verify the action actually changed the UI | Fully ported (13.7c → 14.1–14.5): element-state verification, visible/enabled pre-flight, batched `ui_sequence`, `ui_wait`, pixel-diff proof and a click-through highlight overlay |

## Phase 14 — Humanoid-grade computer control (14.1–14.5 done)

| Step | What it does | Where | Proof |
| --- | --- | --- | --- |
| 14.1 (done) | Actionability pre-flight: before clicking or typing, the target must exist, be on-screen, enabled and visible; otherwise the call is refused with the exact failing condition instead of clicking blind | `electron/desktop.cjs`, `electron/tools.cjs` | `tests/unit/ui-control.test.mjs`, `smoke:desktop` |
| 14.2 (done) | Batched `ui_sequence`: several actions run in order with per-step verification, and a failed step stops the batch and reports which step failed | `electron/tools.cjs`, `electron/agent.cjs` | desktop smoke batch checks |
| 14.3 (done) | `ui_wait`: wait for an element or a state (appears, vanishes, enabled, focused) with a timeout instead of sleeping | `electron/desktop.cjs` | desktop smoke wait checks |
| 14.4 (done) | Pixel-change verification: a screenshot region is compared before/after an action so a no-op click is reported as unverified | `electron/desktop.cjs` | desktop smoke pixel checks |
| 14.5 (done) | Click-through highlight overlay: a short-lived topmost cursor/highlight marks where the agent acted, so a human can see the automation | `electron/desktop.cjs` | desktop smoke overlay checks |

## Phase 15 — Durable delegation (15.1 done)

| Step | What it does | Where | Proof |
| --- | --- | --- | --- |
| 15.1 (done) | Every sub-agent task is stored in SQLite (`delegations`), open tasks are marked `interrupted` at startup, `delegate_queue` lists them, and `delegate_resume` re-runs one — refusing a task that was already resumed so a restart cannot double-run work | `electron/db.cjs`, `electron/delegates.cjs`, `electron/tools.cjs` | `tests/unit/delegates.test.mjs`, `smoke:planning` |

## Phase 16 — Escalation-only approval advisor (16.1 done)

| Step | What it does | Where | Proof |
| --- | --- | --- | --- |
| 16.1 (done) | Rules are matched against tool + arguments; a match forces an explicit yes even in auto-approve and is denied outright in unattended sub-agents. The API has no "allow" path, learned rules start as `suggested` and stay inactive until accepted, and all mutations are owner-gated and audited | `electron/approval-advisor.cjs`, `electron/agent.cjs`, `electron/main.cjs`, `src/pages/SecurityPage.tsx` | `tests/unit/approval-advisor.test.mjs`, `smoke:agent-guard`, `smoke:security-ui` |

## Phase 17 — UI dead weight (17.1 done)

| Step | What it does | Where |
| --- | --- | --- |
| 17.1 (done) | Removed UI that duplicated another surface or claimed state it did not have: floating Activity Console (duplicated the live Activity panel and could only show one seeded row), unused SettingsDrawer, duplicate Quick Actions grid, marketing quote rail, pulsing "live" badge at zero calls, no-op `compact` prop, decorative room art, agent "Ready" chip renamed to "Idle", dead goal chevron, and a silent Lock button now reports when the desktop bridge is absent. Also fixed a real lockout: with a PIN set, demoting to Viewer made Owner unreachable because promotion demanded a PIN the UI never sent — the page now asks for it, and PIN-less profiles can promote normally | `src/App.tsx`, `src/components/*`, `src/pages/SecurityPage.tsx`, `electron/main.cjs`, `electron/preload.cjs` |

## Phase 18 — Cloud voice and live model lists (18.1 done)

| Step | What it does | Where |
| --- | --- | --- |
| 18.1 (done) | HeyGen Voice Turbo joins the voice engines. The key is saved write-only in the OS vault bound to `api.heygen.com` and attached in the main process. Settings → Voice offers the three HeyGen models (`heygen-voice-1`, `-turbo`, `-turbo-free`), a live public-voice fetch, language and voice id; `speak()` renders the reply through the main process, saves the clip to the Media library and plays it. The Engine model chip gained a fetch button that imports the provider's live `/models` list, which also feeds the Workforce agent model picker | `electron/creative.cjs`, `electron/main.cjs`, `electron/preload.cjs`, `src/data/heygen.ts`, `src/data/voice.tsx`, `src/pages/SettingsPage.tsx`, `src/pages/EnginePage.tsx` |

## Phase 19 — GitHub updater and SKILL.md import (19.1–19.2 done)

| Step | What it does | Where | Proof |
| --- | --- | --- | --- |
| 19.1 (done) | GitHub release updater: a configurable public `owner/name` (default `akhaliq94/orvex-releases`) is read through the releases API; the setup build is chosen for installed copies and the portable exe for portable copies; the asset is streamed with progress, hashed, and refused unless the published SHA-256 (asset digest or `SHA256SUMS.txt`) matches; install is NSIS `/S` only after an explicit confirmation, while a portable copy is revealed for a manual swap. Auto-check is a setting and never installs on its own. `npm run dist` writes `release/SHA256SUMS.txt` | `electron/update-core.cjs`, `electron/updater.cjs`, `electron/main.cjs`, `scripts/checksums.mjs`, `src/pages/AdvisorPage.tsx` | `tests/unit/updater.test.mjs`, `smoke:advanced`, e2e updater state |
| 19.2 (done) | Claude-style `SKILL.md` import: YAML frontmatter supplies name, trigger (`description`) and `allowed-tools`; explicit `tool:` lines or an ```orvex-steps JSON block become executable steps; the remaining markdown is stored as instructions that `skillPrompt` gives the agent. Pasted text or a picked `.md` file both work, and skills stay suggested until enabled | `electron/learner.cjs`, `src/pages/SkillsPanel.tsx`, `src/types/desktop.d.ts` | `tests/unit/skill-markdown.test.mjs`, `smoke:advanced` |

## Phase 20 — Game Pilot (20.1 done)

| Step | What it does | Where | Proof |
| --- | --- | --- | --- |
| 20.1 (done) | A named game window can be played with keyboard input under a bounded contract: input is sent only while the configured window is the foreground window (with an optional focus step), only keys listed in the profile are ever pressed, every tick is paced by the profile interval (0.5–15 s in 20.1; 24.1 lowers the floor to 250 ms for vision and 100 ms for macro), and a run stops on a hard minute limit, a target score, a global `Ctrl+Alt+Shift+G` shortcut, the emergency stop, ten lost-window checks or three capture/keyboard failures. Vision profiles ask a multimodal model for one JSON action per screenshot (24.1 batches up to six) and reject anything outside the key allow-list; macro profiles replay a fixed `KEY@waitMs` sequence without a model. The score is read from a cropped score region through Windows OCR, never invented. Each finished run is stored as a training episode with its stop reason, best score and action log | `electron/game-core.cjs`, `electron/game-pilot.cjs`, `electron/main.cjs`, `electron/preload.cjs`, `src/pages/GamePilotPage.tsx`, `src/data/nav.ts` | `tests/unit/game-pilot.test.mjs`, `smoke:advanced` (real loop with fake desktop + recorded episode), e2e bridge check |

## Phase 21 — macOS and Linux adapters (21.1 done)

| Step | What it does | Where | Proof |
| --- | --- | --- | --- |
| 21.1 (done) | Input, windows, OCR, volume, brightness, apps and processes route through a platform module instead of failing outside Windows. macOS uses System Events/JXA for key, text and window control, plus `cliclick` for mouse and `tesseract` for OCR (explicit install hints when missing); Linux uses `xdotool`, `wmctrl`, `tesseract`, `pactl`/`amixer` and `brightnessctl`. Every external command is spawned with an argument array, never a shell string, so typed text cannot become a command. Unsupported operations report exactly which tool or capability is missing | `electron/platform.cjs`, `electron/desktop.cjs` | `tests/unit/platform.test.mjs` (21 checks against a fake exec). Live macOS/Linux runs are not claimed — only the adapter logic is tested here |

## Phase 22 — Signed marketplace catalog (22.1 done)

| Step | What it does | Where | Proof |
| --- | --- | --- | --- |
| 22.1 (done) | A catalog can be signed as an Ed25519 envelope (`{schema, payload, keyId, signature}`) over the exact payload string, so key order never changes the hash. The client verifies the signature against trusted public keys the user pasted, reports the signing key id and a 16-hex fingerprint, and can refuse unsigned catalogs entirely. Trusted keys are stored without their PEM in the UI bridge, a tampered payload or unknown key is rejected before any plugin URL is offered, and the existing per-archive sha256 check still runs after the signature passes. `catalog:keygen` writes a 0600 private key plus the trusted-key JSON; `catalog:build` reads plugin zips, hashes them and emits a signed catalog for a GitHub Release | `electron/catalog.cjs`, `electron/plugins.cjs`, `electron/main.cjs`, `electron/preload.cjs`, `src/pages/AdvancedPage.tsx`, `scripts/catalog-keygen.mjs`, `scripts/build-catalog.mjs` | `tests/unit/catalog.test.mjs` (11 checks), `smoke:advanced` (sign/accept, tamper reject, unsigned reject, unknown key, token error paths), `smoke:advanced-ui` (key field, enforcement toggle) |

## Phase 23 — Agent-to-agent messaging (23.1 done)

| Step | What it does | Where | Proof |
| --- | --- | --- | --- |
| 23.1 (done) | An A2A 0.3 JSON-RPC endpoint serves `message/send`, `tasks/get` and `tasks/cancel` with a public agent card, bearer authentication, a forced ORVEX header (so a web page cannot post to it), private-LAN-only answers, loopback or LAN binding and a 2-minute default timeout. Every task is stored in SQLite with direction and peer; a task interrupted by a restart is marked failed instead of looking alive. Saved peers keep a masked token view, can be probed for their card, and outbound tasks round-trip through the same JSON-RPC. Inbound text is answered by the configured chat model with a dedicated system prompt — peers cannot reach tools, files, desktop input, plugins or approvals. The agent also gets `a2a_send`, `a2a_tasks` and `a2a_peers` tools | `electron/a2a.cjs`, `electron/db.cjs`, `electron/main.cjs`, `electron/preload.cjs`, `electron/tools.cjs`, `src/pages/AdvancedPage.tsx` | `tests/unit/a2a.test.mjs` (9 checks), `smoke:advanced` (auth, card, text task, failure, cancel, peer round-trip, token rotation, restart normalization), e2e bridge check |

## Phase 24 — Game Pilot fast mode (24.1 done)

| Step | What it does | Where | Proof |
| --- | --- | --- | --- |
| 24.1 (done) | The per-tick model call, not the screenshot, was the bottleneck. A vision reply is now an ordered batch of 1–6 allowed keys (`{"actions":[...]}`) with a 40–2000 ms inter-key gap, so one model call drives several inputs; the vision interval floor drops to 250 ms (macro 100 ms). A camera frame is hashed (SHA-1) per tick and, while the screen is pixel-identical, the last batch is replayed without any model call — bounded to 1,200 idle repeats and still subject to the window, stop-key, security, capture, target and minute limits. Old single-action replies still parse, and every key is still checked against the allow-list before it is pressed | `electron/game-core.cjs`, `electron/game-pilot.cjs`, `electron/main.cjs`, `src/pages/GamePilotPage.tsx`, `src/types/desktop.d.ts` | `tests/unit/game-pilot.test.mjs` (23 checks), `smoke:advanced` (vision batch run with fake desktop), e2e bridge check |

## Forward-looking work (beyond v1.0.0)

These are deliberately not claimed as shipped:

1. **Code signing.** The installer is unsigned; add an EV certificate before public distribution. The GitHub updater (19.1) verifies SHA-256 but cannot make Windows SmartScreen trust an unsigned exe.
2. **Hosted marketplace.** The client verifies a catalog you publish and point it at; ORVEX hosts nothing itself. Signing (22.1) and `catalog:build` make a self-hosted GitHub Release catalog trustworthy once its public key is trusted, but there is still no first-party store, review process or automatic updates from it.
3. **Background multi-device sync.** Pairing and manual check/push/pull work; scheduled background sync is not implemented.
4. **Plugin network policy.** The Node permission model does not restrict network; a per-plugin network allowlist would require an additional sandbox layer.
5. **A2A scope and exposure.** Messaging (23.1) is text-in/text-out by design: peers cannot run tools or touch this machine. There is no streaming, push notification, file part or multi-turn context memory across separate A2A tasks, and the token is the only gate when the LAN option is enabled — anyone who obtains it can spend your configured model quota.
6. **YAML OpenAPI specs.** Connectors parse JSON specs only; a YAML spec is refused with an explicit message rather than guessed at.
7. **Platform coverage.** macOS and Linux adapters ship (21.1) but are only unit-tested on this Windows machine; expect to install the CLI tools the adapter names, and verify screen OCR quality on the target distro. Packaging is still Windows-first (NSIS/portable) and OS-level secrets use Electron safeStorage wherever the platform provides a keychain.
8. **Model evaluation at scale.** The eval CLI is honest but skips without credentials; a curated local benchmark pack would make this repeatable offline.
9. **Hands needs a multimodal model.** The control loop is real, but it only runs when a vision-capable provider endpoint is configured; with no model it fails with an explicit message instead of guessing at clicks.
10. **Maker does not orchestrate builds.** Projects are scaffolded, edited, previewed and exported, but `npm install` / `vite build` are not driven by the app; running a tool is limited to the project's Node or Python CLI with a 20 s timeout.
11. **OCR language packs.** Screen text grounding uses the Windows OCR engine, so recognition quality depends on the installed language packs for the target language.
12. **Budgets are advisory.** The Advisor raises a suggestion and shows daily/monthly usage, but paid runs are not hard-stopped by the budget; only workforce agents pause themselves on their own budget.
13. **Auto-update is user-driven.** The updater checks a public GitHub `owner/name`, downloads the matching build and refuses it without a published SHA-256 match (19.1). It never installs silently: the NSIS setup runs only after confirmation and ORVEX closes for it, a portable copy cannot replace itself and is revealed for a manual swap, and a development build refuses to install.
14. **Delegation resume is explicit.** Durable tasks survive a restart (15.1), but a resumed task is started by `delegate_resume` or the user — there is no automatic requeue on launch, and a child still running when its parent finishes is still cancelled rather than continued in the background. Engine plans are separate: a checkpointed plan resumes on launch when Auto-resume is on (Engine page), never repeats a verified step, and an interrupted in-flight step still asks for approval. Runs paused by the user stay paused, and a direct agent run without a plan has no checkpoint to resume.
15. **Skill registry coordinates.** Skills are stored and referenced by local id; importing from an `@org/name@version` registry, remote version resolution and signature checks are not implemented.
16. **Durable todo board.** Per-run todos (13.1) are in-memory; a task list that survives a restart and is shared across runs is still owned by `task_add` and the workforce scheduler, not the chat plan.
17. **Bounded spill retention.** Large tool outputs are kept for 7 days or 500 files (13.3); there is no user-facing setting yet, and the cap applies per data folder rather than per conversation.
18. **Non-UIA controls.** Actionability, batching, waits and pixel-diff verification ship (14.1–14.4), but a custom-drawn control that exposes no UI Automation state can still change without a readable before/after; the pixel check reports "changed" without naming what changed.
19. **Non-streaming requests have no stall watchdog.** The inter-chunk watchdog (13.7b) applies to streaming calls only; a non-stream request is governed solely by the whole-request timeout.
20. **Game Pilot is keyboard-only.** A vision tick is one screenshot plus one model call; fast mode (24.1) batches 1–6 keys per call, allows a 250 ms vision floor (100 ms macro) and replays the last batch without a model call while the frame is pixel-identical, up to 1,200 idle repeats. It still cannot move the mouse, and score reading depends on Windows OCR plus a score region/pattern the user provides. Model latency still caps twitch-game responsiveness — a local vision model is the next real step. Online games may treat automation as cheating; that risk belongs to the user.
21. **Gameplay produces data, not a trained model.** Every pilot run is stored as an episode and can feed the training vault and skill scorer, but real fine-tuning still needs a curated dataset and suitable hardware; the pilot itself does not change the model's weights.

## Verification ledger (2026-11-04, Phase 17 build)

| Suite | Result |
| --- | --- |
| `npm test` (unit + adversarial) | 362/362 (31 files) |
| `npm run test:e2e:source` | 122/122 (27 nav destinations, 37 bridge modules) |
| `npm run test:e2e` (packaged) | 122/122 against `release/win-unpacked/ORVEX.exe` |
| `npm run test:visual` | 6/6 screens, source and packaged |
| `npm run test:bench` | 19 suites measured |
| `npm run test:eval` | SKIP, exit 2 — no eval credentials supplied (by design) |
| `smoke:planning` (backend) | 28/28, including the durable delegation queue and resume guards |
| `smoke:agent-guard` (backend) | 34/34, including the escalation-only advisor |
| `smoke:advisor` (backend) | 25/25 |
| `smoke:advanced` (backend) | 92/92 |
| `smoke:workforce` (backend) | 60/60 |
| `smoke:learner` (backend) | 62/62 |
| `smoke:connectors` (backend) | 31/31 |
| `smoke:training` (backend) | 30/30 |
| `smoke:gateway` (backend) | OK — real provider chain, stall watchdog wired |
| `smoke:desktop` (live CDP window) | 31/31, including `ui_action` focus and set-value verification |
| `smoke:brain` (backend) | 20/20 |
| `smoke:hands` (backend) | 17/17 |
| `smoke:maker` (backend) | 13/13 |
| `smoke:advanced-ui` (source and packaged) | 42/42 each |
| `smoke:security-ui` (live CDP window) | 45/45, including escalation rules and PIN-gated promotion |
| `smoke:dashboard-ui` (live CDP window) | 44/44 |
| `smoke:window-ui` (live CDP window) | 38/38 |
| Regression: `smoke:productivity` / `smoke:monitor` / `smoke:security` | 65/65 · 73/73 backend (CDP half needs a live window) · 54/55 (CDP half needs a live window) |

## Verification ledger (2026-11-05, Phase 24 build)

| Suite | Result |
| --- | --- |
| `npm test` (unit + adversarial) | 477 passed / 2 skipped (40 files), including 23 Game Pilot, 9 A2A text/auth and the cross-platform adapter tests |
| `npm run test:e2e:source` | 127/127 (28 nav destinations, 38 bridge modules, 5 advanced groups) |
| `npm run test:e2e` (packaged) | 127/127 against `release/win-unpacked/ORVEX.exe` |
| `npm run smoke:advanced` (backend) | 141/141, including the signed catalog envelope, the A2A server, and a vision batch run that presses every key from one model reply |
| `npm run dist:dir` | packaged cleanly (unsigned, no code-signing certificate) |

Platform adapters (21.1) are unit-tested on Windows only; a live macOS/Linux run is not part of this ledger.

