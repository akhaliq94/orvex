'use strict';

/**
 * Section 6 Code page UI smoke test over CDP.
 * Opens a real temp git repo through the bridge, then drives the rendered page:
 * tree, editor save to disk, search, staging, diff, commit, script run with
 * streamed output, terminal, and the dangerous-command guard.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

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
    pass++;
  } else {
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    process.exitCode = 1;
  }
}

async function main() {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'orvex-code-ui-'));
  const repo = path.join(base, 'repo');
  await fsp.mkdir(path.join(repo, 'src'), { recursive: true });
  await fsp.writeFile(path.join(repo, 'package.json'), JSON.stringify({
    name: 'orvex-code-ui-smoke',
    private: true,
    scripts: { smoke: 'node ui-script.cjs' },
  }, null, 2), 'utf8');
  await fsp.writeFile(path.join(repo, 'ui-script.cjs'), "process.stdout.write('UI_SCRIPT_OK\\n');\n", 'utf8');
  await fsp.writeFile(path.join(repo, 'hello.txt'), 'hello from the ui smoke\nneedle line\n', 'utf8');
  await fsp.writeFile(path.join(repo, 'src', 'app.js'), 'export const answer = 42\n', 'utf8');
  execFileSync('git', ['init', '-q'], { cwd: repo, windowsHide: true });
  execFileSync('git', ['config', 'user.email', 'ui@orvex.local'], { cwd: repo, windowsHide: true });
  execFileSync('git', ['config', 'user.name', 'ORVEX UI'], { cwd: repo, windowsHide: true });
  execFileSync('git', ['add', '.'], { cwd: repo, windowsHide: true });
  execFileSync('git', ['commit', '-q', '-m', 'ui baseline'], { cwd: repo, windowsHide: true });

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
      const v = await evaluate(expression);
      if (v) return v;
      await sleep(300);
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

  try {
    const opened = await evaluate(`window.orvex.code.openPath(${JSON.stringify(repo)})`);
    check('bridge opens a real workspace folder', !!(opened && opened.ok && opened.data.root), opened && opened.data ? opened.data.root : opened && opened.error);

    await clickText('.nav-item', 'Code', true);
    await until(`document.querySelector('.page-title')?.textContent === 'Code'`, 10000, 'the Code page');

    await until(`!!document.querySelector('.code-layout')`, 10000, 'the workspace layout');
    await until(`document.querySelectorAll('.code-file-row').length >= 4`, 10000, 'the file tree');
    const shell = await evaluate(`(() => ({
      title: document.querySelector('.page-title')?.textContent,
      root: document.querySelector('.code-root')?.textContent || '',
      rows: [...document.querySelectorAll('.code-file-row')].map((r) => r.textContent),
      branch: document.querySelector('.code-chip')?.textContent || '',
      tabs: [...document.querySelectorAll('.code-right-tabs button')].map((b) => b.textContent.trim()),
      error: document.querySelector('.code-error')?.textContent || '',
    }))()`);
    check('Code page shows the opened workspace', shell.title === 'Code' && shell.root.includes('repo'));
    check(
      'file tree lists the real project',
      ['package.json', 'hello.txt', 'src', 'ui-script.cjs'].every((n) => shell.rows.some((r) => r.includes(n))),
      shell.rows.join(' | '),
    );
    check('git tab, run tab and review tab render', shell.tabs.some((t) => t.includes('Git')) && shell.tabs.some((t) => t.includes('Run')) && shell.tabs.some((t) => t.includes('Review')), shell.tabs.join(', '));

    const openedFile = await clickText('.code-file-row', 'hello.txt');
    await until(`document.querySelector('.code-textarea')?.value.includes('hello from the ui smoke')`, 10000, 'hello.txt in the editor');
    check('clicking a file loads its real content', openedFile);
    check('editor shows line numbers', await evaluate(`document.querySelectorAll('.code-lines span').length >= 2`));

    const before = fs.readFileSync(path.join(repo, 'hello.txt'), 'utf8');
    await setValue('.code-textarea', `${before}ui save line\n`);
    await until(`!!document.querySelector('.code-dirty')`, 5000, 'the dirty marker');
    check('editing marks the tab dirty', true);
    await evaluate(`document.querySelector('.code-editor-bar button[title^="Save"]')?.click()`);
    await until(`!document.querySelector('.code-dirty')`, 8000, 'the save to finish');
    const after = fs.readFileSync(path.join(repo, 'hello.txt'), 'utf8');
    check('save writes the edit to disk', after.includes('ui save line'));

    await setValue('.code-search input', 'needle');
    await evaluate(`document.querySelector('.code-search')?.requestSubmit()`);
    await until(`!!document.querySelector('.code-hit')`, 10000, 'search results');
    const hit = await evaluate(`document.querySelector('.code-hit')?.textContent || ''`);
    check('search results show file, line and text', hit.includes('hello.txt:2') && hit.includes('needle'), hit);

    await clickText('.code-right-tabs button', 'Git');
    await until(`!!document.querySelector('.code-change')`, 10000, 'a changed file');
    await clickText('.code-change-name', 'hello.txt');
    await until(`(document.querySelector('.code-diff')?.textContent || '').includes('ui save line')`, 8000, 'the working diff');
    check('git diff renders the edit', true);
    const gitState = await evaluate(`window.orvex.code.gitStatus()`);
    check('status sees the edited file', gitState.ok && gitState.data.entries.some((e) => e.path === 'hello.txt' && e.unstaged));

    await evaluate(`(() => {
      const row = [...document.querySelectorAll('.code-change')].find((r) => r.textContent.includes('hello.txt'));
      const btn = row && [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === 'stage');
      if (btn) btn.click();
      return !!btn;
    })()`);
    await until(`(async () => {
      const s = await window.orvex.code.gitStatus();
      return s.ok && s.data.entries.some((e) => e.path === 'hello.txt' && e.staged);
    })()`, 10000, 'hello.txt to be staged');
    check('stage button moves the change into the index', true);

    await setValue('.code-commit textarea', 'ui smoke commit');
    await until(`document.querySelector('.code-commit button[type="submit"]')?.disabled === false`, 5000, 'the commit button');
    await evaluate(`document.querySelector('.code-commit button[type="submit"]')?.click()`);
    await until(`(async () => {
      const l = await window.orvex.code.gitLog(3);
      return l.ok && l.data.entries.some((e) => e.subject === 'ui smoke commit');
    })()`, 15000, 'the commit');
    await until(`(document.querySelector('.code-log')?.textContent || '').includes('ui smoke commit')`, 8000, 'the commit in the recent-commits log');
    check('commit from the UI lands in git log', true);

    await clickText('.code-right-tabs button', 'Run');
    await until(`!!document.querySelector('.code-script-name')`, 8000, 'package.json scripts');
    await clickText('.code-script-name', 'smoke');
    await until(`(document.querySelector('#code-run-console')?.textContent || '').includes('UI_SCRIPT_OK')`, 30000, 'the script output');
    await until(`(document.querySelector('.code-run-state')?.textContent || '').includes('exit 0')`, 15000, 'the script exit state');
    check('package.json script runs with streamed output', true);

    await setValue('.code-terminal input', 'node --version');
    await evaluate(`document.querySelector('.code-terminal')?.requestSubmit()`);
    await until(`/^v\\d+\\./.test(document.querySelector('#code-run-console')?.textContent || '')`, 20000, 'the terminal output');
    check('terminal runs a real command in the workspace', true);

    await setValue('.code-terminal input', 'format c: /q');
    await evaluate(`document.querySelector('.code-terminal')?.requestSubmit()`);
    await until(`(document.querySelector('.code-error')?.textContent || '').includes('Blocked')`, 10000, 'the guard error');
    check('dangerous commands are refused in the terminal', true);
    await evaluate(`document.querySelector('.code-error button')?.click()`);

    await clickText('.code-right-tabs button', 'Review');
    const review = await evaluate(`(() => ({
      button: [...document.querySelectorAll('.code-review-actions button')].some((b) => b.textContent.includes('Review diff')),
      text: document.querySelector('.code-review')?.textContent || '',
    }))()`);
    check('review panel is wired to the active provider', review.button && /No review yet|Sends the current git diff/.test(review.text));

    const exceptions = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown');
    check('no renderer exceptions on the Code page', exceptions.length === 0, exceptions.map((e) => e.params?.exceptionDetails?.text).join('; '));

    console.log(`\nSection 6 Code UI: ${pass} checks passed.`);
  } finally {
    await evaluate(`window.orvex.code.close()`).catch(() => {});
    cdp.ws.close();
    await fsp.rm(base, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error('\nCODE UI SMOKE FAILED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
