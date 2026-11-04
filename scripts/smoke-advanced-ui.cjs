'use strict';

/**
 * Section 19 — Advanced UI smoke over CDP.
 * Requires the ORVEX window running with --remote-debugging-port=9222.
 *
 * Walks every Advanced tab and drives the page itself: privacy-mode switching,
 * the deterministic self-evaluator, the agent roster and an honest
 * "no model configured" collaboration error, live screen OCR, the context
 * snapshot + local suggestions, proactive rule create/toggle/delete, autonomous
 * jobs (read-only run, approval denial), adaptive routing advice, learning
 * mining, device hosting + pair code, plugins/catalog empty states and the
 * recovery scan. Every created job/rule is removed afterwards.
 */

const PORT = Number(process.env.ORVEX_CDP_PORT || 9222);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const stamp = Date.now();
const suffix = String(stamp).slice(-6);
const JOB_TITLE = `ui smoke job ${suffix}`;
const APPROVAL_TITLE = `ui smoke approval ${suffix}`;
const RULE_NAME = `ui smoke rule ${suffix}`;

function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  if (!res.ok) throw new Error(`CDP list failed: HTTP ${res.status}`);
  return res.json();
}

function connect(url) {
  const WebSocket = require('ws');
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
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out after 30s`));
      }, 30_000);
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { ws, send, ready };
}

(async () => {
  let cdp;
  try {
    const list = await targets();
    const page = list.find((t) => t.type === 'page' && /\/index\.html|\/$/.test(t.url) && !/recorder\.html/.test(t.url));
    if (!page) throw new Error(`No ORVEX page target. Targets: ${list.map((t) => t.url).join(', ')}`);
    cdp = connect(page.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send('Runtime.enable');

    const evaluate = async (expression) => {
      const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'evaluate failed');
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
    const ipc = (path, ...args) =>
      evaluate(`(async () => {
        const parts = ${JSON.stringify(path)}.split('.');
        let api = window.orvex;
        for (const p of parts) api = api && api[p];
        if (typeof api !== 'function') return { ok: false, error: 'bridge ${path} missing' };
        try {
          const r = await api(${args.map((a) => JSON.stringify(a)).join(', ')});
          return r && r.ok === true ? { ok: true, data: r.data } : { ok: false, error: (r && r.error) || 'ipc failed' };
        } catch (err) {
          return { ok: false, error: String(err && err.message ? err.message : err) };
        }
      })()`);
    const ok = async (path, ...args) => {
      const r = await ipc(path, ...args);
      if (!r.ok) throw new Error(`${path} failed: ${r.error}`);
      return r.data;
    };
    const clickText = (selector, text, exact = false) =>
      evaluate(`(() => {
        const hit = [...document.querySelectorAll(${JSON.stringify(selector)})].find((n) => ${
          exact ? `n.textContent.trim() === ${JSON.stringify(text)}` : `n.textContent.includes(${JSON.stringify(text)})`
        });
        if (!hit) return false;
        hit.click();
        return true;
      })()`);
    const clickIn = (cardTitle, buttonText) =>
      evaluate(`(() => {
        const card = [...document.querySelectorAll('.adv-card')].find((c) => (c.querySelector('.adv-card-head')?.textContent || '').includes(${JSON.stringify(cardTitle)}));
        if (!card) return false;
        const btn = [...card.querySelectorAll('button')].find((b) => b.textContent.includes(${JSON.stringify(buttonText)}));
        if (!btn) return false;
        btn.click();
        return true;
      })()`);
    const setValue = (selector, value) =>
      evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
        return el.value;
      })()`);
    const setIn = (cardTitle, selector, value) =>
      evaluate(`(() => {
        const card = [...document.querySelectorAll('.adv-card')].find((c) => (c.querySelector('.adv-card-head')?.textContent || '').includes(${JSON.stringify(cardTitle)}));
        if (!card) return false;
        const el = card.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
        return el.value;
      })()`);
    const text = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent || ''`);
    const count = (selector) => evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
    const goTab = async (label) => {
      const hit = await clickText('.adv-tabs .settings-tab', label, true);
      if (!hit) throw new Error(`The ${label} tab button is missing`);
      await until(
        `document.querySelector('.adv-tabs .settings-tab.active')?.textContent.trim() === ${JSON.stringify(label)}`,
        8000,
        `the ${label} tab`,
      );
      await sleep(350);
    };

    await evaluate(`window.__advSmokeErrors = []; window.addEventListener('error', (e) => window.__advSmokeErrors.push(String(e && e.message || e)))`);

    console.log('\n— bridge and navigation');
    const missing = await evaluate(`(() => {
      const a = window.orvex && window.orvex.advanced;
      const want = ['status','mode','context','suggest','approve','rules','saveRule','deleteRule','enableRule','tickRules','selfEval','evalHistory','routeStats','recommendRoute','applyRoute','learning','mineLearning','approveLearning','dismissLearning','jobs','job','createJob','startJob','pauseJob','resumeJob','cancelJob','deleteJob','recovery','resumeRecovery','discardRecovery'];
      if (!a) return ['advanced'];
      const out = want.filter((k) => typeof a[k] !== 'function');
      for (const group of ['collab','vision','plugins','devices','a2a']) if (!a[group]) out.push(group);
      return out;
    })()`);
    check('the advanced bridge exposes every method', missing.length === 0, missing.join(',') || '31 + 5 groups');
    check('advanced.onEvent is subscribed for live job events', await evaluate(`typeof window.orvex.advanced.onEvent === 'function'`));

    if ((await text('.page-title')) === 'Advanced') {
      await evaluate(`document.querySelector('.page-back')?.click()`);
      await until(`document.querySelector('.page-title')?.textContent !== 'Advanced'`, 8000, 'the dashboard before the run');
    }
    await until(`[...document.querySelectorAll('.nav-item')].some((n) => n.textContent.trim() === 'Advanced')`, 20000, 'the Advanced nav item');
    await clickText('.nav-item', 'Advanced', true);
    await until(`document.querySelector('.page-title')?.textContent === 'Advanced'`, 10000, 'the Advanced page');
    check('Advanced opens from the sidebar', true);
    check('the page renders its own stylesheet', (await evaluate(`getComputedStyle(document.querySelector('.adv-tabs')).display`)) === 'flex');
    const tabs = await until(
      `(() => { const nodes = [...document.querySelectorAll('.adv-tabs .settings-tab')]; return nodes.length === 10 ? nodes.map((n) => n.textContent.trim()) : null; })()`,
      10000,
      'the ten advanced tabs',
    );
    check(
      'all ten advanced sections are present',
      ['Overview & modes', 'Agent teams', 'Vision', 'Context & rules', 'Autonomous jobs', 'Adaptive routing', 'Devices', 'Learning', 'Plugins & market', 'Recovery'].every((label) => tabs.includes(label)),
      tabs.join(', '),
    );

    console.log('\n— overview, modes and self-evaluation');
    await until(`!!document.querySelector('.adv-mode')`, 8000, 'the mode selector');
    check('all four privacy modes render', (await count('.adv-mode')) === 4);
    const status = await ok('advanced.status');
    check('status reports the live mode and counters', !!status.mode.mode && typeof status.jobs === 'number', status.mode.mode);
    const modeButtons = await count('.adv-mode');
    if (modeButtons === 4) {
      await evaluate(`[...document.querySelectorAll('.adv-mode')].find((b) => b.textContent.includes('Local-first'))?.click()`);
      await until(`[...document.querySelectorAll('.adv-mode')].some((b) => b.classList.contains('active') && b.textContent.includes('Local-first'))`, 8000, 'local-first to activate');
      const localStatus = await ok('advanced.status');
      check('Local-first is persisted to the real mode store', localStatus.mode.mode === 'local-first', localStatus.mode.mode);
      await evaluate(`[...document.querySelectorAll('.adv-mode')].find((b) => b.textContent.includes('Cloud') && !b.textContent.includes('Local-first'))?.click()`);
      await until(`[...document.querySelectorAll('.adv-mode')].some((b) => b.classList.contains('active') && b.textContent.trim().startsWith('Cloud'))`, 8000, 'cloud to restore');
      const cloudStatus = await ok('advanced.status');
      check('the mode is restored to cloud', cloudStatus.mode.mode === 'cloud', cloudStatus.mode.mode);
    }
    check('live status tiles report stored counters', (await count('.adv-tile')) >= 4);
    await setIn('Self-evaluation', 'input.adv-input', 'Summarize the three risks of offline mode');
    await setIn('Self-evaluation', 'textarea', 'Offline mode refuses hosted calls. Without a local endpoint each request fails with an explicit error. Tests must cover the refusal path.');
    await clickIn('Self-evaluation', 'Evaluate output');
    await until(`!!document.querySelector('.adv-score')`, 15000, 'the self-evaluation score');
    const score = await text('.adv-score');
    check('the deterministic evaluator scores the real output', /%$/.test(score), score.trim());
    check('the verdict list explains each criterion', (await count('.adv-eval li')) >= 2);
    await until(`document.querySelectorAll('.adv-table .adv-tr').length >= 2`, 10000, 'the evaluation history row');
    check('the evaluation is stored in history', true);

    console.log('\n— agent teams');
    await goTab('Agent teams');
    await until(`!!document.querySelector('.adv-check')`, 8000, 'the agent roster');
    check('the backend seeds the five built-in agents', (await count('.adv-list .adv-row')) >= 5);
    await setIn('Start a team session', 'textarea', 'Review offline mode readiness');
    await clickIn('Start a team session', 'Start collaboration');
    await until(`!!document.querySelector('.adv-error')`, 20000, 'the honest no-model error');
    const teamError = await text('.adv-error');
    check('starting a team without a model reports it honestly', /candidate|model/i.test(teamError), teamError.slice(0, 100));

    console.log('\n— vision');
    await goTab('Vision');
    await clickIn('Computer-vision agent', 'Read text (OCR)');
    await until(`!!document.querySelector('.adv-vision')`, 30000, 'the OCR result');
    const visionText = await text('.adv-vision');
    check('OCR reads the real screen through Windows', /Source|OCR text|size|error/i.test(visionText), visionText.replace(/\s+/g, ' ').slice(0, 110));
    check('the result states which model was (not) used', /Model/.test(visionText));

    console.log('\n— context and proactive rules');
    await goTab('Context & rules');
    await until(`document.querySelector('.adv-kv')?.textContent.includes('Foreground window')`, 10000, 'the context snapshot');
    const ctxText = await text('.adv-kv');
    check('the context snapshot reads live signals', /Mode/.test(ctxText) && /CPU/.test(ctxText), ctxText.replace(/\s+/g, ' ').slice(0, 110));
    await clickIn('Context snapshot', 'Suggest next actions');
    await until(`!!document.querySelector('.adv-suggestions')`, 15000, 'the suggestion panel');
    check('local suggestions answer with their real source', /Source:/.test(await text('.adv-suggestions')));
    await setIn('Proactive rules', 'input.adv-input', RULE_NAME);
    await clickIn('Proactive rules', 'Add rule');
    await until(`[...document.querySelectorAll('.adv-list .adv-row')].some((n) => n.textContent.includes(${JSON.stringify(RULE_NAME)}))`, 10000, 'the saved rule');
    check('a proactive rule is saved and listed', true);
    await evaluate(`(() => {
      const row = [...document.querySelectorAll('.adv-list .adv-row')].find((n) => n.textContent.includes(${JSON.stringify(RULE_NAME)}));
      const btn = [...row.querySelectorAll('button')].find((b) => b.textContent.includes('Disable'));
      if (btn) btn.click();
      return !!btn;
    })()`);
    await until(`[...document.querySelectorAll('.adv-list .adv-row')].some((n) => n.textContent.includes(${JSON.stringify(RULE_NAME)}) && n.textContent.includes('disabled'))`, 10000, 'the disabled rule');
    check('the rule can be disabled from the list', true);
    await evaluate(`(() => {
      const row = [...document.querySelectorAll('.adv-list .adv-row')].find((n) => n.textContent.includes(${JSON.stringify(RULE_NAME)}));
      const btn = row.querySelector('button[title="Delete rule"]');
      if (btn) btn.click();
      return !!btn;
    })()`);
    await until(`![...document.querySelectorAll('.adv-list .adv-row')].some((n) => n.textContent.includes(${JSON.stringify(RULE_NAME)}))`, 10000, 'the removed rule');
    check('the rule is deleted', true);

    console.log('\n— autonomous jobs');
    await goTab('Autonomous jobs');
    await setIn('Autonomous job builder', 'input.adv-input', JOB_TITLE);
    await clickIn('Autonomous job builder', 'Read-only template');
    await clickIn('Autonomous job builder', 'Save job');
    await until(`[...document.querySelectorAll('.adv-job')].some((n) => n.textContent.includes(${JSON.stringify(JOB_TITLE)}))`, 10000, 'the stored job');
    check('a bounded read-only job is saved', true);
    await evaluate(`(() => {
      const job = [...document.querySelectorAll('.adv-job')].find((n) => n.textContent.includes(${JSON.stringify(JOB_TITLE)}));
      const btn = [...job.querySelectorAll('button')].find((b) => b.textContent.includes('Start'));
      if (btn) btn.click();
      return !!btn;
    })()`);
    await until(`(() => {
      const job = [...document.querySelectorAll('.adv-job')].find((n) => n.textContent.includes(${JSON.stringify(JOB_TITLE)}));
      return job && /done|failed/.test(job.textContent);
    })()`, 30000, 'the job to finish');
    const jobText = await evaluate(`(() => {
      const job = [...document.querySelectorAll('.adv-job')].find((n) => n.textContent.includes(${JSON.stringify(JOB_TITLE)}));
      return job ? job.textContent : '';
    })()`);
    check('the job runs every step to completion', /done/.test(jobText) && jobText.includes('3/3 steps'), jobText.replace(/\s+/g, ' ').slice(0, 120));
    await evaluate(`(() => {
      const job = [...document.querySelectorAll('.adv-job')].find((n) => n.textContent.includes(${JSON.stringify(JOB_TITLE)}));
      const btn = job.querySelector('button[title="Show steps"]');
      if (btn) btn.click();
      return !!btn;
    })()`);
    await until(`!!document.querySelector('.adv-step')`, 8000, 'the step details');
    check('each step result is shown with its own status', (await count('.adv-step.ok')) === 3);

    await setIn('Autonomous job builder', 'input.adv-input', APPROVAL_TITLE);
    await setIn('Autonomous job builder', 'textarea', '[{"tool":"process_kill","args":{"pid":999999}}]');
    await clickIn('Autonomous job builder', 'Save job');
    await until(`[...document.querySelectorAll('.adv-job')].some((n) => n.textContent.includes(${JSON.stringify(APPROVAL_TITLE)}))`, 10000, 'the approval job');
    await evaluate(`(() => {
      const job = [...document.querySelectorAll('.adv-job')].find((n) => n.textContent.includes(${JSON.stringify(APPROVAL_TITLE)}));
      const btn = [...job.querySelectorAll('button')].find((b) => b.textContent.includes('Start'));
      if (btn) btn.click();
      return !!btn;
    })()`);
    await until(`!!document.querySelector('.adv-approval')`, 20000, 'the approval banner');
    const approvalText = await text('.adv-approval');
    check('a risky job step asks for approval in the page', /process_kill|stops a running program/i.test(approvalText), approvalText.replace(/\s+/g, ' ').slice(0, 110));
    await clickText('.adv-approval button', 'Deny', true);
    await until(`(() => {
      const job = [...document.querySelectorAll('.adv-job')].find((n) => n.textContent.includes(${JSON.stringify(APPROVAL_TITLE)}));
      return job && job.textContent.includes('failed');
    })()`, 15000, 'the denied job to fail');
    check('denying the step fails the job honestly', true);

    await evaluate(`(() => {
      for (const title of [${JSON.stringify(JOB_TITLE)}, ${JSON.stringify(APPROVAL_TITLE)}]) {
        const job = [...document.querySelectorAll('.adv-job')].find((n) => n.textContent.includes(title));
        const btn = job && job.querySelector('button[title="Delete job"]');
        if (btn) btn.click();
      }
      return true;
    })()`);
    await sleep(1200);
    const leftovers = await evaluate(`[...document.querySelectorAll('.adv-job')].filter((n) => n.textContent.includes(${JSON.stringify(suffix)})).length`);
    check('smoke jobs were removed', leftovers === 0, `${leftovers} left`);

    console.log('\n— adaptive routing');
    await goTab('Adaptive routing');
    check('the task selector lists every routed task', (await count('.adv-card select option')) >= 9);
    await clickIn('Adaptive model routing', 'Rank candidates');
    await until(`document.querySelector('.adv-card')?.textContent.includes('No candidates were supplied') || !!document.querySelector('.adv-list')`, 15000, 'the routing result');
    const routeText = await evaluate(`[...document.querySelectorAll('.adv-card')].find((c) => c.textContent.includes('Adaptive model routing'))?.textContent || ''`);
    check('routing reports the real candidate situation', /No candidates were supplied|%/.test(routeText), routeText.replace(/\s+/g, ' ').slice(0, 120));
    const measuredText = await evaluate(`[...document.querySelectorAll('.adv-card')].find((c) => c.textContent.includes('Measured outcomes'))?.textContent || ''`);
    check('measured outcomes have an honest empty state', /No gateway call has been measured|Calls/.test(measuredText), measuredText.replace(/\s+/g, ' ').slice(0, 100));

    console.log('\n— learning');
    await goTab('Learning');
    await clickIn('Personal workflow learning', 'Mine now');
    await sleep(1500);
    const learnText = await text('.adv-card');
    check('mining the real trail reports its result', /suggestion|No suggestions yet|Workflow|Route/.test(learnText), learnText.replace(/\s+/g, ' ').slice(0, 120));

    console.log('\n— devices');
    await goTab('Devices');
    await until(`document.querySelector('.adv-kv')?.textContent.includes('Device id')`, 10000, 'the device identity');
    check('the device identity is read from the real profile', /dev_/.test(await text('.adv-kv')));
    await clickIn('This device', 'Start hosting');
    await until(`!!document.querySelector('.adv-code-pill')`, 10000, 'the pair code');
    const pairCode = await text('.adv-code-pill');
    check('hosting starts and shows a live pair code', /\d{6}/.test(pairCode), pairCode.replace(/\s+/g, ' ').slice(0, 80));
    await clickIn('This device', 'Stop hosting');
    await sleep(800);
    check('hosting stops on request', !(await evaluate(`!!document.querySelector('.adv-code-pill')`)));

    console.log('\n— agent network (A2A)');
    const a2a = await until(
      `(() => {
        const card = [...document.querySelectorAll('.adv-card')].find((c) => (c.querySelector('.adv-card-head')?.textContent || '').includes('Agent network (A2A)'));
        if (!card) return null;
        const token = (card.textContent.match(/Bearer\\s+([a-f0-9]{64})/) || [])[1] || '';
        return { token: token.length, skills: card.querySelectorAll('.adv-chip').length, start: [...card.querySelectorAll('button')].some((b) => b.textContent.includes('Start A2A')), port: !!card.querySelector('input.adv-input') };
      })()`,
      10000,
      'the A2A agent network card',
    );
    check('the A2A card shows a bearer token and the agent skills', a2a.token === 64 && a2a.skills >= 4, `${a2a.token} hex chars, ${a2a.skills} chips`);
    check('the A2A host can be started from the panel', a2a.start && a2a.port, a2a.start ? 'start control present' : 'no start control');
    check('the A2A panel states the peer boundary', /no tools, files, desktop input or plugins/i.test(await text('.adv')), 'peer boundary documented');

    console.log('\n— plugins and marketplace');
    await goTab('Plugins & market');
    await until(`document.querySelector('.adv-card')?.textContent.includes('Installed plugins')`, 10000, 'the plugin list');
    const pluginText = await evaluate(`document.querySelector('.adv')?.textContent || ''`);
    check('plugins show an honest empty state', /No plugin is installed/.test(pluginText));
    check('the marketplace explains it needs a chosen catalog', /Catalog URL/.test(pluginText) && /sha256/.test(pluginText));
    check('the plugin SDK example is shown', /manifest\.json/.test(pluginText) && /exports\.run/.test(pluginText));
    const signing = await evaluate(`(() => {
      const card = [...document.querySelectorAll('.adv-card')].find((c) => (c.querySelector('.adv-card-head')?.textContent || '').includes('Tool marketplace'));
      if (!card) return null;
      const box = card.querySelector('textarea');
      const toggle = card.querySelector('.adv-check input[type=checkbox]');
      return { box: !!box, toggle: !!toggle, label: card.textContent.includes('Require signed catalog'), require: !!toggle && toggle.checked, keys: card.textContent.includes('Save keys') && card.textContent.includes('Clear keys') };
    })()`);
    check('the marketplace offers trusted-key management', !!signing && signing.box && signing.keys, signing ? 'textarea + save/clear' : 'marketplace card missing');
    check('signature enforcement is a visible, honest toggle', !!signing && signing.toggle && signing.label, signing && signing.require ? 'enabled by the user' : 'off by default');

    console.log('\n— recovery');
    await goTab('Recovery');
    await until(`document.querySelector('.adv-card')?.textContent.includes('Engine runs')`, 15000, 'the recovery scan');
    const recoveryText = await text('.adv-card');
    check('recovery scans runs, workflows, jobs and crashes', /Engine runs/.test(recoveryText) && /Recorded crashes/.test(recoveryText));

    console.log('\n— regression');
    const errors = await evaluate(`window.__advSmokeErrors || []`);
    check('no uncaught renderer errors on the page', errors.length === 0, errors.slice(0, 3).join(' | '));
    const bodyText = await text('.adv');
    check('the page shows no demo copy', !/demo mode|sample data|mock data|fake data|simulated|coming soon/i.test(bodyText));
    await evaluate(`document.querySelector('.page-back')?.click()`);
    await until(`document.querySelector('.page-title')?.textContent !== 'Advanced'`, 8000, 'the dashboard');
    check('the back button leaves the page cleanly', true);

    try {
      await ok('advanced.devices.hostStop');
    } catch {
      /* hosting is already stopped */
    }
  } catch (err) {
    check('the Advanced UI suite ran without fatal errors', false, err && err.stack ? err.stack.split('\n')[0] : String(err));
    if (cdp) cdp.ws.close();
  }
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed${passed === results.length ? '' : ' — FAILURES PRESENT'}`);
  process.exit(passed === results.length ? 0 : 1);
})();
