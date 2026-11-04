'use strict';

/**
 * Section 13 Automation UI smoke over CDP.
 * Requires the ORVEX window running with --remote-debugging-port=9222.
 *
 * Drives the real page: opens Automation, checks the four tabs and seven
 * stats, builds a workflow with the palette (tool + transform + notify),
 * edits the trigger cron and checks the live preview, clicks a connection,
 * saves and runs it, verifies the recorded steps and the real system_status
 * output, exercises the cron helper, creates the approval template, runs it,
 * approves the suspended run, toggles and deletes through the UI, and asserts
 * the page never contains demo/simulated copy. Everything it creates is
 * removed in the finally block.
 */

const PORT = Number(process.env.ORVEX_CDP_PORT || 9222);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUN = Date.now().toString(36);

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
  const clickButton = (text) =>
    evaluate(`(() => {
      const hit = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)} && !b.disabled);
      if (!hit) return false;
      hit.click();
      return true;
    })()`);
  const clickText = (selector, text, exact = false) =>
    evaluate(`(() => {
      const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
      const hit = nodes.find((n) => ${exact ? `n.textContent.trim() === ${JSON.stringify(text)}` : `n.textContent.includes(${JSON.stringify(text)})`});
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
  const setField = (label, value) =>
    evaluate(`(() => {
      const field = [...document.querySelectorAll('.wf-side .wf-field')].find((f) => f.querySelector('span')?.textContent.trim().startsWith(${JSON.stringify(label)}));
      const el = field && field.querySelector('textarea, input, select');
      if (!el) return false;
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
      return el.value;
    })()`);
  const nodeIdOf = (typeLabel) =>
    evaluate(`(() => {
      const el = [...document.querySelectorAll('.react-flow__node')].find((n) => n.querySelector('.wf-node-type')?.textContent.trim() === ${JSON.stringify(typeLabel)});
      return el?.getAttribute('data-id') || '';
    })()`);
  const nodeCount = () => evaluate(`document.querySelectorAll('.react-flow__node').length`);
  const edgeCount = () => evaluate(`document.querySelectorAll('.react-flow__edge').length`);
  const goTab = async (label) => {
    await clickText('.dc-tabs .dc-tab', label, true);
    await until(`document.querySelector('.dc-tabs .dc-tab.active')?.textContent.trim() === ${JSON.stringify(label)}`, 5000, `the ${label} tab`);
  };
  const clickRow = (name) =>
    evaluate(`(() => {
      const row = [...document.querySelectorAll('.wf-row')].find((r) => r.querySelector('.wf-row-name')?.textContent.includes(${JSON.stringify(name)}));
      if (!row) return false;
      row.click();
      return true;
    })()`);

  const before = await ok('workflows', 'list');
  const preexisting = new Set(before.workflows.map((w) => w.id));
  const chainName = `UI chain ${RUN}`;

  try {
    await until(`!!window.orvex?.workflows`, 20000, 'the workflows bridge');
    check('the workflows bridge is exposed to the renderer', true);

    console.log('\n— open the page');
    await until(`[...document.querySelectorAll('.nav-item')].some((n) => n.textContent.trim() === 'Automation')`, 20000, 'the Automation nav item');
    await clickText('.nav-item', 'Automation', true);
    await until(`document.querySelector('.page-title')?.textContent === 'Automation'`, 10000, 'the Automation page');
    const sub = await evaluate(`document.querySelector('.page-sub')?.textContent.trim() || ''`);
    check('Automation opens from the sidebar with an honest subtitle', /real cron-scheduled workflows/i.test(sub) && /every step runs a real ORVEX tool/i.test(sub), sub);
    const tabs = await evaluate(`[...document.querySelectorAll('.dc-tabs .dc-tab')].map((n) => n.textContent.trim())`);
    check('the page offers Workflows, Runs, Schedule and Templates', ['Workflows', 'Runs', 'Schedule', 'Templates'].every((t) => tabs.includes(t)) && tabs.length === 4, tabs.join(', '));
    await goTab('Workflows');
    if (await evaluate(`!!document.querySelector('.wf-editor')`)) {
      await clickButton('Close');
      await until(`!document.querySelector('.wf-editor')`, 5000, 'the stale editor to close');
    }
    await until(`document.querySelectorAll('.wf-stat').length === 7`, 10000, 'the seven stat tiles');
    const statLabels = await evaluate(`[...document.querySelectorAll('.wf-stat span')].map((n) => n.textContent.trim())`);
    check('the stats cover workflows, slots and run states', ['Workflows', 'Enabled', 'Scheduled', 'Running', 'Queued', 'Approvals', 'Failed runs'].every((s) => statLabels.includes(s)), statLabels.join(', '));

    console.log('\n— build a workflow with the palette');
    await until(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'New workflow')`, 10000, 'the New workflow button');
    await clickButton('New workflow');
    await until(`!!document.querySelector('.wf-editor')`, 5000, 'the workflow editor');
    await until(`document.querySelectorAll('.react-flow__node').length === 1`, 10000, 'the trigger node');
    const palette = await evaluate(`[...document.querySelectorAll('.wf-add')].map((b) => b.textContent.trim())`);
    check('the palette offers every node type', ['Trigger', 'Tool', 'Condition', 'Loop', 'Wait', 'Notify', 'Approval', 'Set value'].every((t) => palette.includes(t)), palette.join(', '));
    const triggerDisabled = await evaluate(`[...document.querySelectorAll('.wf-add')].find((b) => b.textContent.trim() === 'Trigger')?.disabled === true`);
    check('the trigger button is disabled once the trigger exists', triggerDisabled);

    await setValue('.wf-editor-head .wf-name', chainName);
    await clickText('.wf-add', 'Tool', true);
    await until(`document.querySelectorAll('.react-flow__node').length === 2`, 5000, 'the tool node');
    await until(`document.querySelector('.wf-side .wf-side-head strong')?.textContent === 'Tool'`, 5000, 'the tool inspector');
    const toolOptions = await evaluate(`[...document.querySelectorAll('.wf-side select')].filter((s) => [...s.options].some((o) => o.value === 'system_status')).length`);
    check('the tool inspector lists the real registry', toolOptions === 1);
    await setField('Tool', 'system_status');
    await until(
      `[...document.querySelectorAll('.wf-side .wf-hint')].some((n) => n.textContent.includes('machine status'))`,
      5000,
      'the tool description',
    );
    await setField('Attempts', '2');
    const toolId = await nodeIdOf('Tool');
    check('the new tool node got a stable id', /^tool_/.test(toolId), toolId);

    await clickText('.wf-add', 'Set value', true);
    await until(`document.querySelectorAll('.react-flow__node').length === 3`, 5000, 'the transform node');
    const transformId = await nodeIdOf('Set value');
    await setField('Template', `Status: {{steps.${toolId}.output}}`);

    await clickText('.wf-add', 'Notify', true);
    await until(`document.querySelectorAll('.react-flow__node').length === 4`, 5000, 'the notify node');
    await setField('Title', 'UI chain');
    await setField('Message', `{{steps.${transformId}.output}}`);
    await until(`document.querySelectorAll('.react-flow__edge').length === 3`, 5000, 'three connections');
    const builtEdges = await edgeCount();
    check('the palette auto-connects each new node', builtEdges === 3, `${builtEdges} connection(s)`);

    console.log('\n— trigger cron preview and connection inspector');
    await evaluate(`document.querySelector('.react-flow__node[data-id="trigger"]')?.click()`);
    await until(`document.querySelector('.wf-side .wf-side-head strong')?.textContent === 'Trigger'`, 5000, 'the trigger inspector');
    await setField('Start', 'schedule');
    await until(`!!document.querySelector('.wf-side input.wf-mono')`, 5000, 'the cron input');
    await setField('Cron', '*/15 * * * *');
    const preview = await until(
      `(() => {
        const hint = [...document.querySelectorAll('.wf-side .wf-hint')].map((n) => n.textContent.trim()).find((t) => t.startsWith('Next run'));
        return hint || '';
      })()`,
      10000,
      'the cron preview',
    );
    check('changing the trigger to a schedule previews the real next run', /^Next run /.test(preview), preview);
    await setField('Cron', 'nope');
    const badPreview = await until(
      `(() => {
        const hint = document.querySelector('.wf-side .wf-hint.wf-hint-bad');
        return hint ? hint.textContent.trim() : '';
      })()`,
      10000,
      'the invalid cron message',
    );
    check('an invalid cron is reported in the inspector', /5 fields/.test(badPreview), badPreview);
    await setField('Cron', '0 9 * * *');
    await setField('Start', 'manual');
    check('the trigger can go back to a manual start', await evaluate(`[...document.querySelectorAll('.wf-side select')].some((s) => s.value === 'manual')`));

    const edgeClicked = await until(
      `(() => {
        const edge = document.querySelector('.react-flow__edge');
        if (!edge) return false;
        edge.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return true;
      })()`,
      5000,
      'a clickable connection',
    );
    const edgeInspector = await until(
      `(() => {
        const head = document.querySelector('.wf-side .wf-side-head strong')?.textContent.trim();
        return head === 'Connection' ? (document.querySelector('.wf-side .wf-hint')?.textContent.trim() || '') : '';
      })()`,
      5000,
      'the connection inspector',
    ).catch(() => '');
    check('clicking a connection opens its branch inspector', edgeClicked && /→/.test(edgeInspector), edgeInspector);

    console.log('\n— save and run the workflow');
    await clickButton('Save & run');
    await until(`document.querySelector('.dc-tabs .dc-tab.active')?.textContent.trim() === 'Runs'`, 15000, 'the Runs tab after saving');
    const succeeded = await until(
      `(() => {
        const chip = document.querySelector('.wf-run-detail .wf-chip');
        return chip?.textContent.trim() === 'Succeeded' ? 'Succeeded' : '';
      })()`,
      40000,
      'the run to succeed',
    );
    check('Save & run executes the workflow and shows it succeeding', succeeded === 'Succeeded');
    const steps = await evaluate(`document.querySelectorAll('.wf-run-detail .wf-step').length`);
    const stepText = await evaluate(`[...document.querySelectorAll('.wf-run-detail .wf-step-out')].map((n) => n.textContent).join('\\n')`);
    check('the run detail records all four steps', steps === 4, `${steps} steps`);
    check('the tool step really ran system_status', /— (win32|linux|darwin) /.test(stepText) && /threads/.test(stepText), stepText.replace(/\s+/g, ' ').slice(0, 80));
    const finalOut = await evaluate(`document.querySelector('.wf-run-detail .wf-pre')?.textContent || ''`);
    check('the template interpolation reaches the notification', /Notification (sent|unavailable)/.test(finalOut) && /Status: /.test(finalOut), finalOut.replace(/\s+/g, ' ').slice(0, 110));
    const finishedButtons = await evaluate(`(() => {
      const buttons = [...document.querySelectorAll('.wf-run-detail button')];
      const cancel = buttons.find((b) => b.textContent.trim() === 'Cancel');
      const resume = buttons.find((b) => b.textContent.trim() === 'Resume');
      return { cancel: cancel?.disabled === true, resume: resume?.disabled === true };
    })()`);
    check('a finished run disables Cancel and Resume', finishedButtons.cancel && finishedButtons.resume);

    const runList = await evaluate(`document.querySelectorAll('.wf-run-row').length`);
    check('the run appears in the history list', runList >= 1, `${runList} row(s)`);

    console.log('\n— cron helper');
    await goTab('Schedule');
    await until(`!!document.querySelector('.wf-cron-line input')`, 5000, 'the cron helper');
    await setValue('.wf-cron-line input', '*/15 * * * *');
    await clickButton('Preview next 5');
    await until(`document.querySelectorAll('.wf-cron-list span').length === 5`, 15000, 'five preview runs');
    const previews = await evaluate(`[...document.querySelectorAll('.wf-cron-list span')].map((n) => n.textContent.trim())`);
    check('Preview next 5 lists five real aligned times', previews.length === 5 && previews.every((p) => p.length > 8), previews[1]);
    await setValue('.wf-cron-line input', 'bad');
    await clickButton('Preview next 5');
    const cronError = await until(`document.querySelector('.wf-cron-card .wf-hint-bad')?.textContent.trim() || ''`, 10000, 'the cron error');
    check('the cron helper reports invalid expressions', /5 fields/.test(cronError), cronError);
    const scheduleState = await evaluate(`(() => {
      const empty = [...document.querySelectorAll('.wf-schedule .wf-empty strong')].some((n) => n.textContent.includes('No scheduled workflows'));
      const rows = document.querySelectorAll('.wf-schedule .wf-list .wf-row').length;
      return { empty, rows };
    })()`);
    check(
      'the schedule tab lists scheduled workflows or says there are none',
      scheduleState.empty || scheduleState.rows > 0,
      scheduleState.empty ? 'empty state' : `${scheduleState.rows} scheduled`,
    );

    console.log('\n— templates and the approval gate');
    await goTab('Templates');
    await until(`document.querySelectorAll('.wf-template').length === 4`, 10000, 'four templates');
    const templateNames = await evaluate(`[...document.querySelectorAll('.wf-template-head strong')].map((n) => n.textContent.trim())`);
    check('all four real templates are listed', ['Daily system briefing', 'API heartbeat', 'Loop and pause', 'Guarded action'].every((n) => templateNames.includes(n)), templateNames.join(', '));
    const used = await evaluate(`(() => {
      const card = [...document.querySelectorAll('.wf-template')].find((c) => c.querySelector('.wf-template-head strong')?.textContent.trim() === 'Guarded action');
      const button = card && [...card.querySelectorAll('button')].find((b) => b.textContent.includes('Use template'));
      if (!button) return false;
      button.click();
      return true;
    })()`);
    await until(`document.querySelector('.dc-tabs .dc-tab.active')?.textContent.trim() === 'Workflows'`, 10000, 'the editor after using a template');
    await until(`!!document.querySelector('.wf-editor') && document.querySelectorAll('.react-flow__node').length === 3`, 10000, 'the template workflow');
    check('Use template opens a real editable workflow', used);
    await clickButton('Save & run');
    await until(`document.querySelector('.dc-tabs .dc-tab.active')?.textContent.trim() === 'Runs'`, 15000, 'the Runs tab for the template');
    const approval = await until(
      `(() => {
        const banner = document.querySelector('.wf-approval');
        return banner ? banner.innerText.replace(/\\s+/g, ' ').trim() : '';
      })()`,
      20000,
      'the approval banner',
    );
    check('the template run suspends and asks for approval', /Workflow approval/.test(approval) && /Continue with the guarded action\?/.test(approval), approval.slice(0, 90));
    await clickButton('Approve & continue');
    const approved = await until(
      `(() => {
        const chip = document.querySelector('.wf-run-detail .wf-chip');
        return chip?.textContent.trim() === 'Succeeded' ? 'Succeeded' : '';
      })()`,
      20000,
      'the approved run to succeed',
    );
    check('approving from the Runs tab continues the real run', approved === 'Succeeded');

    console.log('\n— toggle, discard and delete through the UI');
    await goTab('Workflows');
    await until(`[...document.querySelectorAll('.wf-row-name')].some((n) => n.textContent.includes(${JSON.stringify(chainName)}))`, 10000, 'the saved workflow row');
    const toggledOff = await evaluate(`(() => {
      const row = [...document.querySelectorAll('.wf-row')].find((r) => r.querySelector('.wf-row-name')?.textContent.includes(${JSON.stringify(chainName)}));
      if (!row) return false;
      row.querySelector('.switch')?.click();
      return true;
    })()`);
    await until(
      `(async () => {
        const r = await window.orvex.workflows.list();
        const wf = r.ok && r.data.workflows.find((w) => w.name === ${JSON.stringify(chainName)});
        return !!wf && wf.enabled === false;
      })()`,
      10000,
      'the workflow to pause',
    );
    check('the row switch really pauses the workflow', toggledOff);
    await until(`(() => {
      const row = [...document.querySelectorAll('.wf-row')].find((r) => r.querySelector('.wf-row-name')?.textContent.includes(${JSON.stringify(chainName)}));
      return !!row?.querySelector('.wf-tag.off');
    })()`, 5000, 'the paused tag');
    check('the paused workflow shows its paused tag', true);
    await evaluate(`(() => {
      const row = [...document.querySelectorAll('.wf-row')].find((r) => r.querySelector('.wf-row-name')?.textContent.includes(${JSON.stringify(chainName)}));
      row?.querySelector('.switch')?.click();
    })()`);
    await until(
      `(async () => {
        const r = await window.orvex.workflows.list();
        const wf = r.ok && r.data.workflows.find((w) => w.name === ${JSON.stringify(chainName)});
        return !!wf && wf.enabled === true;
      })()`,
      10000,
      'the workflow to resume',
    );
    check('the switch turns the workflow back on', true);

    await clickRow(chainName);
    await until(`document.querySelector('.wf-editor-head .wf-name')?.value === ${JSON.stringify(chainName)}`, 5000, 'the editor for the saved workflow');
    await setValue('.wf-editor-head .wf-name', 'UI chain discarded');
    await clickButton('Close');
    await until(`!!document.querySelector('.wf-list-area')`, 5000, 'the workflow list');
    const nameAfterClose = await evaluate(`[...document.querySelectorAll('.wf-row-name')].map((n) => n.textContent).join(' | ')`);
    check('Close discards unsaved edits', nameAfterClose.includes(chainName) && !nameAfterClose.includes('UI chain discarded'));

    const pageText = await evaluate(`(() => {
      const copy = document.querySelector('.wf-page')?.cloneNode(true);
      copy?.querySelectorAll('.wf-row, .wf-run-row, .wf-template').forEach((n) => n.remove());
      return copy?.innerText || '';
    })()`);
    check('the page contains no demo or simulated copy', !/simulat|demo|mock|placeholder data|lorem ipsum/i.test(pageText));

    await evaluate(`window.confirm = () => true`);
    await clickRow(chainName);
    await until(`!!document.querySelector('.wf-editor-head .wf-danger')`, 5000, 'the delete button');
    await evaluate(`document.querySelector('.wf-editor-head .wf-danger')?.click()`);
    await until(`![...document.querySelectorAll('.wf-row-name')].some((n) => n.textContent.includes(${JSON.stringify(chainName)}))`, 10000, 'the workflow to be deleted');
    check('Delete removes the workflow from the list', true);

    const afterDelete = await ok('workflows', 'list');
    check(
      'the deleted workflow is gone from the bridge',
      !afterDelete.workflows.some((w) => w.name === chainName),
      `${afterDelete.stats.workflows} workflow(s) left`,
    );
  } catch (err) {
    check('the UI suite ran without fatal errors', false, err && err.message ? err.message : String(err));
  } finally {
    try {
      const now = await ok('workflows', 'list');
      for (const wf of now.workflows.filter((w) => !preexisting.has(w.id))) {
        await ipc('workflows', 'remove', wf.id);
        await ipc('workflows', 'clearRuns', wf.id);
      }
      const end = await ok('workflows', 'list');
      check('the UI smoke leaves no workflows behind', end.workflows.length === preexisting.size, `${end.workflows.length} workflow(s)`);
    } catch (err) {
      check('cleanup ran', false, err && err.message ? err.message : String(err));
    }
    cdp.ws.close();
    console.log(`\nautomation UI smoke ${process.exitCode ? 'reported failures' : 'OK'}: ${pass} checks`);
  }
}

main().catch((err) => {
  console.error('\nworkflows UI smoke crashed:', err && err.message ? err.message : err);
  process.exit(1);
});
