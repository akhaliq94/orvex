# 24 — Agent guards, progressive skills and the Phase 12–13 repo reviews

Phase 12 adds three behaviours that ORVEX was missing. All three are enforced in the main process and are covered by unit tests, a backend smoke and the source e2e suite.

## 28 Approval floors

An approval floor is a hard deny rule for a tool call. It is deliberately stricter than `ask`:

| Policy | When it is checked | Auto-approve can skip it? |
| --- | --- | --- |
| `ask` | Approval gate | Yes (`autoApprove` / full-auto approves) |
| `deny` | `runTool`, per tool name | No |
| **floor** | Agent loop before the approval gate, then again in `runTool` | **No** |

A floor is `{ id, tool, pattern, note, addedAt }`:

- `tool` is `*` or a tool name.
- `pattern` is a case-insensitive regular expression, 1–300 characters, matched against `<tool> <JSON args>`.
- At most 100 floors; an identical `{tool, pattern}` pair is refused.
- Patterns are validated with `new RegExp` on write. A damaged entry found on disk is skipped at startup instead of preventing the app from loading.
- Floors live beside tool policies in `permissions.json` under `{ policies, floors }`; the old plain-map format is still read.

Enforcement points:

1. `electron/agent.cjs` checks `permissions.floorReason(call.name, call.args)` right after `tool_start`, before any approval prompt. A match writes a `tool-floor` audit row, returns the error to the model and continues the run.
2. `electron/tools.cjs` checks the same function in `runTool` before the permission policy, emergency guard and handler. Direct IPC or tool calls are therefore covered too.

IPC: `orvex:permissions:addFloor`, `orvex:permissions:removeFloor`, owner-only. `orvex:permissions:state` now returns `floors` and `counts.floors`. The editor is Security → Permissions → **Approval floors**; “Reset all” resets tool policies only and leaves floors in place.

Example rules:

| Tool | Pattern | Meaning |
| --- | --- | --- |
| `shell_exec` | `rm\s+-rf` | never run a recursive delete |
| `*` | `\.env\b` | never touch a `.env` path through any tool |
| `fs_write` | `Startup` | never write into a startup folder |

Limits: the match runs on the serialized argument object, so a floor is only as precise as the pattern; it is not a sandbox and does not replace the path, command and network guardrails.

## 29 Progressive skill disclosure

Before Phase 12, up to three full skill bodies were pasted into every agent run. Now the prompt carries a one-line catalog:

```
- [skill_abc123] Read a log tail 1.0.1 — when the user asks what changed in a log file today (2 steps)
```

The read-only `skill_load` tool takes `{ id }` and returns the ordered steps (`1. fs_read …`, failure notes, success check, avoid list). Behaviour:

- Only `active` skills appear in the catalog (limit 12 lines).
- `skill_load` refuses an unknown id (`No skill with id …`) and a disabled id (`… is disabled; only enabled skills can be loaded`).
- Loading is read-only, so it needs no approval; changing the library (`skill_save`, `skill_import`, `skill_set_status`, `skill_delete`) still does.
- The catalog is an optimisation: if the database is not ready it returns `[]` and the run continues.

Limits: references are local ids, not `@org/name@version` registry coordinates; there is no remote resolution or signature check.

## 30 Output tripwire

`security.outputTripwire(text)` runs on every assistant message and on the run summary. It detects:

- private-key PEM blocks
- `sk-…` API keys
- GitHub (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`), AWS (`AKIA…`) and Slack (`xox…`) tokens
- bearer tokens
- `key/token/secret/password/authorization` assignments
- any value registered through `setSecretValues` (the vault keys loaded at boot)

A match redacts the text with the existing rules and emits `{ type: 'guard', stage: 'output', findings: [...] }`; the run summary also carries `guard`. The internal transcript keeps the original, so an agent that legitimately reads a value can still use it in a later tool call.

Limits: this is pattern-based. A secret in an unrecognised format will not be caught; the rule is still “do not read credential files”, and the guardrails block the known credential locations.

## 31 What the five-repo review changed

Method: five combined-keyword web and GitHub searches, top repositories inspected, five codebases downloaded with blobless sparse clones and their agent runtimes read.

| Repo (MIT) | Studied | Result |
| --- | --- | --- |
| [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) | `approval_floors.py`, async delegation, context compressors, SOUL.md, evals | Floors ported (12.1). Delegation queue not ported: ORVEX already has persisted runs, the orchestrator and workforce shifts; a “finished sub-task arrives as a new chat turn” queue stays future work. |
| [affaan-m/ECC](https://github.com/affaan-m/ECC) | Unified memory scopes, verification loop, strategic compaction, eval harness | Compaction and verification already exist. Project/team/user scopes do not map onto a single-user desktop profile, so memory stays profile + project scoped. |
| [openai/openai-agents-python](https://github.com/openai/openai-agents-python) | Handoffs, input/output guardrails with tripwire, SQLite sessions | Output tripwire ported (12.3). Handoffs map to the existing orchestrator/collab roles; sessions map to the SQLite conversation tables. Untrusted tool-output wrapping already existed. |
| [crewAIInc/crewAI](https://github.com/crewAIInc/crewAI) | Progressive skill disclosure, `load_skill`, planning config, A2A | Catalog + `skill_load` ported (12.2). A2A and registry refs are not applicable to a local single-instance app; replanning already exists in the orchestrator. |
| [ruvnet/ruflo](https://github.com/ruvnet/ruflo) | Swarm topologies, claims/work stealing, neural routing, aidefence | Studied only. The engine is single-flight in one window, so swarm claims/consensus add complexity without a use case; injection scanning and guardrails already cover the aidefence role. |

## 32 Verification (Phase 12)

| Suite | Result |
| --- | --- |
| `npm test` | 309/309 (23 files, +15) |
| `npm run test:e2e:source` | 121/121 |
| `npm run test:e2e` (packaged) | 121/121 |
| `smoke:agent-guard` | 25/25 |
| `smoke:learner` | 62/62 |
| `npm run build` | tsc + Vite green |

## 33 Per-run plan state

`electron/plan-todos.cjs` keeps a list per `runId`: `add` deduplicates open titles and caps at 40 (200-char titles), `complete`/`remove` accept id arrays and report unknown ids instead of silently dropping them, and every mutation emits a `todos` event so the UI status line stays honest. The agent loop appends `planPrompt(runId)` to the system message on each step; once the list exists the model also sees `N of M item(s) still open`. `startEngine`'s `finally` calls `planTodos.clear(runId)`.

Limits: the list is in-memory for the life of one run and is not a durable board — `task_add`, the orchestrator and the workforce scheduler own persistence. A run that is killed leaves nothing to resume.

## 34 Background sub-agent safety

`electron/delegates.cjs` spawns a child `runAgent` in the background and hands the parent tools to inspect it:

| Tool | Behaviour |
| --- | --- |
| `delegate_start` | Creates a task with id `<parent>~<id>`; refuses after 2 concurrent or 20 total children, refuses when the caller is already a child (`allowDelegation: false`), and refuses during emergency stop |
| `delegate_status` | Lists only the caller's children with agent, status, summary/error |
| `delegate_wait` | Waits up to 120 s; on timeout it returns the current state plus a note instead of pretending the child finished |
| `delegate_result` | Returns the final summary or the explicit failure text |
| `delegate_cancel` | Cancels one child; the parent's abort signal cancels all of them |

Children run with `unattended: true`. Before the approval branch the agent loop asks `tools.unattendedDenial`: any tool that would normally need approval is refused with an ERROR tool result and an `tool-unattended-denied` audit row. A child therefore cannot launch apps, run shell commands, delete files or ask the user anything — it can only use the read/analysis tools the main loop already permits without approval. `delegate_start` inside a child is refused; when the parent run ends, `delegates.cancelForParent` stops whatever is left.

Limits: a completed child result is returned through tool results, not delivered as a new chat turn, and a child still running when the app restarts is gone (no durable queue). Concurrency caps are per parent run, not global.

## 35 Large output spill and retention

`runTool` keeps the model's context small without losing the data:

- Output ≤ 6 000 chars stays inline.
- Larger output is written to `<userData>/tool-outputs/<runId>/<timestamp>-<tool>.txt`, capped at 256 KB, and the model gets the first 4 000 chars plus a `fs_read` pointer.
- Before writing, `security.outputTripwire` scans the text. If it matches a credential pattern the file is **not** created and the model is told which patterns blocked it.
- `pruneSpill` removes files older than 7 days and keeps at most 500, called from tool init.
- `fs_read` now returns the whole 512 KB read window and `shell_exec` up to 1 MB, so the spill decision sees the real output rather than a pre-clipped prefix.

Limits: spilling covers tool output only (not chat streaming or model text), the retention values are fixed constants, and a spilled file is plain text under the app's profile — it is protected by disk permissions, not encrypted.

## 36 What the second review changed

Method: 12 combined-keyword web and GitHub searches, top repositories inspected, the six below cloned and their agent runtimes read.

| Repo (license) | Studied | Result |
| --- | --- | --- |
| [microsoft/agent-framework](https://github.com/microsoft/agent-framework) (MIT) | `_todo.py`, `_background_agents.py`, judge loop, tool approval, checkpointing | Todo state ported (13.1), background agents ported with stricter unattended rules (13.2). Judge loop and checkpointing were already covered by orchestrator `validate` and advanced jobs. |
| [VoltAgent/voltagent](https://github.com/VoltAgent/voltagent) (MIT) | `write_todos`, `subagent`, `createToolResultEvictor` | Plan/sub-agent patterns studied; eviction replaced by recoverable spill-to-disk (13.3) so the rest of the run can still read the data. |
| [simular-ai/Agent-S](https://github.com/simular-ai/Agent-S) (Apache-2.0) | S4 island/variant evolution | Not ported: needs a scoring harness ORVEX does not have. |
| [getzep/graphiti](https://github.com/getzep/graphiti) (Apache-2.0) | Bi-temporal edges, MMR + cross-encoder search | Not ported now: memory graph and conflict detection already ship; temporal validity and MMR reranking are future work. |
| [vercel-labs/agent-desktop](https://github.com/vercel-labs/agent-desktop) (Apache-2.0) | Accessibility-tree grounding | Already present as `ui_tree` in Hands. |
| [dbos-inc/durable-swarm](https://github.com/dbos-inc/durable-swarm) (MIT) | Durable workflow wrapper over agents | Not ported: would require the DBOS runtime; ORVEX keeps its own persisted runs and jobs. |

## 37 What the third review changed

Method: both supplied repositories were read at their agent runtimes, then compared against what ORVEX already ships.

| Repo (license) | Studied | Result |
| --- | --- | --- |
| [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) (MIT) | `tools/arg_coercion.py` — schema-guided argument repair | Ported as `electron/tool-args.cjs` (13.7a). Runs before permission floors and approval; every repair is audited; ambiguous values are left for the tool to refuse. |
| [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) (MIT) | `agent/auxiliary_stream_watchdog.py` — abort a stream that goes silent mid-answer | Ported as `electron/stream-watchdog.cjs` (13.7b). 75 s hosted / 150 s local, re-arms per chunk, aborts as retryable so the candidate chain fails over, emits `model_stall`. |
| [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) (MIT) | `approval_floors.py` | Already ported in 12.1. |
| [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) (MIT) | "Smart" LLM approval guardian | Not ported: adds a model call to every risky action and a new injection surface, while deterministic floors already block what must be blocked. |
| [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) (MIT) | Recovery hints for abandoned delegations | Not applicable: ORVEX delegation is in-process and dies with its parent. |
| [vercel-labs/agent-desktop](https://github.com/vercel-labs/agent-desktop) (Apache-2.0) | `crates/core/src/actions/post_action.rs`, `actionability/*` | Post-action verification ported (13.7c): `ui_action` snapshots the element, acts, polls 4×200 ms and reports `verified` / `changed` / unknown honestly. Full actionability gating, batching and the cursor overlay were not ported — ORVEX has an explicit `wait` and a single-action tool. |
| [vercel-labs/agent-desktop](https://github.com/vercel-labs/agent-desktop) (Apache-2.0) | Accessibility-tree grounding | Already present as `ui_tree` in Hands. |

Guardrail note for 13.7a: argument repair can only narrow a value to the tool's own declared JSON Schema, and it happens **before** `permissions.floorReason`, so a floor still sees the repaired argument object. A repair is recorded as a `tool-args-coerced` audit row; it cannot turn a denied tool into an allowed one.

## 38 Verification (Phase 13.7)

| Suite | Result |
| --- | --- |
| `npm test` | 347/347 (29 files, +9 for argument repair and the stall watchdog) |
| `npm run test:e2e:source` | 122/122 |
| `npm run test:e2e` (packaged) | 122/122 |
| `smoke:planning` | 22/22 |
| `smoke:gateway` | OK — provider chain with the stall watchdog wired |
| `smoke:desktop` (live CDP) | 31/31, including `ui_action` focus and set-value verification |
| `npm run build` | tsc + Vite green |
