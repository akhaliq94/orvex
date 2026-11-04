'use strict';

/**
 * Advisor: turns real ORVEX state into ranked suggestions and a daily brief.
 * Every number comes from the database or a module status call — nothing is
 * invented, and a signal that cannot be read is reported as unavailable.
 */

const db = require('./db.cjs');

const DAY = 24 * 3600 * 1000;
const COLLECT_MS = 15_000;
const DISMISS_KEY = 'advisor.dismissed';
const UPDATE_KEY = 'advisor.update.last';
const FEED_KEY = 'advisor.update.feedUrl';
const MONTHLY_KEY = 'budget.monthlyUsd';
const MAX_FEED_BYTES = 512 * 1024;

const SEVERITY = { critical: 100, high: 70, medium: 45, low: 20 };

let ctx = { version: '0.0.0', providers: {}, fetchImpl: null };
let cache = { at: 0, value: null };

/* ------------------------------------------------------------ settings */

function readJson(key, fallback) {
  try {
    const raw = db.getSetting(key, null);
    if (!raw) return fallback;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  db.setSetting(key, value);
}

function startOfDay(at = Date.now()) {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function startOfMonth(at = Date.now()) {
  const date = new Date(at);
  date.setDate(1);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function round4(value) {
  return Math.round((Number(value) || 0) * 1e4) / 1e4;
}

function versionOf() {
  try {
    return String(typeof ctx.version === 'function' ? ctx.version() : ctx.version || '0.0.0');
  } catch {
    return '0.0.0';
  }
}

/* ------------------------------------------------------------- budgets */

function budgetStatus(input = {}) {
  const dailyUsd = Math.max(0, Number(input.dailyUsd) || 0);
  const monthlyUsd = Math.max(0, Number(input.monthlyUsd) || 0);
  const todayUsd = round4(Math.max(0, Number(input.todayUsd) || 0));
  const monthUsd = round4(Math.max(0, Number(input.monthUsd) || 0));
  const pct = (spent, limit) => (limit > 0 ? Math.round((spent / limit) * 1000) / 10 : null);
  return {
    dailyUsd: round4(dailyUsd),
    monthlyUsd: round4(monthlyUsd),
    todayUsd,
    monthUsd,
    dailyPct: pct(todayUsd, dailyUsd),
    monthlyPct: pct(monthUsd, monthlyUsd),
    remainingTodayUsd: dailyUsd > 0 ? round4(Math.max(0, dailyUsd - todayUsd)) : null,
    remainingMonthUsd: monthlyUsd > 0 ? round4(Math.max(0, monthlyUsd - monthUsd)) : null,
    dailyReached: dailyUsd > 0 && todayUsd >= dailyUsd,
    monthlyReached: monthlyUsd > 0 && monthUsd >= monthlyUsd,
    dailyNear: dailyUsd > 0 && todayUsd < dailyUsd && todayUsd >= dailyUsd * 0.8,
    monthlyNear: monthlyUsd > 0 && monthUsd < monthlyUsd && monthUsd >= monthlyUsd * 0.8,
  };
}

function getBudget() {
  const dailyUsd = Number(db.getSetting('budget.dailyUsd', 0)) || 0;
  const monthlyUsd = Number(db.getSetting(MONTHLY_KEY, 0)) || 0;
  const at = Date.now();
  return budgetStatus({
    dailyUsd,
    monthlyUsd,
    todayUsd: db.usageCostSince(startOfDay(at)),
    monthUsd: db.usageCostSince(startOfMonth(at)),
  });
}

function setBudget(patch = {}) {
  const parse = (value, label) => {
    if (value === undefined) return undefined;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 1_000_000) throw new Error(`${label} must be between 0 and 1,000,000 USD (0 disables it).`);
    return round4(n);
  };
  const daily = parse(patch.dailyUsd, 'The daily budget');
  const monthly = parse(patch.monthlyUsd, 'The monthly budget');
  if (daily !== undefined) db.setSetting('budget.dailyUsd', daily);
  if (monthly !== undefined) db.setSetting(MONTHLY_KEY, monthly);
  return getBudget();
}

/* -------------------------------------------------------------- update */

function isFeedUrl(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
  if (host === '::1' || host === '[::1]') return false;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  return true;
}

/** Numeric semver comparison; a prerelease sorts below its release. */
function compareVersions(a, b) {
  const parse = (value) => {
    const text = String(value || '').trim().replace(/^v/i, '');
    const [core, ...rest] = text.split('-');
    const nums = core.split('.').map((part) => {
      const n = Number.parseInt(part.replace(/[^0-9].*$/, ''), 10);
      return Number.isFinite(n) ? n : 0;
    });
    return { nums, pre: rest.join('-') };
  };
  const left = parse(a);
  const right = parse(b);
  const len = Math.max(left.nums.length, right.nums.length);
  for (let i = 0; i < len; i += 1) {
    const x = left.nums[i] || 0;
    const y = right.nums[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  if (left.pre && !right.pre) return -1;
  if (!left.pre && right.pre) return 1;
  if (left.pre === right.pre) return 0;
  const leftPre = left.pre.split('.');
  const rightPre = right.pre.split('.');
  const parts = Math.max(leftPre.length, rightPre.length);
  for (let i = 0; i < parts; i += 1) {
    if (leftPre[i] === undefined) return -1;
    if (rightPre[i] === undefined) return 1;
    const na = /^\d+$/.test(leftPre[i]) ? Number(leftPre[i]) : null;
    const nb = /^\d+$/.test(rightPre[i]) ? Number(rightPre[i]) : null;
    if (na !== null && nb !== null) {
      if (na !== nb) return na > nb ? 1 : -1;
      continue;
    }
    if (na !== null) return -1;
    if (nb !== null) return 1;
    if (leftPre[i] !== rightPre[i]) return leftPre[i] > rightPre[i] ? 1 : -1;
  }
  return 0;
}

function normalizeFeed(json) {
  if (!json || typeof json !== 'object') throw new Error('The update feed did not return a JSON object.');
  const pick = (...keys) => {
    for (const key of keys) {
      const value = json[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
  };
  const latest = pick('version', 'tag_name', 'latest', 'tag').replace(/^v/i, '');
  if (!latest || !/^\d+(\.\d+)*/.test(latest)) throw new Error('The update feed did not include a version number.');
  return {
    latest,
    url: pick('url', 'html_url', 'release_url', 'download_url'),
    notes: pick('notes', 'body', 'changelog', 'description').slice(0, 4000),
    publishedAt: pick('publishedAt', 'published_at', 'date', 'released_at'),
  };
}

function getUpdate() {
  return {
    feedUrl: String(db.getSetting(FEED_KEY, '') || ''),
    last: readJson(UPDATE_KEY, null),
  };
}

function setUpdateFeed({ url } = {}) {
  const value = String(url || '').trim();
  if (value && !isFeedUrl(value)) throw new Error('Use an https:// feed URL that points at a public host.');
  db.setSetting(FEED_KEY, value);
  if (!value) db.setSetting(UPDATE_KEY, '');
  return getUpdate();
}

async function checkUpdate({ url } = {}) {
  const feedUrl = String(url || db.getSetting(FEED_KEY, '') || '').trim();
  const current = versionOf();
  const base = { current, feedUrl, checkedAt: Date.now() };
  if (!feedUrl) return { ...base, configured: false, ok: false, available: false, note: 'No update feed is configured.' };
  if (!isFeedUrl(feedUrl)) throw new Error('Use an https:// feed URL that points at a public host.');
  const doFetch = ctx.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) throw new Error('This runtime has no fetch implementation, so the update feed cannot be checked.');
  let result;
  try {
    const response = await doFetch(feedUrl, {
      headers: { accept: 'application/json' },
      redirect: 'follow',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response || response.ok === false) throw new Error(`The update feed responded ${response ? response.status : 'with no response'}.`);
    const text = String(await response.text()).slice(0, MAX_FEED_BYTES);
    const feed = normalizeFeed(JSON.parse(text));
    result = {
      ...base,
      configured: true,
      ok: true,
      latest: feed.latest,
      available: compareVersions(feed.latest, current) > 0,
      url: feed.url,
      notes: feed.notes,
      publishedAt: feed.publishedAt,
      error: null,
    };
  } catch (err) {
    result = {
      ...base,
      configured: true,
      ok: false,
      available: false,
      latest: null,
      url: '',
      notes: '',
      publishedAt: '',
      error: err && err.message ? err.message : String(err),
    };
  }
  writeJson(UPDATE_KEY, result);
  return result;
}

/* ---------------------------------------------------------- suggestions */

function make(id, severity, title, detail, action, extra = {}) {
  const base = SEVERITY[severity] || SEVERITY.low;
  const boost = Math.min(Math.max(Number(extra.boost) || 0, 0), 20);
  const out = {
    id,
    severity,
    title,
    detail,
    action: action || null,
    score: base + boost,
  };
  if (extra.count !== undefined) out.count = Number(extra.count) || 0;
  if (extra.url) out.url = extra.url;
  return out;
}

function readDismissed() {
  const raw = readJson(DISMISS_KEY, {});
  const at = Date.now();
  const clean = {};
  for (const [id, until] of Object.entries(raw)) {
    const t = Number(until);
    if (Number.isFinite(t) && t > at) clean[id] = t;
  }
  return clean;
}

/** Pure ranking: filter dismissed entries, sort by score then id. */
function rankSuggestions(items, dismissed = {}, at = Date.now()) {
  const left = (Array.isArray(items) ? items : []).filter((item) => {
    if (!item || !item.id) return false;
    const until = Number(dismissed[item.id]);
    return !(Number.isFinite(until) && until > at);
  });
  return left
    .slice()
    .sort((a, b) => (b.score || 0) - (a.score || 0) || String(a.id).localeCompare(String(b.id)))
    .map((item, index) => ({ ...item, rank: index + 1 }));
}

function buildSuggestions(signals) {
  const list = [];
  const runs = signals.runs || { today: 0, failed: 0, finished: 0, done: 0 };
  const budget = signals.budget || budgetStatus({});
  const model = signals.model || null;
  const inbox = signals.inbox || { unread: 0 };
  const training = signals.training || null;
  const brain = signals.brain || null;
  const learner = signals.learner || null;
  const advanced = signals.advanced || null;
  const backups = signals.backups || null;
  const crashes = Array.isArray(signals.crashes) ? signals.crashes : [];
  const update = signals.update && signals.update.last ? signals.update.last : null;

  if (model && model.chat === false) {
    list.push(
      make(
        'model-missing',
        'critical',
        'No model provider is configured',
        'Chats, agents, hands and workforce shifts need a reachable endpoint. Add a provider key or install the local brain runtime.',
        { label: 'Open Settings', target: 'settings' },
      ),
    );
  }

  if (budget.dailyReached) {
    list.push(
      make(
        'budget-daily',
        'high',
        'Today’s spend reached the daily budget',
        `Spent $${budget.todayUsd.toFixed(2)} of $${budget.dailyUsd.toFixed(2)}. Paid model calls now stop until the limit is raised in Settings → Usage; local models keep working.`,
        { label: 'Open Usage', target: 'settings', tab: 'usage' },
        { boost: 6 },
      ),
    );
  } else if (budget.dailyNear) {
    list.push(
      make(
        'budget-daily',
        'medium',
        'Daily budget is nearly used',
        `Spent $${budget.todayUsd.toFixed(2)} of $${budget.dailyUsd.toFixed(2)} (${budget.dailyPct}%).`,
        { label: 'Open Usage', target: 'settings', tab: 'usage' },
      ),
    );
  }

  if (budget.monthlyReached) {
    list.push(
      make(
        'budget-monthly',
        'high',
        'This month’s spend reached the monthly budget',
        `Spent $${budget.monthUsd.toFixed(2)} of $${budget.monthlyUsd.toFixed(2)}.`,
        { label: 'Open Usage', target: 'settings', tab: 'usage' },
      ),
    );
  } else if (budget.monthlyNear) {
    list.push(
      make(
        'budget-monthly',
        'medium',
        'Monthly budget is nearly used',
        `Spent $${budget.monthUsd.toFixed(2)} of $${budget.monthlyUsd.toFixed(2)} (${budget.monthlyPct}%).`,
        { label: 'Open Usage', target: 'settings', tab: 'usage' },
      ),
    );
  }

  if (runs.failed > 0) {
    list.push(
      make(
        'run-failures',
        'high',
        `${runs.failed} failed run${runs.failed === 1 ? '' : 's'} today`,
        'Open the run history and inspect the failing step before re-running.',
        { label: 'Open Agents', target: 'agents', tab: 'tools' },
        { count: runs.failed, boost: Math.min(runs.failed, 10) },
      ),
    );
  }

  if (crashes.length > 0) {
    list.push(
      make(
        'recent-crashes',
        'high',
        `${crashes.length} crash report${crashes.length === 1 ? '' : 's'} in the last 24 hours`,
        'Check the failure log; repeated crashes usually mean a missing native module or a bad profile.',
        { label: 'Open Failures', target: 'system', tab: 'failures' },
        { count: crashes.length },
      ),
    );
  }

  if (advanced && advanced.interruptedJobs > 0) {
    list.push(
      make(
        'interrupted-jobs',
        'high',
        `${advanced.interruptedJobs} autonomous job${advanced.interruptedJobs === 1 ? '' : 's'} interrupted or paused`,
        'Resume from the checkpoint or discard the job so it stops occupying the queue.',
        { label: 'Open Advanced', target: 'advanced' },
        { count: advanced.interruptedJobs },
      ),
    );
  }

  if (advanced && advanced.suggestions > 0) {
    list.push(
      make(
        'learning-review',
        'medium',
        `${advanced.suggestions} learned workflow suggestion${advanced.suggestions === 1 ? '' : 's'} waiting`,
        'Mined from real audit and usage rows. Approve or dismiss each one; nothing is applied automatically.',
        { label: 'Review', target: 'advanced' },
        { count: advanced.suggestions },
      ),
    );
  }

  if (inbox.unread > 0) {
    list.push(
      make(
        'inbox-unread',
        'medium',
        `${inbox.unread} unread shift report${inbox.unread === 1 ? '' : 's'}`,
        'Workforce agents leave a report in the inbox after every shift.',
        { label: 'Open Workforce', target: 'workforce' },
        { count: inbox.unread },
      ),
    );
  }

  if (training && training.overQuota) {
    list.push(
      make(
        'training-quota',
        'high',
        'The training vault is at its quota',
        'New episodes are refused until the quota is raised or old episodes are deleted.',
        { label: 'Open Vault', target: 'training', tab: 'vault' },
      ),
    );
  }

  if (training && training.diskTight) {
    list.push(
      make(
        'training-disk',
        'medium',
        'Free disk space is below the 20 GB reserve',
        'The training vault stops writing before the drive fills up. Free space or move the vault.',
        { label: 'Open Vault', target: 'training', tab: 'vault' },
      ),
    );
  }

  if (training && learner && training.episodes >= 20 && !(learner.kits > 0)) {
    list.push(
      make(
        'train-kit',
        'low',
        `${training.episodes} recorded episodes have no train kit`,
        'Export a Train Kit to fine-tune on a free GPU or to score a candidate model.',
        { label: 'Open Train Kit', target: 'training', tab: 'kit' },
        { count: training.episodes },
      ),
    );
  }

  if (learner && learner.skills && learner.skills.suggested > 0) {
    list.push(
      make(
        'skills-review',
        'low',
        `${learner.skills.suggested} imported skill${learner.skills.suggested === 1 ? '' : 's'} await activation`,
        'Imported skills stay inactive until you enable them.',
        { label: 'Open Skills', target: 'training', tab: 'skills' },
        { count: learner.skills.suggested },
      ),
    );
  }

  if (backups) {
    const lastAt = Number(backups.lastAt) || 0;
    const age = lastAt ? signals.at - lastAt : null;
    if (!lastAt) {
      list.push(
        make('backup-missing', 'medium', 'No backup has been created yet', 'A backup captures the database, preferences, permissions and workflow definitions.', {
          label: 'Open Backup',
          target: 'security',
          tab: 'backup',
        }),
      );
    } else if (age > 7 * DAY) {
      list.push(
        make(
          'backup-stale',
          'medium',
          'The last backup is over a week old',
          `Last backup: ${new Date(lastAt).toLocaleString()}.`,
          { label: 'Open Backup', target: 'security', tab: 'backup' },
        ),
      );
    }
  }

  if (brain) {
    if (brain.offline && !brain.runtimeFound) {
      list.push(
        make(
          'brain-offline',
          'high',
          'Offline mode is on but llama-server is missing',
          'Routes are blocked until the runtime binary is added to the training vault runtime folder.',
          { label: 'Open Local Brain', target: 'training', tab: 'brain' },
        ),
      );
    } else if (brain.enabled && !brain.runtimeFound) {
      list.push(
        make(
          'brain-runtime',
          'low',
          'The local brain runtime is not installed',
          'Adding llama-server enables local inference without a provider key.',
          { label: 'Open Local Brain', target: 'training', tab: 'brain' },
        ),
      );
    }
  }

  if (update && update.available && update.latest) {
    list.push(
      make(
        'update-available',
        'medium',
        `ORVEX ${update.latest} is available`,
        `This build is ${signals.version}. The installer is unsigned, so verify the download yourself.`,
        { label: 'Open Advisor', target: 'advisor', tab: 'updates' },
        { url: update.url || '' },
      ),
    );
  }

  return list;
}

/* ------------------------------------------------------------- collect */

async function callProvider(fn) {
  if (typeof fn !== 'function') return null;
  try {
    return await fn();
  } catch {
    return null;
  }
}

function runsSince(ts) {
  const handle = db.raw();
  if (!handle) return { today: 0, failed: 0, running: 0, done: 0, finished: 0 };
  try {
    const row = handle
      .prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END),0) AS failed,
                COALESCE(SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END),0) AS done,
                COALESCE(SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END),0) AS running,
                COALESCE(SUM(CASE WHEN status IN ('done','failed') THEN 1 ELSE 0 END),0) AS finished
         FROM runs WHERE started_at >= ?`,
      )
      .get(ts);
    return {
      today: Number(row?.total) || 0,
      failed: Number(row?.failed) || 0,
      done: Number(row?.done) || 0,
      running: Number(row?.running) || 0,
      finished: Number(row?.finished) || 0,
    };
  } catch {
    return { today: 0, failed: 0, running: 0, done: 0, finished: 0 };
  }
}

async function collect({ force = false } = {}) {
  const at = Date.now();
  if (!force && cache.value && at - cache.at < COLLECT_MS) return cache.value;
  const providers = ctx.providers || {};
  const [monitorSt, trainingSt, brainSt, learnerSt, advancedSt, workforceSt, backups, crashes] = await Promise.all([
    callProvider(providers.monitor),
    callProvider(providers.training),
    callProvider(providers.brain),
    callProvider(providers.learner),
    callProvider(providers.advanced),
    callProvider(providers.workforce),
    callProvider(providers.backups),
    callProvider(providers.crashes),
  ]);
  const model = (await callProvider(providers.model)) || null;
  const runs = runsSince(startOfDay(at));
  const budget = getBudget();
  const list = Array.isArray(backups) ? backups : null;
  const recentCrashes = (Array.isArray(crashes) ? crashes : []).filter((row) => Number(row && row.at) >= at - DAY);
  const signals = {
    at,
    version: versionOf(),
    model,
    runs,
    budget,
    inbox: { unread: Number(workforceSt && workforceSt.unread) || 0 },
    crashes: recentCrashes,
    backups: list ? { count: list.length, lastAt: list.reduce((max, row) => Math.max(max, Number(row && row.at) || 0), 0) } : null,
    training: trainingSt
      ? {
          episodes: Number(trainingSt.episodes) || 0,
          usedBytes: Number(trainingSt.usedBytes) || 0,
          quotaBytes: Number(trainingSt.quotaBytes) || 0,
          overQuota: !!trainingSt.overQuota,
          diskTight: !!trainingSt.diskTight,
        }
      : null,
    brain: brainSt
      ? {
          enabled: !!brainSt.enabled,
          offline: !!brainSt.offline,
          runtimeFound: !!(brainSt.runtime && brainSt.runtime.found),
          models: Number(brainSt.models && brainSt.models.count) || 0,
          serverState: brainSt.server ? brainSt.server.state : null,
        }
      : null,
    learner: learnerSt
      ? {
          kits: Number(learnerSt.kits) || 0,
          fineTunesOpen: Number(learnerSt.fineTunes && learnerSt.fineTunes.open) || 0,
          skills: { suggested: Number(learnerSt.skills && learnerSt.skills.suggested) || 0 },
        }
      : null,
    advanced: advancedSt
      ? {
          suggestions: Number(advancedSt.suggestions) || 0,
          interruptedJobs: Number(advancedSt.interruptedJobs) || 0,
        }
      : null,
    update: getUpdate(),
    monitor: monitorSt ? { crashes: Number(monitorSt.crashes && monitorSt.crashes.id ? 1 : 0) } : null,
  };
  signals.items = buildSuggestions(signals);
  cache = { at, value: signals };
  return signals;
}

async function suggestions(options = {}) {
  const signals = await collect(options);
  const dismissed = readDismissed();
  const items = rankSuggestions(signals.items, dismissed, Date.now());
  return { at: signals.at, items, dismissed: Object.keys(dismissed).length };
}

function dismiss({ id, hours = 24 } = {}) {
  const key = String(id || '').trim();
  if (!key || key.length > 80) throw new Error('Pick a suggestion to dismiss.');
  const span = Math.min(Math.max(Number(hours) || 24, 1), 24 * 30);
  const map = readDismissed();
  map[key] = Date.now() + span * 3600 * 1000;
  writeJson(DISMISS_KEY, map);
  return { id: key, until: map[key], dismissed: Object.keys(map).length };
}

function restore({ id } = {}) {
  const key = String(id || '').trim();
  if (!key) {
    writeJson(DISMISS_KEY, {});
    return { restored: 'all', dismissed: 0 };
  }
  const map = readDismissed();
  delete map[key];
  writeJson(DISMISS_KEY, map);
  return { restored: key, dismissed: Object.keys(map).length };
}

async function brief(options = {}) {
  const signals = await collect(options);
  const dismissed = readDismissed();
  const items = rankSuggestions(signals.items, dismissed, Date.now());
  const runs = signals.runs;
  const budget = signals.budget;
  const successRate = runs.finished > 0 ? Math.round((runs.done / runs.finished) * 1000) / 10 : null;
  const highlights = [];
  if (runs.today > 0) {
    highlights.push(
      runs.failed > 0
        ? `${runs.done} of ${runs.finished} finished runs succeeded; ${runs.failed} failed.`
        : `${runs.done} run${runs.done === 1 ? '' : 's'} finished today with no failures.`,
    );
  } else {
    highlights.push('No agent run has been started today.');
  }
  highlights.push(budget.dailyUsd > 0 ? `Spent $${budget.todayUsd.toFixed(2)} of the $${budget.dailyUsd.toFixed(2)} daily budget.` : `Spent $${budget.todayUsd.toFixed(2)} today; no daily budget is set.`);
  if (signals.inbox.unread > 0) highlights.push(`${signals.inbox.unread} unread shift report${signals.inbox.unread === 1 ? '' : 's'} in the workforce inbox.`);
  if (signals.backups) {
    highlights.push(
      signals.backups.lastAt
        ? `Last backup: ${new Date(signals.backups.lastAt).toLocaleString()}.`
        : 'No backup has been created yet.',
    );
  }
  if (items.length > 0) highlights.push(`Top priority: ${items[0].title}.`);

  const headline = `${runs.today} run${runs.today === 1 ? '' : 's'} today · $${budget.todayUsd.toFixed(2)} spent · ${items.length} suggestion${items.length === 1 ? '' : 's'}`;
  return {
    at: signals.at,
    date: new Date(signals.at).toISOString().slice(0, 10),
    version: signals.version,
    headline,
    stats: {
      runsToday: runs.today,
      runsDone: runs.done,
      runsFailed: runs.failed,
      runsRunning: runs.running,
      successRate,
      spendToday: budget.todayUsd,
      spendMonth: budget.monthUsd,
      unread: signals.inbox.unread,
      episodes: signals.training ? signals.training.episodes : null,
      backups: signals.backups ? signals.backups.count : null,
      lastBackupAt: signals.backups ? signals.backups.lastAt || null : null,
      crashes24h: signals.crashes.length,
      suggestions: items.length,
      dismissed: Object.keys(dismissed).length,
    },
    budget,
    highlights,
    top: items.slice(0, 5),
    itemsCount: items.length,
    dismissed: Object.keys(dismissed).length,
  };
}

/* ---------------------------------------------------------------- tools */

function formatBrief(data) {
  const lines = [
    `Daily brief (${data.date}) — ORVEX ${data.version}`,
    data.headline,
    '',
    ...data.highlights.map((line) => `• ${line}`),
  ];
  if (data.top.length) {
    lines.push('', 'Top suggestions:');
    for (const item of data.top) lines.push(`${item.rank}. [${item.severity}] ${item.title} — ${item.detail}`);
  } else {
    lines.push('', 'No suggestions right now.');
  }
  return lines.join('\n');
}

const definitions = [
  {
    name: 'advisor_brief',
    description:
      'Daily brief built from real state: runs started today, spend against the daily and monthly budgets, unread workforce reports, backup age, training episodes and the top ranked suggestions.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'advisor_suggestions',
    description:
      'Ranked, not-dismissed suggestions with severity and a target page. Read-only; suggestions are dismissed on the Advisor page.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'How many suggestions to return, 1-20 (default 10).' },
      },
    },
  },
];

const handlers = {
  advisor_brief: async () => {
    const data = await brief({ force: true });
    return { ok: true, output: formatBrief(data) };
  },
  advisor_suggestions: async (args = {}) => {
    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 20);
    const data = await suggestions({ force: true });
    if (!data.items.length) return { ok: true, output: 'No suggestions right now.' };
    return {
      ok: true,
      output: data.items
        .slice(0, limit)
        .map((item) => `${item.rank}. [${item.severity}] ${item.title}\n   ${item.detail}`)
        .join('\n'),
    };
  },
};

function init(options = {}) {
  ctx = {
    ...ctx,
    ...options,
    providers: { ...(ctx.providers || {}), ...(options.providers || {}) },
  };
  cache = { at: 0, value: null };
  return { version: ctx.version };
}

function invalidate() {
  cache = { at: 0, value: null };
}

module.exports = {
  init,
  invalidate,
  suggestions,
  brief,
  dismiss,
  restore,
  getBudget,
  setBudget,
  budgetStatus,
  getUpdate,
  setUpdateFeed,
  checkUpdate,
  compareVersions,
  normalizeFeed,
  isFeedUrl,
  rankSuggestions,
  buildSuggestions,
  formatBrief,
  definitions,
  handlers,
  SEVERITY,
  _internals: { startOfDay, startOfMonth, readDismissed, round4 },
};
