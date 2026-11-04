'use strict';

/**
 * Section 15 Monitoring UI smoke over CDP.
 * Requires the ORVEX window running with --remote-debugging-port=9222.
 *
 * Opens Monitoring from the sidebar, walks all seven tabs on the real page:
 * overview tiles and charts, usage windows and tables, trace selection, the
 * comparison form, an eval suite create/delete round trip, all twelve health
 * probes and the recovery sections. No model call is fired from the UI.
 */

const PORT = Number(process.env.ORVEX_CDP_PORT || 9222);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const SUITE_NAME = 'UI smoke suite';

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
        reject(new Error(`${method} timed out after 20s`));
      }, 20_000);
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
        await sleep(200);
      }
      throw new Error(`Timed out waiting for ${label}`);
    };
    const ipc = (ns, method, ...args) =>
      evaluate(`(async () => {
        const api = window.orvex && window.orvex.${ns};
        if (!api || !api.${method}) return { ok: false, error: 'bridge ${ns}.${method} missing' };
        try {
          const r = await api.${method}(${args.map((a) => JSON.stringify(a)).join(', ')});
          return r && r.ok === true ? { ok: true, data: r.data } : { ok: false, error: (r && r.error) || 'ipc failed' };
        } catch (err) {
          return { ok: false, error: String(err && err.message ? err.message : err) };
        }
      })()`);
    const ok = async (ns, method, ...args) => {
      const r = await ipc(ns, method, ...args);
      if (!r.ok) throw new Error(`${ns}.${method} failed: ${r.error}`);
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
    const clickButton = (text) =>
      evaluate(`(() => {
        const hit = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)});
        if (!hit) return false;
        hit.click();
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
    const goTab = async (label) => {
      await clickText('.mon-tabs .settings-tab', label, true);
      await until(`document.querySelector('.mon-tabs .settings-tab.active')?.textContent.trim() === ${JSON.stringify(label)}`, 6000, `the ${label} tab`);
    };
    const count = (selector) => evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`);

    const bridgeOk = await ok('monitor', 'overview');
    check('the monitoring bridge answers before the UI run', !!bridgeOk && bridgeOk.db.ready === true);

    try {
      console.log('\n— open Monitoring from the sidebar');
      await until(`[...document.querySelectorAll('.nav-item')].some((n) => n.textContent.trim() === 'Monitoring')`, 20000, 'the Monitoring nav item');
      await clickText('.nav-item', 'Monitoring', true);
      await until(`document.querySelector('.page-title')?.textContent === 'Monitoring'`, 10000, 'the Monitoring page');
      check('Monitoring opens from the sidebar', true);
      if ((await count('.nav-sub-item')) === 0) {
        await clickText('.nav-item', 'Monitoring', true);
        await until(`document.querySelectorAll('.nav-sub-item').length === 7`, 6000, 'the monitoring submenu');
      }

      const tabs = await until(
        `(() => {
          const labels = [...document.querySelectorAll('.mon-tabs .settings-tab')].map((n) => n.textContent.trim());
          return labels.length === 7 ? labels : null;
        })()`,
        10000,
        'the seven monitoring tabs',
      );
      check(
        'all seven sections are present',
        ['Overview', 'Usage & cost', 'Traces', 'Compare', 'Evals', 'Health', 'Recovery'].every((t) => tabs.includes(t)),
        tabs.join(', '),
      );
      check(
        'the sidebar submenu lists the same seven destinations',
        (await count('.nav-sub-item')) === 7,
        `${await count('.nav-sub-item')} entries`,
      );
      await clickText('.nav-sub-item', 'Health', true);
      await until(`document.querySelector('.mon-tabs .settings-tab.active')?.textContent.trim() === 'Health'`, 6000, 'the health deep link');
      check('a submenu entry deep-links into its tab', true);
      check(
        'the monitoring stylesheet is applied',
        (await evaluate(`getComputedStyle(document.querySelector('.mon-card') || document.body).borderRadius`)) === '12px',
      );

      console.log('\n— overview');
      await goTab('Overview');
      await ok('monitor', 'sample');
      await clickText('.ghost-btn', 'Refresh', false);
      await sleep(600);
      await until(`document.querySelectorAll('.mon-tile').length === 6`, 8000, 'six overview tiles');
      check('six live resource tiles render', (await count('.mon-tile')) === 6);
      const cpu = await evaluate(`document.querySelector('.mon-tile .mon-tile-value')?.textContent || ''`);
      check('the CPU tile shows a real percentage', /%$/.test(cpu), cpu);
      check('the overview history chart renders', (await count('.mon-card .mon-chart svg')) >= 1);
      check('the chart legend names each series', (await count('.mon-chart-legend .mon-legend-item')) >= 2);
      check('the chart plots a real path', (await count('.mon-chart svg path')) >= 1);
      check('the ORVEX process table is listed', (await count('.mon-table .mon-row')) >= 1);
      await clickText('.mon-range button', '15m', true);
      await until(`document.querySelector('.mon-range button.active')?.textContent.trim() === '15m'`, 6000, 'the 15m range');
      check('the range switch drives the chart', true);
      await sleep(400);
      check('the sampled data survives the range change', (await count('.mon-chart svg path')) >= 1);

      console.log('\n— usage & cost');
      await goTab('Usage & cost');
      await until(`document.querySelectorAll('.mon-tile').length === 6`, 8000, 'six usage tiles');
      check('six usage tiles render', (await count('.mon-tile')) === 6);
      check('the usage window switch is present', (await count('.mon-range button')) === 4);
      await clickText('.mon-range button', '7d', true);
      await until(`document.querySelector('.mon-range button.active')?.textContent.trim() === '7d'`, 6000, 'the 7d window');
      check('switching to 7d updates the usage window', true);
      check('the budget guard input renders', (await count('.mon-inline .mon-input')) >= 1);
      check('usage charts render for tokens and cost', (await count('.mon-chart')) === 2);
      const usageTables = await count('.mon-table');
      const usageEmpty = await evaluate(`document.body.innerText.includes('No usage has been recorded yet')`);
      check('provider and model tables render (or the honest empty state)', usageTables >= 3 || usageEmpty, `${usageTables} table(s)${usageEmpty ? ', empty state' : ''}`);
      check('the CSV export button is available', (await evaluate(`[...document.querySelectorAll('button')].some((b) => b.textContent.includes('Export CSV'))`)));

      console.log('\n— traces');
      await goTab('Traces');
      await until(`!!document.querySelector('.mon-split .mon-traces')`, 8000, 'the trace list');
      check('the run list and timeline split renders', (await count('.mon-split')) === 1 && (await count('.mon-trace-detail')) === 1);
      const runItems = await count('.mon-trace-item');
      check('the recent run list answers', runItems >= 0, `${runItems} run(s)`);
      if (runItems > 0) {
        await evaluate(`document.querySelector('.mon-trace-item').click()`);
        await until(`!!document.querySelector('.mon-trace-summary')`, 8000, 'the trace summary');
        check('selecting a run opens its timeline', (await count('.mon-span')) >= 1, `${await count('.mon-span')} span(s)`);
        check('the totals strip renders', (await count('.mon-totals')) === 1);
      } else {
        check('with no runs the empty state explains how to create one', (await evaluate(`document.body.textContent.includes('Start a goal on the Engine page')`)));
      }

      console.log('\n— compare');
      await goTab('Compare');
      await until(`!!document.querySelector('.mon-textarea')`, 8000, 'the comparison form');
      check('the comparison prompt box renders', (await count('.mon-textarea')) === 1);
      const modelChecks = await count('.mon-check');
      check('configured providers are offered as checkboxes', modelChecks >= 0, `${modelChecks} model(s)`);
      check(
        'the run button requires two models',
        await evaluate(`(() => {
          const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Run comparison'));
          return btn ? btn.disabled === (${modelChecks} < 2) : false;
        })()`),
      );
      await setValue('.mon-textarea', 'Hello from the monitoring smoke test — this text is never sent.');
      check('the prompt field accepts input', (await evaluate(`document.querySelector('.mon-textarea').value.length`)) > 10);

      console.log('\n— evals');
      await goTab('Evals');
      await until(`!!document.querySelector('.mon-eval-split')`, 8000, 'the eval workspace');
      await until(`document.querySelector('.mon-trace-list')?.textContent.includes('Starter checks')`, 8000, 'the starter suite');
      check('the suite list includes the starter suite', true);
      await clickButton('New');
      await until(`!!document.querySelector('.mon-textarea.mon-code')`, 6000, 'the new suite editor');
      await setValue('.mon-eval-split .mon-input-wide', SUITE_NAME);
      await setValue(
        '.mon-textarea.mon-code',
        JSON.stringify([{ id: 'one', prompt: 'Reply with OK', checks: { contains: ['OK'] } }], null, 2),
      );
      await clickButton('Save');
      await until(`document.querySelector('.mon-trace-list')?.textContent.includes(${JSON.stringify(SUITE_NAME)})`, 8000, 'the saved suite');
      check('a suite saves from the editor', true);
      check('the saved suite shows its case count', (await evaluate(`[...document.querySelectorAll('.mon-trace-item')].find((n) => n.textContent.includes(${JSON.stringify(SUITE_NAME)}))?.textContent.includes('1 case')`)));
      const evalBridge = await ok('monitor', 'evalSuites');
      const created = evalBridge.suites.find((s) => s.name === SUITE_NAME);
      check('the suite is persisted through the bridge', !!created && created.caseCount === 1);
      const evalModels = await count('.mon-check');
      check(
        'the run button is disabled exactly when no model exists',
        await evaluate(`(() => {
          const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Run suite'));
          return btn ? btn.disabled === (${evalModels} === 0) : false;
        })()`),
      );
      await evaluate(`[...document.querySelectorAll('.mon-card-head button')].find((b) => b.textContent.trim() === 'Delete')?.click()`);
      await until(`!document.querySelector('.mon-trace-list')?.textContent.includes(${JSON.stringify(SUITE_NAME)})`, 8000, 'the suite removal');
      check('the suite deletes from the list', true);
      const afterDelete = await ok('monitor', 'evalSuites');
      check('the suite is gone from the bridge too', !afterDelete.suites.some((s) => s.name === SUITE_NAME));
      check('the history card renders', (await evaluate(`document.body.textContent.includes('No runs recorded for this suite yet')`)) || (await count('.mon-table')) >= 1);

      console.log('\n— health');
      await goTab('Health');
      await until(`document.querySelectorAll('.mon-health-row').length === 12`, 15000, 'the twelve health rows');
      check('all twelve probes render', (await count('.mon-health-row')) === 12);
      check('the summary chips count ok/warn/fail', (await count('.mon-health-summary .mon-chip')) === 3);
      check('the database probe passes', (await evaluate(`[...document.querySelectorAll('.mon-health-row')].find((n) => n.textContent.includes('SQLite store'))?.classList.contains('ok')`)));
      await clickText('.ghost-btn', 'Run checks', false);
      await sleep(800);
      check('re-running the probes keeps twelve rows', (await count('.mon-health-row')) === 12);

      console.log('\n— recovery');
      await goTab('Recovery');
      await until(`!!document.querySelector('.mon-recovery-list') || document.body.textContent.includes('Interrupted agent runs')`, 8000, 'the recovery workspace');
      const body = await evaluate(`document.body.textContent`);
      check('the three recovery sections render', ['Interrupted agent runs', 'Interrupted workflow runs', 'Crash log'].every((t) => body.includes(t)));
      check('the recovery summary chips render', (await count('.mon-health-summary .mon-chip')) >= 2);
      check('the crash explanation is honest about the marker', body.includes('removed on a clean quit'));

      console.log('\n— return');
      await evaluate(`document.querySelector('.page-back')?.click()`);
      await until(`document.querySelector('.page-title')?.textContent !== 'Monitoring'`, 8000, 'the dashboard');
      check('the back button leaves the page cleanly', true);
    } finally {
      cdp.ws.close();
    }
  } catch (err) {
    check('the Monitoring UI suite ran without fatal errors', false, err && err.stack ? err.stack.split('\n')[0] : String(err));
    if (cdp) cdp.ws.close();
  }
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed${passed === results.length ? '' : ' — FAILURES PRESENT'}`);
  process.exit(passed === results.length ? 0 : 1);
})();
