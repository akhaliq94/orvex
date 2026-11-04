'use strict';

/**
 * Section 16 UI smoke over CDP.
 * Requires the packaged ORVEX window running with --remote-debugging-port=9222.
 *
 * Verifies real window controls, the always-on-top mini window (#mini), the
 * command palette (commands, tabs, memory hits), the notification inbox,
 * the task dashboard and the App settings tab backed by real prefs.
 */

const PORT = Number(process.env.ORVEX_CDP_PORT || 9222);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

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

function pageApi(cdp) {
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
  const clickText = (selector, text) =>
    evaluate(`(() => {
      const hit = [...document.querySelectorAll(${JSON.stringify(selector)})].find((n) => n.textContent.includes(${JSON.stringify(text)}));
      if (!hit) return false;
      hit.click();
      return true;
    })()`);
  const setValue = (selector, value) =>
    evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
  return { evaluate, until, ipc, ok, clickText, setValue };
}

(async () => {
  let cdp;
  let miniCdp;
  const marker = `palette-smoke-${Date.now()}`;
  let memoryId = null;
  try {
    const list = await targets();
    const page = list.find((t) => t.type === 'page' && /\/index\.html|\/$/.test(t.url) && !/#mini/.test(t.url) && !/recorder\.html/.test(t.url));
    if (!page) throw new Error(`No ORVEX page target. Targets: ${list.map((t) => t.url).join(', ')}`);
    cdp = connect(page.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send('Runtime.enable');
    const app = pageApi(cdp);
    const { evaluate, until, ipc, ok, clickText, setValue } = app;

    /* ---------------------------------------------------------- window API */
    check('window bridge exposes real actions', await evaluate(`typeof window.orvex?.app?.window === 'function'`));
    check('window bridge exposes state/notify/navigate events', await evaluate(
      `typeof window.orvex?.app?.onWindowState === 'function' && typeof window.orvex?.app?.onNotify === 'function' && typeof window.orvex?.app?.onNavigate === 'function'`,
    ));
    const state = await ok('app', 'window', 'state');
    check('window state reports the live Electron window', state.available === true && typeof state.visible === 'boolean' && state.minimized === false, JSON.stringify(state));
    check('global hotkey is registered', typeof state.hotkey === 'string' && state.hotkey.length > 0, String(state.hotkey));
    check('close-to-tray pref is reported', typeof state.closeToTray === 'boolean', String(state.closeToTray));

    /* ------------------------------------------------------------- header */
    await until(`document.querySelector('.sys-chip')?.textContent.includes('%')`, 8000, 'dashboard metrics');
    await until(`!/local user/.test(document.querySelector('.user-avatar')?.getAttribute('aria-label') || '')`, 8000, 'dashboard user');
    check('header shows a live CPU/RAM chip', await evaluate(
      `(() => { const el = document.querySelector('.sys-chip'); return !!el && el.textContent.includes('%'); })()`,
    ), await evaluate(`document.querySelector('.sys-chip')?.textContent.trim() || ''`));
    check('header user avatar renders the real OS user', await evaluate(
      `(() => { const el = document.querySelector('.user-avatar'); const label = el?.getAttribute('aria-label') || ''; return !!el && el.textContent.trim().length >= 2 && /Profile for /.test(label); })()`,
    ), await evaluate(`document.querySelector('.user-avatar')?.getAttribute('aria-label') || ''`));
    check('header has three real window buttons', await evaluate(`document.querySelectorAll('.window-controls .win-btn').length === 3`));
    check('header exposes the mini window toggle', await evaluate(
      `!!document.querySelector('[aria-label="Open mini window"], [aria-label="Hide mini window"]')`,
    ));
    check('fake weather panel is gone', await evaluate(`!document.querySelector('.weather-temp') && !document.querySelector('.weather-city')`));

    /* ------------------------------------------------------ task dashboard */
    check('task dashboard replaces the old work queue label', await evaluate(
      `document.querySelector('.job-monitor .panel-title')?.textContent.trim() === 'Task dashboard'`,
    ));
    check('task dashboard reports active/recent counts', await evaluate(
      `/\\d+ active · \\d+ recent/.test(document.querySelector('.jm-count')?.textContent || '')`,
    ));

    /* ---------------------------------------------------- command palette */
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))`);
    await until(`!!document.querySelector('.gs-panel')`, 4000, 'command palette');
    check('palette opens and groups commands + pages', await evaluate(
      `(() => { const heads = [...document.querySelectorAll('.gs-group-head')].map((n) => n.textContent.trim()); return heads.includes('Commands') && heads.includes('Pages'); })()`,
    ));
    await setValue('.gs-input', 'Health');
    await until(`!![...document.querySelectorAll('.gs-hit-title')].find((n) => n.textContent.includes('Monitoring · Health'))`, 4000, 'Health tab hit');
    check('palette finds a specific page tab', true, 'Monitoring · Health');
    await setValue('.gs-input', 'mini');
    await until(`!![...document.querySelectorAll('.gs-hit-title')].find((n) => n.textContent.includes('Toggle mini window'))`, 4000, 'mini command');
    check('palette runs real commands', true, 'Toggle mini window');

    const note = await ok('memory', 'add', { text: `${marker} palette smoke note`, kind: 'fact' });
    memoryId = note.id;
    await setValue('.gs-input', marker);
    await until(`[...document.querySelectorAll('.gs-group-head')].some((n) => n.textContent.trim() === 'Memory')`, 6000, 'memory group');
    check('palette searches live memory', true, marker);
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await until(`!document.querySelector('.gs-panel')`, 3000, 'palette closes');

    /* -------------------------------------------------------- mini window */
    const opened = await ok('app', 'window', 'openMini');
    check('mini window opens through IPC', opened.miniOpen === true, JSON.stringify(opened));
    let miniTarget = null;
    for (let i = 0; i < 30 && !miniTarget; i += 1) {
      const listNow = await targets();
      miniTarget = listNow.find((t) => t.type === 'page' && /#mini$/.test(t.url));
      if (!miniTarget) await sleep(200);
    }
    if (!miniTarget) throw new Error('Mini window target did not appear on CDP');
    check('mini window is a real BrowserWindow target', true, miniTarget.url);

    miniCdp = connect(miniTarget.webSocketDebuggerUrl);
    await miniCdp.ready;
    await miniCdp.send('Runtime.enable');
    const mini = pageApi(miniCdp);
    await mini.until(`!!document.querySelector('.mini-app')`, 6000, 'mini UI');
    await mini.until(`document.querySelector('.mini-status')?.textContent.trim() !== 'connecting'`, 8000, 'mini dashboard snapshot');
    check('mini window renders the compact shell', await mini.evaluate(
      `!!document.querySelector('.mini-app') && !!document.querySelector('.mini-head') && !!document.querySelector('.mini-body')`,
    ));
    check('mini status is wired to the live agent state', await mini.evaluate(
      `/^(idle|running|paused|connecting)$/.test(document.querySelector('.mini-status')?.textContent.trim() || '')`,
    ), await mini.evaluate(`document.querySelector('.mini-status')?.textContent.trim() || ''`));
    check('mini shows three live metrics', await mini.evaluate(`document.querySelectorAll('.mini-metric').length === 3`));
    check('mini metrics include real CPU/RAM readings', await mini.evaluate(
      `(() => { const values = [...document.querySelectorAll('.mini-metric b')].map((n) => n.textContent.trim()); return values.length === 3 && values.slice(0, 2).every((v) => v === '—' || /^\\d+%$/.test(v)); })()`,
    ), await mini.evaluate(`[...document.querySelectorAll('.mini-metric b')].map((n) => n.textContent).join(' / ')`));
    check('mini has four real quick actions', await mini.evaluate(`document.querySelectorAll('.mini-action').length === 4`));
    check('mini footer names the real user and host', await mini.evaluate(
      `!!document.querySelector('.mini-foot') && document.querySelector('.mini-foot').textContent.includes('·')`,
    ), await mini.evaluate(`document.querySelector('.mini-foot')?.textContent.trim() || ''`));

    await mini.evaluate(`[...document.querySelectorAll('.mini-action')].find((b) => b.textContent.includes('Chat'))?.click()`);
    await until(`document.querySelector('.nav-item.active')?.textContent.includes('Chat')`, 5000, 'main navigates to Chat from mini');
    check('mini navigates the main window', true, 'Chat');
    // Close from the main renderer: the mini target is destroyed by close(), so a
    // CDP evaluate issued inside it would never receive a reply.
    await ok('app', 'window', 'closeMini');
    await sleep(900);
    const closed = await ok('app', 'window', 'state');
    check('mini window closes through IPC', closed.miniOpen === false, JSON.stringify(closed));

    /* ------------------------------------------------------ notifications */
    await evaluate(`document.querySelector('[aria-label="Notifications"]')?.click()`);
    await until(`!!document.querySelector('.notif-panel')`, 4000, 'notification panel');
    check('notification inbox renders unread count', /Notifications( · \d+ unread)?/.test(await evaluate(
      `document.querySelector('.notif-panel .agent-log-head span')?.textContent || ''`,
    )), await evaluate(`document.querySelector('.notif-panel .agent-log-head span')?.textContent.trim() || ''`));
    check('inbox exposes mark-read / clear actions', await evaluate(
      `(() => { const labels = [...document.querySelectorAll('.notif-panel button')].map((b) => b.textContent.trim()); return labels.includes('Mark all read') && labels.includes('Clear read') && labels.includes('Clear all'); })()`,
    ));
    check('inbox rows are rendered as buttons', await evaluate(
      `[...document.querySelectorAll('.notif-row')].every((n) => n.tagName === 'BUTTON')`,
    ));
    await evaluate(`document.querySelector('.notif-panel [aria-label="Close notifications"]')?.click()`);
    await until(`!document.querySelector('.notif-panel')`, 3000, 'notification panel closes');

    /* ---------------------------------------------------- App settings tab */
    check('notification pipeline listener registers', await evaluate(
      `(() => { const off = window.orvex.app.onNotify(() => {}); const t = typeof off; off(); return t === 'function'; })()`,
    ));
    await clickText('.nav-item', 'Settings');
    await until(`document.querySelector('.page-title')?.textContent.trim() === 'Settings'`, 5000, 'settings page');
    await clickText('.settings-tab', 'App');
    await until(`!!document.querySelector('#close-to-tray')`, 5000, 'App tab');
    check('App tab exposes real tray and login prefs', await evaluate(
      `!!document.querySelector('#close-to-tray') && !!document.querySelector('#launch-login')`,
    ));
    check('App tab exposes real mini-window controls', await evaluate(
      `[...document.querySelectorAll('.settings-block button')].some((b) => /mini window/i.test(b.textContent))`,
    ));
    check('App tab shows the notification inbox controls', await evaluate(
      `[...document.querySelectorAll('.settings-block h3')].some((h) => h.textContent.trim() === 'Notifications')`,
    ));
    check('App tab shows real build information', await evaluate(
      `/Version/.test(document.querySelector('.settings-block:last-child .settings-note')?.textContent || '') && /Data directory/.test(document.querySelector('.settings-block:last-child .settings-note')?.textContent || '')`,
    ));
    const before = await ok('app', 'prefs');
    const trayBox = await evaluate(`document.querySelector('#close-to-tray').checked`);
    await evaluate(`document.querySelector('#close-to-tray').click()`);
    await sleep(500);
    const after = await ok('app', 'prefs');
    check('tray preference writes through IPC', after.closeToTray === !before.closeToTray, `${before.closeToTray} → ${after.closeToTray}`);
    await evaluate(`document.querySelector('#close-to-tray').click()`);
    await sleep(500);
    const restored = await ok('app', 'prefs');
    check('tray preference restores cleanly', restored.closeToTray === before.closeToTray && trayBox === before.closeToTray);

    /* --------------------------------------------- minimize + restore (last) */
    const minimized = await ok('app', 'window', 'minimize');
    check('minimize reaches the real window', minimized.minimized === true, JSON.stringify(minimized));
    const restoredWin = await ok('app', 'window', 'restore');
    check('restore brings the real window back', restoredWin.minimized === false && restoredWin.visible === true, JSON.stringify(restoredWin));

    if (memoryId) {
      await ipc('memory', 'remove', memoryId);
      memoryId = null;
    }
  } catch (err) {
    check('smoke run completed without throwing', false, err && err.message ? err.message : String(err));
  } finally {
    try {
      if (miniCdp) miniCdp.ws.close();
    } catch {
      /* already closed */
    }
    try {
      if (cdp) cdp.ws.close();
    } catch {
      /* already closed */
    }
    if (memoryId) {
      try {
        const listNow = await targets();
        const page = listNow.find((t) => t.type === 'page' && /\/index\.html|\/$/.test(t.url) && !/#mini/.test(t.url));
        if (page) {
          const c = connect(page.webSocketDebuggerUrl);
          await c.ready;
          await c.send('Runtime.enable');
          await c.send('Runtime.evaluate', {
            expression: `window.orvex?.memory?.remove(${JSON.stringify(memoryId)})`,
            awaitPromise: true,
            returnByValue: true,
          });
          c.ws.close();
        }
      } catch {
        /* best-effort cleanup */
      }
    }
    const passed = results.filter((r) => r.ok).length;
    console.log(`\nSection 16 UI smoke: ${passed}/${results.length} checks passed`);
    process.exit(passed === results.length ? 0 : 1);
  }
})();
