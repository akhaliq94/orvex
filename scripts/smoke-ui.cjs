'use strict';

/**
 * UI smoke test over the Chrome DevTools Protocol.
 * Requires an Electron instance started with --remote-debugging-port=9222.
 * Checks that the shell renders, the Settings → Routing/Usage tabs work and the
 * desktop bridge answers. Run under plain Node (no native modules needed).
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
  const events = [];
  let nextId = 1;
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', (e) => reject(e));
  });
  ws.addEventListener('message', (msg) => {
    const data = JSON.parse(msg.data);
    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) reject(new Error(data.error.message));
      else resolve(data.result);
      return;
    }
    if (data.method) events.push(data);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { ws, send, events, ready };
}

async function main() {
  const list = await targets();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('No page target — is the ORVEX window open?');

  const cdp = connect(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');

  const evaluate = async (expression) => {
    const res = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) {
      throw new Error(`evaluate failed: ${res.exceptionDetails.text} ${res.exceptionDetails.exception?.description || ''}`);
    }
    return res.result.value;
  };

  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  };

  const body = await evaluate('document.body.innerText');
  check('shell renders', typeof body === 'string' && body.length > 200, `${body.length} chars`);

  const bridge = await evaluate('!!(window.orvex && window.orvex.llm && window.orvex.usage && window.orvex.routing)');
  check('desktop bridge exposes llm/usage/routing', bridge === true);

  const dbInfo = await evaluate('window.orvex.db.info().then((r) => r)');
  check('SQLite opens in Electron', !!(dbInfo && dbInfo.ok && dbInfo.data.ready), dbInfo && dbInfo.ok ? String(dbInfo.data.file) : dbInfo && dbInfo.error);

  // Open Settings from the sidebar/header.
  const opened = await evaluate(`(() => {
    const btn = [...document.querySelectorAll('button, a')].find((el) => /settings/i.test(el.textContent || '') && (el.textContent || '').trim().length < 30);
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  check('Settings opens', opened === true);
  await sleep(700);

  const tabs = await evaluate(`[...document.querySelectorAll('[role="tab"]')].map((el) => el.textContent.trim())`);
  check('Routing + Usage tabs exist', Array.isArray(tabs) && tabs.some((t) => /routing/i.test(t)) && tabs.some((t) => /usage/i.test(t)), JSON.stringify(tabs));

  await evaluate(`(() => {
    const tab = [...document.querySelectorAll('[role="tab"]')].find((el) => /routing/i.test(el.textContent || ''));
    tab?.click();
  })()`);
  await sleep(500);
  const routingText = await evaluate('document.body.innerText');
  check('Routing editor renders task chains', /Task routing/.test(routingText) && /Agent runs/.test(routingText) && /fallback|No override/.test(routingText));

  await evaluate(`(() => {
    const tab = [...document.querySelectorAll('[role="tab"]')].find((el) => /usage/i.test(el.textContent || ''));
    tab?.click();
  })()`);
  let usageText = '';
  for (let i = 0; i < 25; i += 1) {
    await sleep(200);
    usageText = await evaluate('document.body.innerText');
    if (/by model/i.test(usageText) || /No calls in this window/.test(usageText)) break;
  }
  check('Usage dashboard renders', /model usage/i.test(usageText) && /calls/i.test(usageText) && /by model/i.test(usageText));
  check('Usage reads the database', /Database:/.test(usageText) || /No calls in this window/.test(usageText));

  const summary = await evaluate('window.orvex.usage.summary(86400000).then((r) => r)');
  check('usage IPC answers', !!(summary && summary.ok && summary.data && Array.isArray(summary.data.byModel)));

  await evaluate(`(() => {
    const btn = [...document.querySelectorAll('button, a')].find((el) => /^engine$/i.test((el.textContent || '').trim()));
    btn?.click();
  })()`);
  await sleep(600);
  const engineText = await evaluate('document.body.innerText');
  check('Engine page shows the plan → verify toggle', /Plan → verify/.test(engineText) && /Goal/.test(engineText));

  const toggled = await evaluate(`(() => {
    const label = [...document.querySelectorAll('.engine-fullauto')].find((el) => /Plan → verify/.test(el.textContent || ''));
    const input = label && label.querySelector('input');
    if (!input) return false;
    input.click();
    return true;
  })()`);
  await sleep(350);
  const runLabel = await evaluate(`([...document.querySelectorAll('button')].find((b) => /Plan & run|Start engine/.test(b.textContent || '')) || {}).textContent || ''`);
  check('Engine start button reflects plan mode', toggled === true && /Plan & run/.test(runLabel), runLabel.trim());
  await evaluate(`(() => {
    const label = [...document.querySelectorAll('.engine-fullauto')].find((el) => /Plan → verify/.test(el.textContent || ''));
    const input = label && label.querySelector('input');
    if (input && input.checked) input.click();
  })()`);

  const exceptions = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown').map((e) => e.params.exceptionDetails?.exception?.description || e.params.exceptionDetails?.text);
  check('no uncaught renderer exceptions', exceptions.length === 0, exceptions.slice(0, 3).join(' | '));

  cdp.ws.close();
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.error(`ui smoke FAILED: ${failed.length} check(s)`);
    process.exit(1);
  }
  console.log(`ui smoke: OK — ${results.length} checks passed`);
}

main().catch((err) => {
  console.error('ui smoke FAILED:', err && err.message ? err.message : err);
  process.exit(1);
});
