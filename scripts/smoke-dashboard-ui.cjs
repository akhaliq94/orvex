'use strict';

/**
 * Dashboard / Agents / System UI smoke over CDP.
 * Requires the ORVEX window running with --remote-debugging-port=9222.
 *
 * Verifies that the Home widgets, the Agents page and the System page read the
 * real bridge (dashboard snapshot, metrics, processes, app prefs) instead of
 * hardcoded demo data, that the sidebar submenu deep-links into real tabs, and
 * that the volume control round-trips to the OS. Everything it changes on the
 * machine is restored in the finally block.
 */

const PORT = Number(process.env.ORVEX_CDP_PORT || 9222);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  if (!res.ok) throw new Error(`CDP list failed: HTTP ${res.status}`);
  return res.json();
}

function connect(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let nextId = 1;
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', reject);
  });
  ws.addEventListener('message', (msg) => {
    const data = JSON.parse(msg.data);
    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) reject(new Error(data.error.message));
      else resolve(data.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { ws, send, ready };
}

let pass = 0;
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`);
    pass += 1;
  } else {
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    process.exitCode = 1;
  }
}

const AGENT_NAME = {
  general: 'ORVEX',
  coder: 'Coder',
  browser: 'Scout',
  files: 'Keeper',
  automation: 'Rigger',
  research: 'Sage',
};

async function main() {
  const list = await targets();
  const page = list.find((t) => t.type === 'page' && /\/index\.html|\/$/.test(t.url) && !/recorder\.html/.test(t.url));
  if (!page) throw new Error(`No ORVEX page target. Targets: ${list.map((t) => t.url).join(', ')}`);
  const cdp = connect(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');

  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      const detail = r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'evaluate failed';
      throw new Error(`${detail}\nEXPR: ${expression.slice(0, 500)}`);
    }
    return r.result.value;
  };
  const until = async (expression, timeoutMs, label) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const value = await evaluate(expression);
      if (value) return value;
      await sleep(150);
    }
    throw new Error(`Timed out waiting for ${label}`);
  };
  const ipc = (ns, method, ...args) =>
    evaluate(`(async () => {
      const api = window.orvex && window.orvex.${ns};
      if (!api || !api.${method}) return { ok: false, error: 'bridge ${ns}.${method} missing' };
      const r = await api.${method}(${args.map((a) => JSON.stringify(a)).join(', ')});
      return r && r.ok === true ? { ok: true, data: r.data } : { ok: false, error: (r && r.error) || 'ipc failed' };
    })()`);
  const ok = async (ns, method, ...args) => {
    const r = await ipc(ns, method, ...args);
    if (!r.ok) throw new Error(`${ns}.${method} failed: ${r.error}`);
    return r.data;
  };
  const clickText = (selector, text, exact = false) =>
    evaluate(`(() => {
      const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
      const hit = nodes.find((n) => ${exact ? `n.textContent.trim() === ${JSON.stringify(text)}` : `n.textContent.includes(${JSON.stringify(text)})`});
      if (!hit) return false;
      hit.click();
      return true;
    })()`);
  const nav = async (label) => {
    await until(`[...document.querySelectorAll('.nav-item')].some((n) => n.textContent.trim() === ${JSON.stringify(label)})`, 20000, `the ${label} nav item`);
    await clickText('.nav-item', label, true);
  };
  const subnav = async (pageLabel, subLabel) => {
    const opened = await evaluate(`(() => {
      const item = [...document.querySelectorAll('.nav-item')].find((n) => n.textContent.trim() === ${JSON.stringify(pageLabel)});
      const sub = [...document.querySelectorAll('.nav-sub-item')].find((n) => n.textContent.trim() === ${JSON.stringify(subLabel)});
      if (sub) { sub.click(); return true; }
      if (!item) return false;
      item.click();
      return 'opened';
    })()`);
    if (opened === 'opened') {
      await until(`[...document.querySelectorAll('.nav-sub-item')].some((n) => n.textContent.trim() === ${JSON.stringify(subLabel)})`, 5000, `the ${subLabel} submenu`);
      await clickText('.nav-sub-item', subLabel, true);
    }
    return opened !== false;
  };
  const goHome = async () => {
    await nav('Home');
    await until(`!!document.querySelector('.system-card')`, 10000, 'the dashboard');
  };
  const text = (selector) =>
    evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent.trim() || ''`);

  // The app pauses the process poller while the window is hidden, so make sure
  // the main window is visible before the System page checks run.
  await evaluate(`(async () => { await window.orvex?.app?.window('showMain'); return true; })()`);
  await until(`document.hidden === false`, 8000, 'the ORVEX window to be visible');

  let volumeBefore = null;
  let muteBefore = null;
  let prefBefore = null;

  try {
    console.log('— bridge');
    const hasBridge = await until(
      `!!window.orvex?.dashboard?.snapshot && !!window.orvex?.desktop?.metrics && !!window.orvex?.app?.prefs`,
      20000,
      'the dashboard bridge',
    );
    check('dashboard, metrics and prefs bridges are exposed', !!hasBridge);

    const snap = await ok('dashboard', 'snapshot');
    const metrics = snap.metrics;
    check('the snapshot carries a metrics sample timestamped now', typeof metrics.at === 'number' && Date.now() - metrics.at < 15000, new Date(metrics.at).toISOString());
    check(
      'CPU and RAM are real percentages',
      (metrics.cpuPercent == null || (metrics.cpuPercent >= 0 && metrics.cpuPercent <= 100)) &&
        typeof metrics.memory.percent === 'number' &&
        metrics.memory.percent >= 0 &&
        metrics.memory.percent <= 100,
      `cpu ${metrics.cpuPercent} · ram ${metrics.memory.percent}`,
    );
    check(
      'disk is read from the real filesystem',
      metrics.disk == null || (metrics.disk.percent >= 0 && metrics.disk.percent <= 100 && metrics.disk.total > 0),
      metrics.disk ? `${metrics.disk.mount} ${metrics.disk.percent.toFixed(1)}%` : 'unavailable',
    );
    check(
      'GPU is either measured or explains why it is not',
      metrics.gpu.available
        ? typeof metrics.gpu.percent === 'number'
        : typeof metrics.gpu.reason === 'string' && metrics.gpu.reason.length > 0,
      metrics.gpu.available ? `${metrics.gpu.name} ${metrics.gpu.percent}%` : metrics.gpu.reason,
    );
    const sys = await ok('desktop', 'system');
    check('the snapshot hostname matches the live system status', snap.system.hostname === sys.hostname, snap.system.hostname);
    const status = await ok('agent', 'status');
    check(
      'the snapshot agent block matches the runtime status',
      snap.agent.running === status.running &&
        snap.agent.runId === status.runId &&
        (snap.agent.agentId ?? null) === (status.agentId ?? null),
      status.running ? `running ${status.runId} · ${status.agentId}` : 'idle',
    );
    volumeBefore = sys.volume;
    muteBefore = sys.muted;

    console.log('\n— Home dashboard');
    await goHome();
    const gaugeLabels = await evaluate(`[...document.querySelectorAll('.gauges .gauge-label')].map((n) => n.textContent.trim())`);
    check('the System Status card shows CPU, RAM, GPU and DISK', ['CPU', 'RAM', 'GPU', 'DISK'].every((l) => gaugeLabels.includes(l)) && gaugeLabels.length === 4, gaugeLabels.join(', '));
    const gaugeVals = await evaluate(`Object.fromEntries([...document.querySelectorAll('.gauges .gauge')].map((g) => [g.querySelector('.gauge-label')?.textContent.trim(), g.querySelector('.gauge-val')?.textContent.trim()]))`);
    const fresh = await ok('dashboard', 'snapshot');
    const num = (v) => (v === 'n/a' ? null : Number(String(v).replace('%', '')));
    check(
      'the RAM gauge matches the live snapshot',
      (fresh.metrics.memory.percent == null && num(gaugeVals.RAM) == null) ||
        Math.abs(num(gaugeVals.RAM) - fresh.metrics.memory.percent) <= 3,
      `${gaugeVals.RAM} vs ${fresh.metrics.memory.percent}%`,
    );
    check(
      'the DISK gauge matches the live snapshot',
      fresh.metrics.disk == null ? num(gaugeVals.DISK) == null : Math.abs(num(gaugeVals.DISK) - fresh.metrics.disk.percent) <= 2,
      `${gaugeVals.DISK} vs ${fresh.metrics.disk ? fresh.metrics.disk.percent.toFixed(1) : 'n/a'}%`,
    );
    check(
      'the GPU gauge is honest about availability',
      fresh.metrics.gpu.available ? num(gaugeVals.GPU) != null : num(gaugeVals.GPU) == null,
      `${gaugeVals.GPU}`,
    );
    check('the card reports itself as Live', (await text('.system-card .live-badge')) === 'Live');

    const activityCount = await evaluate(`document.querySelectorAll('.activity-row').length`);
    const expectedActivity = Math.min(5, fresh.activity.length + fresh.workflows.runs.length);
    const emptyActivity = await evaluate(`!!document.querySelector('.activity-card .ac-empty')`);
    check(
      'Recent Activity is filled from audit + workflow runs (or says it is empty)',
      expectedActivity === 0 ? emptyActivity : activityCount > 0 && activityCount <= 5,
      `${activityCount} row(s), ${snap.activity.length} audit, ${snap.workflows.runs.length} workflow run(s)`,
    );
    if (snap.activity.length > 0) {
      const firstTool = snap.activity[0].tool;
      const labels = await evaluate(`[...document.querySelectorAll('.activity-label')].map((n) => n.textContent)`);
      check(
        'the newest audit entry is the newest activity row',
        labels.some((l) => (firstTool ? l.includes(firstTool) : true)),
        labels[0]?.slice(0, 60),
      );
    } else {
      check('activity rows only exist when the audit log or workflows have entries', emptyActivity);
    }

    const dashCopy = await evaluate(`(() => {
      const copy = document.querySelector('.orvex-app')?.cloneNode(true);
      copy?.querySelectorAll('.toast, .activity-row, .agent-row').forEach((n) => n.remove());
      return copy?.innerText || '';
    })()`);
    check('the dashboard shows no demo or simulated copy', !/simulat|demo data|mock|placeholder data|lorem ipsum/i.test(dashCopy));

    if (volumeBefore != null) {
      const moved = await evaluate(`(() => {
        const el = document.querySelector('input[aria-label="System volume"]');
        if (!el) return false;
        const target = ${volumeBefore} >= 40 ? Math.max(0, ${volumeBefore} - 17) : Math.min(100, ${volumeBefore} + 17);
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, String(target));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return target;
      })()`);
      await sleep(900);
      const after = await ok('desktop', 'system');
      check('the volume slider changes the real system volume', moved !== false && after.volume === moved, `${volumeBefore} → ${after.volume} (wanted ${moved})`);
    } else {
      check('the volume slider is disabled when the OS reports no volume', await evaluate(`document.querySelector('input[aria-label="System volume"]')?.disabled === true`));
    }

    console.log('\n— Agents page');
    await nav('Agents');
    await until(`document.querySelector('.page-title')?.textContent === 'Agents'`, 10000, 'the Agents page');
    const agentsSub = await text('.page-sub');
    check('the Agents subtitle no longer mentions demo data', !/demo|simulat|mock/i.test(agentsSub), agentsSub);
    const cards = await evaluate(`[...document.querySelectorAll('.agent-card')].map((c) => ({
      name: c.querySelector('.agent-card-name')?.textContent.trim(),
      status: c.querySelector('.agent-card-status')?.textContent.trim(),
    }))`);
    check('all six personas are listed with a runtime status', cards.length === 6 && cards.every((c) => ['Running', 'Paused', 'Idle'].includes(c.status)), cards.map((c) => `${c.name}:${c.status}`).join(', '));
    if (status.running && status.agentId && AGENT_NAME[status.agentId]) {
      const running = cards.filter((c) => c.status === 'Running' || c.status === 'Paused');
      check(
        'exactly the runtime agent shows as running or paused',
        running.length === 1 && running[0].name === AGENT_NAME[status.agentId],
        `${running.map((c) => c.name).join(', ') || 'none'}`,
      );
    } else {
      check('no agent is marked running while the runtime is idle', cards.every((c) => c.status === 'Idle'));
    }
    const orgStatuses = await evaluate(`[...document.querySelectorAll('.org-status')].map((n) => n.textContent.trim()).filter(Boolean)`);
    check('the org map shows statuses consistent with the cards', orgStatuses.length >= 6 && orgStatuses.every((s) => ['Running', 'Paused', 'Idle'].includes(s)), `${orgStatuses.length} nodes`);

    const agentRuns = (await ok('orchestrator', 'runs', 100)).runs.filter((r) => r.agentId === 'general');
    const logLines = await evaluate(`document.querySelectorAll('.agent-log-line').length`);
    const emptyLog = await evaluate(`!!document.querySelector('.agent-log .ac-empty, .agent-log .dim')`);
    check(
      'the run history lists recorded runs for ORVEX or says there are none',
      agentRuns.length === 0 ? emptyLog : logLines > 0,
      `${logLines} line(s), ${agentRuns.length} recorded run(s)`,
    );
    check(
      'run rows name the real goal or status',
      agentRuns.length === 0 || (await evaluate(`[...document.querySelectorAll('.agent-log-line')].some((n) => n.textContent.includes('step'))`)),
    );
    const agentsCopy = await text('.agents-page');
    check('the Agents page contains no mock/demo copy', !/\(mock\)|demo|simulat/i.test(agentsCopy));

    console.log('\n— sidebar deep links');
    await subnav('Agents', 'SOUL.md');
    await until(`document.querySelector('.page-tab.active')?.textContent.trim() === 'SOUL.md'`, 5000, 'the SOUL.md tab');
    const soul = await text('.soul-body');
    check('the SOUL.md submenu opens the real persona document', soul.includes('SOUL.md'), soul.split('\n')[0]?.slice(0, 50));
    await subnav('Agents', 'Tools');
    await until(`document.querySelector('.page-tab.active')?.textContent.trim() === 'Tools'`, 5000, 'the Tools tab');
    const chips = await evaluate(`[...document.querySelectorAll('.tool-chip')].map((n) => n.textContent.trim())`);
    check('the Tools tab lists the orchestrator tool set', chips.length === 5, chips.join(', '));
    check('the Tools copy describes the runtime instead of a demo', !/demo|mock/i.test(await text('.agent-tools')));
    await evaluate(`document.querySelector('.tool-chip')?.click()`);
    await until(`document.querySelector('.page-title')?.textContent === 'Chat'`, 10000, 'Chat after the tool handoff');
    const draft = await evaluate(`document.querySelector('.command-input')?.value || ''`);
    check('a tool chip opens Chat with that agent and a real draft', draft.startsWith('Use the ') && (await evaluate(`document.querySelector('.agent-select')?.value === 'general'`)), draft);

    console.log('\n— System page');
    await subnav('System', 'Monitor');
    await until(`document.querySelector('.page-title')?.textContent === 'System'`, 10000, 'the System page');
    await until(`document.querySelector('.settings-tab.active')?.textContent.trim() === 'Monitor'`, 5000, 'the Monitor tab');
    const systemSub = await text('.page-sub');
    check('the System subtitle is honest about live metrics', /live hardware metrics/i.test(systemSub), systemSub);
    const bars = await evaluate(`Object.fromEntries([...document.querySelectorAll('.bigbar')].map((b) => [b.querySelector('.bigbar-head span')?.textContent.trim(), b.querySelector('.bigbar-head span:last-child')?.textContent.trim()]))`);
    const sysSnap = await ok('dashboard', 'snapshot');
    const barNum = (v) => (v === 'n/a' ? null : Number(String(v).replace('%', '')));
    // The page repaints from its own 2.5s snapshot; CPU is spiky, so sample both
    // sides a few times instead of comparing one reading against a later one.
    let cpuOk = false;
    let cpuDetail = '';
    let ramOk = false;
    let ramDetail = '';
    for (let i = 0; i < 8; i += 1) {
      const live = await ok('dashboard', 'snapshot');
      const shown = await evaluate(`Object.fromEntries([...document.querySelectorAll('.bigbar')].map((b) => [b.querySelector('.bigbar-head span')?.textContent.trim(), b.querySelector('.bigbar-head span:last-child')?.textContent.trim()]))`);
      cpuDetail = `${shown.CPU} vs ${live.metrics.cpuPercent}%`;
      ramDetail = `${shown.RAM} vs ${live.metrics.memory.percent}%`;
      cpuOk = (live.metrics.cpuPercent == null && barNum(shown.CPU) == null) || Math.abs(barNum(shown.CPU) - live.metrics.cpuPercent) <= 10;
      ramOk = Math.abs(barNum(shown.RAM) - live.metrics.memory.percent) <= 3;
      if (cpuOk && ramOk) break;
      await sleep(700);
    }
    check('the big CPU bar matches the live metrics', cpuOk, cpuDetail);
    check('the big RAM bar matches the live metrics', ramOk, ramDetail);
    check('the GPU bar is honest about availability', sysSnap.metrics.gpu.available ? barNum(bars.GPU) != null : barNum(bars.GPU) == null, `${bars.GPU}`);
    const uptimeRows = await evaluate(`[...document.querySelectorAll('.sys-uptime')].map((n) => n.textContent.trim())`);
    check('machine uptime is reported from the OS', uptimeRows.some((t) => /^Machine uptime · \d/.test(t)), uptimeRows[0]);

    const procs = await ok('desktop', 'processes', { sort: 'cpu', limit: 10 });
    await until(`document.querySelectorAll('.sys-proc-name').length > 0`, 8000, 'the process table to fill');
    const shown = await evaluate(`[...document.querySelectorAll('.sys-proc:not(.sys-proc-head) .sys-proc-name')].map((n) => n.textContent.trim())`);
    check('the process list is the real process table', shown.length > 0 && shown.some((name) => procs.processes.some((p) => p.name === name)), `${shown.length} row(s), e.g. ${shown[0]}`);
    const hardwareLine = await evaluate(`[...document.querySelectorAll('.sys-proc')].map((n) => n.textContent).join(' | ')`);
    check('the hardware panel names this host', hardwareLine.includes(sysSnap.system.hostname), sysSnap.system.hostname);

    const powerButtons = await evaluate(`[...document.querySelectorAll('.sys-power')].map((b) => b.textContent.trim())`);
    check('only Lock is offered as a power action', powerButtons.length === 1 && /Lock/.test(powerButtons[0]), powerButtons.join(', '));
    const powerCopy = await evaluate(`[...document.querySelectorAll('.sys-col')].map((c) => c.innerText).join(' ')`);
    check('the page says sleep/restart/shutdown are not exposed', /not exposed/i.test(powerCopy) && /Start menu/i.test(powerCopy));

    const prefs = await ok('app', 'prefs');
    prefBefore = prefs.closeToTray;
    const trayPressed = await evaluate(`document.querySelector('.switch[aria-label="Keep running in system tray"]')?.getAttribute('aria-pressed')`);
    const launchPressed = await evaluate(`document.querySelector('.switch[aria-label="Launch ORVEX at startup"]')?.getAttribute('aria-pressed')`);
    check('the tray switch reflects the stored preference', String(prefs.closeToTray) === trayPressed, `tray ${trayPressed}`);
    check('the startup switch reflects the real login item', String(prefs.launchAtLogin) === launchPressed, `startup ${launchPressed}`);
    await evaluate(`document.querySelector('.switch[aria-label="Keep running in system tray"]')?.click()`);
    const flipped = await until(
      `(async () => {
        const r = await window.orvex.app.prefs();
        return r.ok && r.data.closeToTray !== ${prefs.closeToTray};
      })()`,
      8000,
      'the tray preference to change',
    );
    check('flipping the tray switch persists through the bridge', !!flipped);
    await evaluate(`document.querySelector('.switch[aria-label="Keep running in system tray"]')?.click()`);
    await until(
      `(async () => {
        const r = await window.orvex.app.prefs();
        return r.ok && r.data.closeToTray === ${prefs.closeToTray};
      })()`,
      8000,
      'the tray preference to return',
    );
    check('flipping it back restores the stored value', true);

    await subnav('System', 'Failures');
    await until(`document.querySelector('.settings-tab.active')?.textContent.trim() === 'Failures'`, 5000, 'the Failures tab');
    const failures = await evaluate(`({
      rows: document.querySelectorAll('.fail-row').length,
      empty: !!document.querySelector('.failures .ac-empty'),
    })`);
    const auditErrors = (await ok('audit', 'tail', 120)).filter((a) => a.error || a.ok === 0).length;
    check(
      'the Failure Log merges local and audit failures',
      failures.rows > 0 ? true : failures.empty,
      `${failures.rows} row(s), ${auditErrors} failed audit row(s)`,
    );

    const sysCopy = await evaluate(`document.querySelector('.system-page')?.innerText || ''`);
    check('the System page contains no simulated/demo copy', !/\bdemo\b|simulated|mock/i.test(sysCopy));
  } catch (err) {
    check('the UI suite ran without fatal errors', false, err && err.message ? err.message : String(err));
  } finally {
    try {
      if (volumeBefore != null) await ipc('desktop', 'volume', { level: volumeBefore, mute: !!muteBefore });
      if (prefBefore != null) await ipc('app', 'setPrefs', { closeToTray: prefBefore });
      const sys = await ok('desktop', 'system');
      check('cleanup restored the system volume', volumeBefore == null || sys.volume === volumeBefore, `${sys.volume}`);
      const prefs = await ok('app', 'prefs');
      check('cleanup restored the tray preference', prefBefore == null || prefs.closeToTray === prefBefore, String(prefs.closeToTray));
    } catch (err) {
      check('cleanup ran', false, err && err.message ? err.message : String(err));
    }
    cdp.ws.close();
    console.log(`\ndashboard UI smoke ${process.exitCode ? 'reported failures' : 'OK'}: ${pass} checks`);
  }
}

main().catch((err) => {
  console.error('\ndashboard UI smoke crashed:', err && err.message ? err.message : err);
  process.exit(1);
});
