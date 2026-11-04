# ORVEX — Advisor and operations (Sections 23–26)

The Advisor is ORVEX's own operating picture. It does not guess: every suggestion, stat and budget number is read from a real module status call or a database row, and a signal that cannot be read is reported as `null` instead of a plausible-looking placeholder.

## 23. Advisor

**Module:** `electron/advisor.cjs`. **Surface:** Advisor page (`src/pages/AdvisorPage.tsx`), sidebar entry, and two read-only agent tools.

### 23.1 Signal collection

Main injects providers during startup, so the module never reaches into another module's private state:

```js
advisor.init({
  version: () => app.getVersion(),
  providers: {
    model, monitor, training, brain, learner, advanced, workforce, backups, crashes,
  },
})
```

`collect()` calls each provider inside `try/catch`. A provider that throws makes its signal `null` (the related rules simply do not fire) rather than crashing the brief or inventing a default. From SQLite it reads:

- runs started today (total, done, failed, running, finished);
- `db.usageCostSince(startOfDay)` and `db.usageCostSince(startOfMonth)`;
- the configured model chain (chat / vision present or not).

The result is cached for 15 seconds (`COLLECT_MS`); page loads and tool calls pass `force` to bypass the cache, and `invalidate()` clears it after budget or dismissal changes.

### 23.2 Suggestion rules

| Rule id | Severity | Trigger (real state) | Action target |
| --- | --- | --- | --- |
| `model-missing` | critical | no chat provider in the configured chain | Settings → Providers |
| `budget-daily` | high / medium | today's spend reached / ≥80% of the daily limit | Settings → Usage |
| `budget-monthly` | high / medium | month spend reached / ≥80% of the monthly limit | Settings → Usage |
| `run-failures` | high | failed runs today (score boost ≤10) | Agents |
| `recent-crashes` | high | crash reports in the last 24 h | System → Failures |
| `interrupted-jobs` | high | autonomous jobs interrupted or paused | Advanced |
| `learning-review` | medium | mined suggestions awaiting approval | Advanced |
| `inbox-unread` | medium | unread workforce shift reports | Workforce |
| `training-quota` | high | training vault at quota | Training → Vault |
| `training-disk` | medium | free disk below the 20 GB reserve | Training → Vault |
| `train-kit` | low | ≥20 episodes and no exported kit | Training → Train kit |
| `skills-review` | low | imported skills awaiting activation | Training → Skills |
| `backup-missing` / `backup-stale` | medium | no backup / last backup older than 7 days | Security → Backup |
| `brain-offline` | high | offline mode on and `llama-server` missing | Training → Local brain |
| `brain-runtime` | low | local brain enabled but runtime not installed | Training → Local brain |
| `update-available` | medium | cached feed version is newer than the build | Advisor → Updates |

Scoring is deterministic: `critical 100`, `high 70`, `medium 45`, `low 20`, plus an explicit per-rule boost capped at 20. `rankSuggestions()` filters expired dismissals, sorts by score and then by id (stable ordering across reloads), and assigns `rank`.

### 23.3 Dismissals

Dismissals are stored in `settings['advisor.dismissed']` as `{ [id]: untilTimestamp }`. `dismiss({ id, hours })` accepts 1–720 hours (default 24) and audits the action in main; `restore({ id })` removes one entry, and `restore({})` clears them all. Expired entries are filtered on read, so the list heals itself without a cleanup job.

### 23.4 IPC and tools

| Channel | Purpose | Guard |
| --- | --- | --- |
| `orvex:advisor:brief` | daily brief (forces fresh collection) | none — read-only |
| `orvex:advisor:suggestions` | ranked suggestions | none — read-only |
| `orvex:advisor:dismiss` | dismiss for N hours | audited |
| `orvex:advisor:restore` | restore one or all | none |
| `orvex:advisor:budget` / `:budget:set` | read / write budgets | set requires owner |
| `orvex:advisor:update` / `:update:feed` / `:update:check` | read / set feed / check now | feed write and check require owner |

Agent tools are deliberately read-only: `advisor_brief` (no parameters) and `advisor_suggestions` (limit 1–20, default 10). The agent can read the plan and act through normal tools, but cannot dismiss a suggestion on the user's behalf.

## 24. Daily brief

`brief()` builds from the same signals as the suggestion list, so the two views cannot disagree:

- **Headline:** `"N runs today · $X.XX spent · M suggestions"`.
- **Stats:** runs today/done/failed/running, success rate (done ÷ finished), spend today and month, unread reports, training episodes, backup count and last backup time, crashes in 24 h, active and dismissed suggestion counts.
- **Highlights:** run outcome, budget sentence, unread inbox, backup age and the single top-priority suggestion.
- **Top five:** the ranked items with severity, title and detail.

The brief is computed on demand (page load or `advisor_brief`). No background notification or scheduled report is created — the honest limit is stated in the roadmap.

## 25. Budgets

Budgets live in settings: `budget.dailyUsd` and `budget.monthlyUsd` (USD, `0` disables a limit). Validation accepts 0–1,000,000 and rounds to four decimals.

`budgetStatus()` returns limits, spend, percentage, remaining amount and four booleans: `dailyReached`, `monthlyReached`, `dailyNear`, `monthlyNear` (≥80% and below the limit). Spend comes from the usage ledger via `db.usageCostSince(startOfDay | startOfMonth)` — the same rows the Usage page and engine accounting use.

The Advisor page shows both bars and lets the owner edit the limits; the Settings → Usage surface remains the place to inspect the underlying cost rows. Budgets are **advisory**: crossing one raises a high-severity suggestion and highlights it in the brief, but paid runs are not hard-stopped. Workforce agents keep their own per-agent budget pause.

## 26. Backups and update checks

### 26.1 Backups

The Advisor reads `security.listBackups()`; each backup is a real file in `<profile>/backups/`, named `orvex-backup-<UTC timestamp>-<hex>.zip` or `.orvx` when encrypted. A backup snapshots the database (SQLite snapshot when available) plus preferences, permissions, workflow definitions and the other whitelisted files. The Advisor card shows count, last timestamp and a **Create backup** action (audited, note `Created from Advisor`). Restore and delete stay on Security → Backup so a backup cannot be overwritten by accident from a summary page.

Two rules keep backups visible: `backup-missing` when none exists, and `backup-stale` when the newest is older than seven days.

### 26.2 Update checks

There is no bundled update channel. The user supplies a JSON feed URL; the module stores it in `settings['advisor.update.feedUrl']` and refuses anything that is not `https://` on a public host (no credentials in the URL, no localhost, `.local`, loopback, link-local or RFC 1918 ranges).

A check:

1. fetches with `accept: application/json`, `redirect: follow`, a 10-second timeout and a 512 KB response cap;
2. accepts `version | tag_name | latest | tag` for the version, `url | html_url | release_url | download_url` for the link, `notes | body | changelog | description` for notes (capped at 4,000 chars), and the common published-date keys;
3. refuses a feed without a valid version number;
4. compares with semver rules, including prerelease identifiers (`1.0.0-beta.2 < 1.0.0-beta.10 < 1.0.0`);
5. caches the whole result (success or error) in `settings['advisor.update.last']` and, when newer, adds the `update-available` suggestion with the release URL.

Before a feed is configured, `checkUpdate()` returns `configured: false` with a clear note instead of a fake "up to date" answer. The check never downloads or installs anything; the installer is unsigned, so the UI tells the user to verify the download themselves.

## 27. Verification

| Suite | Coverage |
| --- | --- |
| `tests/unit/advisor.test.mjs` (13) | semver and prerelease order, feed URL policy, feed normalisation, budget math and validation, every rule, dismissal expiry/ranking, live collection with a stubbed DB, dismiss/restore, update success/error/no-feed |
| `scripts/smoke-advisor.cjs` (25) | real database, inserted runs and usage, injected providers, 10 signal ids, critical ranking, dismissal TTL and restore, brief counts/headline, budget percentages, cached update result, tool registration and read-only behaviour, formatted tool output |
| e2e (source and packaged) | Advisor page mounts from the sidebar, `budget` exposes daily and monthly limits, brief is built from real state, no demo copy |
| visual | 6 fixed pages compared pixel-by-pixel against baselines in both source and packaged runs |
