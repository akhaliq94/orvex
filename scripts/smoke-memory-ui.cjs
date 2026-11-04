'use strict';

/**
 * Section 8 Memory inspector UI smoke over CDP.
 * Seeds namespaced (ui-smoke-*) memories, then drives the real page: search,
 * edit/pin, create, RAG empty answer, profile save, conflict keep/merge,
 * filters, pinned view, expiry sweep and delete. Real user profile and
 * memories are restored/cleaned in finally.
 *
 * Needs the ORVEX window running with --remote-debugging-port=9222.
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
    if (data.method) events.push(data);
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
  return { ws, send, ready, events };
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
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('No page target — is the ORVEX window open?');
  const cdp = connect(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');

  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'evaluate failed');
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
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return el.value;
    })()`);
  const setSelect = (selector, value) =>
    evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return el.value;
    })()`);
  const clickItem = (text) =>
    evaluate(`(() => {
      const hit = [...document.querySelectorAll('.memory-item')].find((n) => n.textContent.includes(${JSON.stringify(text)}));
      if (!hit) return false;
      hit.click();
      return true;
    })()`);
  const clickCardButton = (cardText, buttonText) =>
    evaluate(`(() => {
      const card = [...document.querySelectorAll('.memory-conflict')].find((c) => c.textContent.includes(${JSON.stringify(cardText)}));
      if (!card) return 'no-card';
      const btn = [...card.querySelectorAll('button')].find((b) => b.textContent.trim().includes(${JSON.stringify(buttonText)}));
      if (!btn) return 'no-button';
      btn.click();
      return 'clicked';
    })()`);
  const keepSide = (cardText, sideText) =>
    evaluate(`(() => {
      const card = [...document.querySelectorAll('.memory-conflict')].find((c) => c.textContent.includes(${JSON.stringify(cardText)}));
      if (!card) return 'no-card';
      const side = [...card.querySelectorAll('.memory-conflict-side')].find((s) => s.textContent.includes(${JSON.stringify(sideText)}));
      const btn = side && side.querySelector('button');
      if (!btn) return 'no-button';
      btn.click();
      return 'clicked';
    })()`);
  const memoryEval = (body) =>
    evaluate(`(async () => {
      const api = window.orvex?.memory;
      if (!api) return { ok: false, error: 'no bridge' };
      ${body}
    })()`);

  let originalProfile = null;

  // Remount the renderer so stats cannot come from a previous smoke run.
  try {
    await cdp.send('Page.enable');
    await cdp.send('Page.reload', { ignoreCache: true });
  } catch {
    /* Page domain may be unavailable; the nav click still mounts a fresh page if needed */
  }
  const reloadStart = Date.now();
  while (Date.now() - reloadStart < 20000) {
    try {
      if (await evaluate(`!!window.orvex?.memory`)) break;
    } catch {
      /* context is being replaced */
    }
    await sleep(200);
  }

  try {
    check('memory bridge is exposed', await evaluate(`!!window.orvex?.memory && typeof window.orvex.memory.ask === 'function'`));

    const seeded = await memoryEval(`
      const existing = await api.list({ status: 'all', limit: 500 });
      if (existing.ok) {
        for (const item of existing.data) {
          if (String(item.text || '').startsWith('ui-smoke')) await api.remove(item.id);
        }
      }
      const profile = await api.profile();
      const adds = [
        ['ui-smoke prefers the dark theme for the editor', 'preference', 'ui', ['theme'], 0.8, false],
        ['ui-smoke prefers the light theme for the editor', 'preference', 'ui', ['theme'], 0.7, false],
        ['ui-smoke project lives in D:\\\\ui-smoke-workspace', 'project', 'orvex', ['workspace'], 0.9, false],
        ['ui-smoke pinned deployment checklist', 'procedure', 'deploy', ['release'], 0.7, true],
        ['ui-smoke deploy pipeline runs npm build', 'procedure', 'deploy', [], 0.6, false],
        ['ui-smoke deploy pipeline runs npm dist', 'procedure', 'deploy', [], 0.6, false],
      ];
      const ids = [];
      for (const [text, kind, project, tags, importance, pinned] of adds) {
        const r = await api.add({ text, kind, project, tags, importance, pinned, source: 'user' });
        if (!r.ok) return { ok: false, error: r.error };
        ids.push(r.data.id);
      }
      return { ok: true, ids, profile: profile.ok ? profile.data : null };
    `);
    check('seed memories created', seeded?.ok === true, seeded?.error || '');
    originalProfile = seeded?.profile || null;

    await until(`[...document.querySelectorAll('.nav-item')].some((n) => n.textContent.trim() === 'Memory')`, 20000, 'the Memory nav item');
    await clickText('.nav-item', 'Memory', true);
    await until(`document.querySelector('.page-title')?.textContent === 'Memory'`, 10000, 'the Memory page');
    await until(`!!document.querySelector('.memory-page')`, 10000, 'the memory layout');
    await until(`document.querySelector('.memory-stat b')?.textContent.trim() !== '—'`, 10000, 'the memory stats');
    await until(`[...document.querySelectorAll('.memory-item')].some((n) => n.textContent.includes('ui-smoke'))`, 10000, 'the seeded list');

    const shell = await evaluate(`(() => ({
      sub: document.querySelector('.page-sub')?.textContent || '',
      stats: Object.fromEntries([...document.querySelectorAll('.memory-stat')].map((el) => [
        el.querySelector('span')?.textContent.trim(),
        el.querySelector('b')?.textContent.trim(),
      ])),
      items: [...document.querySelectorAll('.memory-item')].length,
      ask: !!document.querySelector('.memory-ask-row input'),
      profile: document.querySelectorAll('.memory-profile-grid .text-input').length,
    }))()`);
    check('Memory page renders subtitle and six stats', shell.sub.includes('Structured long-term memory') && Object.keys(shell.stats).length === 6, JSON.stringify(shell.stats));
    check('Ask and profile sections render', shell.ask && shell.profile >= 4);

    const truth = await memoryEval(`
      const stats = await api.stats();
      const conflicts = await api.conflicts('open');
      return {
        ok: stats.ok && conflicts.ok,
        active: stats.ok ? stats.data.active : -1,
        conflicts: conflicts.ok ? conflicts.data.length : -1,
      };
    `);
    check('Active stat matches the backend', Number(shell.stats.Active) === truth.active, `${shell.stats.Active} vs ${truth.active}`);
    check('Conflict stat matches the backend', Number(shell.stats.Conflicts) === truth.conflicts, `${shell.stats.Conflicts} vs ${truth.conflicts}`);
    check('Seed conflict was detected', truth.conflicts >= 2, `${truth.conflicts} open`);

    await setValue('.memory-search input', 'ui-smoke project lives');
    await until(`[...document.querySelectorAll('.memory-item')].some((n) => n.textContent.includes('ui-smoke project lives')) && document.querySelectorAll('.memory-score').length > 0`, 10000, 'the scored project memory');
    check('Hybrid search finds a seeded memory', true);
    check('Search rows show a match score', await evaluate(`document.querySelectorAll('.memory-score').length > 0`));

    await clickItem('ui-smoke project lives');
    await until(`document.querySelector('.memory-detail .memory-textarea')?.value.includes('ui-smoke project lives')`, 5000, 'the memory editor');
    check('Selecting a memory loads the editor', true);
    check('Detail shows metadata and related area', await evaluate(`!!document.querySelector('.memory-meta')`));

    await setValue('.memory-detail .memory-textarea', 'ui-smoke project lives in D:\\ui-smoke-workspace (edited in UI)');
    await evaluate(`document.querySelector('.memory-detail .memory-actions .btn-primary')?.click()`);
    await until(`[...document.querySelectorAll('.memory-item')].some((n) => n.textContent.includes('edited in UI'))`, 10000, 'the edited memory');
    const edited = await memoryEval(`
      const hits = await api.search('ui-smoke project edited', { limit: 5 });
      return { ok: hits.ok, text: hits.ok && hits.data[0] ? hits.data[0].text : '' };
    `);
    check('Saving from the UI persists the new text', edited.ok && edited.text.includes('edited in UI'), edited.text);

    await evaluate(`document.querySelector('.memory-pin input')?.click()`);
    await evaluate(`document.querySelector('.memory-detail .memory-actions .btn-primary')?.click()`);
    await sleep(400);
    const pinned = await memoryEval(`
      const hits = await api.search('ui-smoke project edited', { limit: 5 });
      return { ok: hits.ok, pinned: hits.ok && hits.data[0] ? hits.data[0].pinned : false };
    `);
    check('Pinning from the UI persists', pinned.ok && pinned.pinned === true);

    await setValue('.memory-search input', '');
    await clickText('.page-tool-btn[aria-label="New memory"]', '');
    await until(`document.querySelector('.memory-detail-head')?.textContent.includes('New memory')`, 5000, 'the new memory form');
    await setValue('.memory-detail .memory-textarea', 'ui-smoke created from the UI');
    await evaluate(`document.querySelector('.memory-detail .memory-actions .btn-primary')?.click()`);
    await until(`[...document.querySelectorAll('.memory-item')].some((n) => n.textContent.includes('ui-smoke created from the UI'))`, 10000, 'the created memory');
    const created = await memoryEval(`
      const hits = await api.search('ui-smoke created from the UI', { limit: 5 });
      return { ok: hits.ok, id: hits.ok && hits.data[0] ? hits.data[0].id : null };
    `);
    check('Creating a memory from the UI persists', created.ok && !!created.id, created.id || created.error);

    await setValue('.memory-ask-row .text-input', '??? !!! ...');
    await clickText('.memory-ask-row .btn-primary', 'Ask');
    await until(`!!document.querySelector('.memory-answer')`, 15000, 'the memory answer');
    const rag = await evaluate(`(() => ({
      answer: document.querySelector('.memory-answer')?.textContent || '',
      chip: document.querySelector('.memory-ask .chip')?.textContent || '',
    }))()`);
    check('Ask with no matches is honest', rag.answer.includes('No stored memories matched') && rag.chip.trim() === 'no match', rag.chip);

    await setValue('.memory-profile-grid .memory-field:nth-child(1) .text-input', 'UI Smoke User');
    await evaluate(`document.querySelector('.memory-profile .memory-actions .btn-primary')?.click()`);
    await until(`(async () => {
      const r = await window.orvex.memory.profile();
      return r.ok && r.data.name === 'UI Smoke User';
    })()`, 8000, 'the saved profile');
    check('Profile save reaches the database', true);

    const kept = await keepSide('ui-smoke prefers the dark theme', 'dark theme');
    check('Keep-this control is clickable', kept === 'clicked', kept);
    await until(`(async () => {
      const r = await window.orvex.memory.list({ status: 'superseded', limit: 50 });
      return r.ok && r.data.some((i) => i.text.includes('light theme for the editor'));
    })()`, 10000, 'the superseded duplicate');
    check('Keeping a conflicted memory supersedes the other', true);

    const mergeClick = await clickCardButton('ui-smoke deploy pipeline runs npm build', 'Merge');
    check('Merge control opens the editor', mergeClick === 'clicked', mergeClick);
    await until(`!!document.querySelector('.memory-merge .memory-textarea')`, 5000, 'the merge editor');
    await setValue('.memory-merge .memory-textarea', 'ui-smoke merged deploy pipeline');
    await evaluate(`document.querySelector('.memory-merge .btn-primary')?.click()`);
    await until(`(async () => {
      const r = await window.orvex.memory.search('ui-smoke merged deploy pipeline', { limit: 5 });
      return r.ok && r.data.length > 0 && r.data[0].text === 'ui-smoke merged deploy pipeline';
    })()`, 10000, 'the merged memory');
    check('Merging writes one merged memory', true);

    await setSelect('.memory-filters select', 'preference');
    await sleep(500);
    const kindFilter = await evaluate(`(() => {
      const kinds = [...document.querySelectorAll('.memory-item .memory-kind')].map((n) => n.textContent.trim().toLowerCase());
      return { count: kinds.length, kinds };
    })()`);
    check('Kind filter narrows the list', kindFilter.count > 0 && kindFilter.kinds.every((k) => k === 'preference'), JSON.stringify(kindFilter));
    await setSelect('.memory-filters select', '');

    await setSelect('.memory-filters select:nth-of-type(2)', 'ui');
    await sleep(500);
    const projectFilter = await evaluate(`(() => {
      const projects = [...document.querySelectorAll('.memory-item .memory-project')].map((n) => n.textContent.trim());
      return { count: projects.length, projects };
    })()`);
    check('Project filter narrows the list', projectFilter.count > 0 && projectFilter.projects.every((p) => p === 'ui'), JSON.stringify(projectFilter));
    await setSelect('.memory-filters select:nth-of-type(2)', '');

    await clickText('.memory-view-tabs button', 'Pinned', true);
    await sleep(500);
    const pinnedView = await evaluate(`(async () => {
      const shown = [...document.querySelectorAll('.memory-item')].map((n) => n.textContent);
      const r = await window.orvex.memory.list({ pinned: true, limit: 50 });
      return { ok: r.ok, shown: shown.length, pinned: r.ok ? r.data.length : -1, texts: r.ok ? r.data.map((i) => i.text) : [] };
    })()`);
    check('Pinned view matches the backend', pinnedView.ok && pinnedView.shown === pinnedView.pinned, `${pinnedView.shown} vs ${pinnedView.pinned}`);
    await clickText('.memory-view-tabs button', 'Active', true);
    await sleep(300);

    await setValue('.memory-search input', 'ui-smoke created from the UI');
    await until(`[...document.querySelectorAll('.memory-item')].some((n) => n.textContent.includes('ui-smoke created from the UI'))`, 8000, 'the created memory row');
    await clickItem('ui-smoke created from the UI');
    await until(`document.querySelector('.memory-detail .memory-textarea')?.value.includes('ui-smoke created from the UI')`, 5000, 'the created memory editor');
    await clickText('.memory-detail .memory-actions .btn-ghost', 'Delete');
    await until(`!document.querySelector('.memory-list')?.textContent.includes('ui-smoke created from the UI')`, 10000, 'the deleted memory');
    const deleted = await memoryEval(`
      const hits = await api.search('ui-smoke created from the UI', { limit: 5 });
      return { ok: hits.ok, count: hits.ok ? hits.data.filter((h) => h.text.includes('ui-smoke created from the UI')).length : -1 };
    `);
    check('Deleting from the UI removes the memory', deleted.ok && deleted.count === 0, JSON.stringify(deleted));

    await setValue('.memory-search input', 'zzzz-no-such-memory');
    await until(`document.querySelector('.memory-empty')?.textContent.includes('No memories matched')`, 8000, 'the empty search state');
    check('Empty search explains the state', true);
    await setValue('.memory-search input', '');
    await sleep(400);

    const expired = await memoryEval(`
      const hits = await api.search('ui-smoke pinned deployment checklist', { limit: 5 });
      if (!hits.ok || !hits.data[0]) return { ok: false, error: 'pinned item missing' };
      const upd = await api.update(hits.data[0].id, { expiresAt: Date.now() - 60000 });
      return { ok: upd.ok, id: hits.data[0].id, error: upd.error };
    `);
    check('Expiry fixture prepared', expired.ok === true, expired.error || '');
    await evaluate(`document.querySelector('button[aria-label="Expire old memories"]')?.click()`);
    await until(`(async () => {
      const r = await window.orvex.memory.list({ status: 'expired', limit: 50 });
      return r.ok && r.data.some((i) => i.text.includes('ui-smoke pinned deployment checklist'));
    })()`, 10000, 'the swept memory');
    check('Expiry sweep moves a stale memory out of active', true);

    const exceptions = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown');
    check('no renderer exceptions on the Memory page', exceptions.length === 0, exceptions.map((e) => e.params?.exceptionDetails?.text).join('; '));

    console.log(`\nSection 8 Memory UI: ${pass} checks passed.`);
  } finally {
    try {
      await memoryEval(`
        const list = await api.list({ status: 'all', limit: 500 });
        if (list.ok) {
          for (const item of list.data) {
            if (String(item.text || '').startsWith('ui-smoke')) await api.remove(item.id);
          }
        }
        if (${JSON.stringify(originalProfile)} !== null) {
          await api.saveProfile({
            name: ${JSON.stringify(originalProfile?.name ?? '')},
            role: ${JSON.stringify(originalProfile?.role ?? '')},
            language: ${JSON.stringify(originalProfile?.language ?? '')},
            timezone: ${JSON.stringify(originalProfile?.timezone ?? '')},
            locations: ${JSON.stringify(originalProfile?.locations ?? '')},
            notes: ${JSON.stringify(originalProfile?.notes ?? '')},
          });
        }
        return { ok: true };
      `);
    } catch {
      /* renderer may be gone */
    }
    cdp.ws.close();
  }
}

main().catch((err) => {
  console.error('\nMEMORY UI SMOKE FAILED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
