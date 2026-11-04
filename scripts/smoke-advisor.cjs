'use strict';

/**
 * Phase 11 — Advisor smoke.
 * Opens a real temporary profile, writes runs and usage rows, drains real
 * suggestions, dismisses one, builds the daily brief, saves budgets and checks
 * an update feed through an injected fetch.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const advisor = require('../electron/advisor.cjs');
const db = require('../electron/db.cjs');
const guardrails = require('../electron/guardrails.cjs');

const DAY = 24 * 3600 * 1000;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-advisor-'));
const dataDir = path.join(root, 'profile');
fs.mkdirSync(dataDir, { recursive: true });

let pass = 0;
let fail = 0;

function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    process.exitCode = 1;
  }
}

function fakeProviders() {
  const at = Date.now();
  return {
    model: () => ({ chat: false, vision: false }),
    monitor: () => ({ at }),
    training: () => ({ episodes: 24, usedBytes: 1024, quotaBytes: 4096, overQuota: false, diskTight: false }),
    brain: () => ({ enabled: true, offline: true, runtimeFound: false, models: { count: 0 }, server: { state: 'stopped' } }),
    learner: () => ({ kits: 0, fineTunes: { open: 0 }, skills: { suggested: 2 } }),
    advanced: () => ({ suggestions: 2, interruptedJobs: 1 }),
    workforce: () => ({ unread: 3 }),
    backups: () => [{ at: at - 8 * DAY }],
    crashes: () => [{ at: at - 60_000, reason: 'smoke' }],
  };
}

(async () => {
  db.init({ file: path.join(dataDir, 'orvex.db') });
  const now = Date.now();
  const insert = db.raw().prepare(
    `INSERT INTO runs(id, goal, status, started_at, ended_at) VALUES(?, ?, ?, ?, ?)`,
  );
  insert.run('run-ok', 'done run', 'done', now - 3600_000, now - 3500_000);
  insert.run('run-bad', 'failed run', 'failed', now - 3000_000, now - 2500_000);
  db.recordUsage({ ts: now - 1000, task: 'agent', model: 'smoke', costUsd: 1.5, totalTokens: 20, ms: 50 });

  advisor.init({ version: '1.9.0', providers: fakeProviders() });

  const toolNames = advisor.definitions.map((d) => d.name);
  check('advisor tools are registered', toolNames.includes('advisor_brief') && toolNames.includes('advisor_suggestions'));
  check('advisor tools are read-only', guardrails.needsApproval('advisor_brief', {}) === null);
  check('advisor handlers are callable', typeof advisor.handlers.advisor_brief === 'function' && typeof advisor.handlers.advisor_suggestions === 'function');

  const first = await advisor.suggestions({ force: true });
  const ids = first.items.map((item) => item.id);
  check(
    'collects real signals',
    ['model-missing', 'run-failures', 'recent-crashes', 'interrupted-jobs', 'learning-review', 'inbox-unread', 'train-kit', 'skills-review', 'backup-stale', 'brain-offline'].every((id) => ids.includes(id)),
    `${ids.length} suggestions`,
  );
  check('critical suggestion ranks first', first.items[0].id === 'model-missing' && first.items[0].severity === 'critical');
  check('suggestion carries a target page', first.items[0].action && first.items[0].action.target === 'settings');

  const dismissed = advisor.dismiss({ id: 'inbox-unread', hours: 1 });
  const second = await advisor.suggestions({ force: true });
  check('dismissals persist and filter', dismissed.dismissed >= 1 && !second.items.some((item) => item.id === 'inbox-unread'));
  advisor.restore({ id: 'inbox-unread' });
  const restored = await advisor.suggestions({ force: true });
  check('restore brings a suggestion back', restored.items.some((item) => item.id === 'inbox-unread'));

  const brief = await advisor.brief({ force: true });
  check('brief counts today’s runs', brief.stats.runsToday === 2 && brief.stats.runsDone === 1 && brief.stats.runsFailed === 1);
  check('brief computes the success rate', brief.stats.successRate === 50);
  check('brief reads unread reports', brief.stats.unread === 3);
  check('brief reports the backup age', brief.stats.backups === 1 && brief.stats.lastBackupAt > 0);
  check('brief has a real headline', brief.headline.includes('2 runs today') && brief.headline.includes('$1.50'));
  check('brief lists highlights', brief.highlights.length >= 3);
  check('brief keeps the top five', brief.top.length <= 5 && brief.itemsCount > 5);

  const budget = advisor.setBudget({ dailyUsd: 1, monthlyUsd: 10 });
  check('budget reads the usage ledger', budget.todayUsd === 1.5 && budget.monthUsd === 1.5);
  check('budget flags the daily limit', budget.dailyReached === true && budget.remainingTodayUsd === 0);
  check('budget keeps the monthly headroom', budget.monthlyPct === 15 && budget.remainingMonthUsd === 8.5);
  const withBudget = await advisor.suggestions({ force: true });
  check('budget alert joins the ranking', withBudget.items.some((item) => item.id === 'budget-daily'));

  advisor.init({
    version: '1.9.0',
    providers: fakeProviders(),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ tag_name: 'v2.0.0', html_url: 'https://example.com/release', body: 'Release notes' }),
    }),
  });
  check('feed rejects plain http', (() => {
    try {
      advisor.setUpdateFeed({ url: 'http://example.com/feed.json' });
      return false;
    } catch {
      return true;
    }
  })());
  advisor.setUpdateFeed({ url: 'https://updates.example.com/orvex.json' });
  const update = await advisor.checkUpdate();
  check('update check sees a newer tag', update.ok === true && update.available === true && update.latest === '2.0.0', update.latest || update.error || '');
  check('update result is cached', advisor.getUpdate().last && advisor.getUpdate().last.available === true);
  const withUpdate = await advisor.suggestions({ force: true });
  const updateItem = withUpdate.items.find((item) => item.id === 'update-available');
  check('update joins the ranking with its release link', !!updateItem && updateItem.url === 'https://example.com/release');

  const briefText = await advisor.handlers.advisor_brief({});
  check('brief tool returns readable output', briefText.ok === true && briefText.output.includes('Daily brief'));
  const listText = await advisor.handlers.advisor_suggestions({ limit: 3 });
  check('suggestions tool respects its limit', listText.ok === true && listText.output.split('\n').filter((line) => /^\d+\./.test(line)).length === 3);

  db.close();
  fs.rmSync(root, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})().catch((err) => {
  console.error(err);
  try {
    db.close();
  } catch {
    /* already closed */
  }
  fs.rmSync(root, { recursive: true, force: true });
  process.exitCode = 1;
});
