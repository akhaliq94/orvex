'use strict';

/**
 * Section 6 coding-agent smoke test.
 * Runs the real backend in plain Node against a throwaway git repo:
 * workspace state, tree/read/write/search, path containment, git
 * status/diff/stage/unstage/commit/log, script whitelist, streamed output,
 * terminal guardrails, stop, rename and delete.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const code = require('../electron/code.cjs');

let checks = 0;
function pass(label) {
  checks += 1;
  console.log(`  ok  ${label}`);
}

async function rejects(fn, label, pattern) {
  let error = null;
  try {
    await fn();
  } catch (err) {
    error = err;
  }
  assert.ok(error, `${label}: expected a rejection, got success`);
  if (pattern) assert.match(error.message, pattern, `${label}: ${error.message}`);
  pass(label);
}

function waitFor(pred, ms = 20000) {
  const found = events.find(pred);
  if (found) return Promise.resolve(found);
  return new Promise((resolve, reject) => {
    const waiter = { pred, resolve };
    waiters.add(waiter);
    const timer = setTimeout(() => {
      if (waiters.delete(waiter)) reject(new Error('Timed out waiting for a process event.'));
    }, ms);
    waiter.resolve = (evt) => {
      clearTimeout(timer);
      resolve(evt);
    };
  });
}

const events = [];
const waiters = new Set();
function emit(evt) {
  events.push(evt);
  for (const waiter of [...waiters]) {
    if (waiter.pred(evt)) {
      waiters.delete(waiter);
      waiter.resolve(evt);
    }
  }
}

function outputOf(runId) {
  return events
    .filter((e) => e.runId === runId && e.type === 'data')
    .map((e) => e.chunk)
    .join('');
}

async function main() {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'orvex-code-smoke-'));
  const profile = path.join(base, 'profile');
  const repo = path.join(base, 'repo');
  await fsp.mkdir(profile, { recursive: true });
  await fsp.mkdir(repo, { recursive: true });
  await fsp.writeFile(
    path.join(repo, 'package.json'),
    JSON.stringify(
      {
        name: 'orvex-code-smoke',
        private: true,
        scripts: { smoke: 'node smoke-run.cjs' },
      },
      null,
      2,
    ),
    'utf8',
  );
  await fsp.writeFile(
    path.join(repo, 'smoke-run.cjs'),
    "process.stdout.write('HELLO_FROM_SCRIPT\\n');\nsetTimeout(() => process.exit(0), 50);\n",
    'utf8',
  );
  await fsp.writeFile(path.join(repo, 'README.md'), '# smoke\nneedle in the readme\n', 'utf8');
  await fsp.writeFile(path.join(repo, '.gitignore'), 'node_modules\n', 'utf8');

  try {
    await code.init({ dataDir: profile, emit });
    pass('backend initializes without a workspace');

    const empty = await code.info();
    assert.equal(empty.root, null);
    pass('no folder is open at first');

    await rejects(() => code.list(''), 'list without a workspace is refused', /No folder is open/);

    const opened = await code.open(repo);
    assert.equal(fs.realpathSync.native(opened.root), fs.realpathSync.native(repo));
    assert.equal(opened.name, 'repo');
    assert.equal(opened.isGit, false);
    assert.deepEqual(opened.scripts.map((s) => s.name), ['smoke']);
    pass('open folder returns real info and detects package.json scripts');

    const rootList = await code.list('');
    const names = rootList.entries.map((e) => e.name);
    assert.ok(names.includes('package.json'));
    assert.ok(names.includes('README.md'));
    assert.ok(!names.includes('.git'), 'tree hides .git');
    assert.ok(!names.includes('node_modules'));
    pass('tree lists real entries and hides .git/node_modules');

    await code.write('src/main.js', 'const a = 1\nconst needle = a + 1\n');
    const subList = await code.list('src');
    assert.deepEqual(subList.entries.map((e) => e.name), ['main.js']);
    const read = await code.read('src/main.js');
    assert.equal(read.binary, false);
    assert.match(read.content, /needle = a \+ 1/);
    pass('write creates nested folders, list/read return the saved text');

    const search = await code.search('needle');
    assert.ok(search.matches.some((m) => m.path === 'src/main.js' && m.line === 2));
    assert.ok(search.matches.some((m) => m.path === 'README.md' && m.line === 2));
    pass('search finds matches with file and line numbers');

    await rejects(() => code.read('../outside.txt'), 'read cannot escape the workspace', /outside|escapes/);
    await rejects(() => code.write('../evil.txt', 'x'), 'write cannot escape the workspace', /outside|escapes/);
    await rejects(() => code.list('..'), 'list cannot escape the workspace', /outside/);
    await rejects(() => code.write('C:\\Windows\\evil.txt', 'x'), 'absolute paths are refused', /relative/);
    await rejects(() => code.remove(''), 'the workspace root cannot be deleted', /root/);
    pass('path containment guards traversal, absolute paths and root deletion');

    const renamed = await code.rename('src/main.js', 'src/app.js');
    assert.equal(renamed.to, 'src/app.js');
    assert.match((await code.read('src/app.js')).content, /needle/);
    await code.remove('src/app.js');
    await rejects(() => code.read('src/app.js'), 'deleted files are gone', /ENOENT|no such file/i);
    pass('rename and delete work inside the workspace');

    const init = await code.gitInit();
    assert.equal(init.created, true);
    execFileSync('git', ['config', 'user.email', 'smoke@orvex.local'], { cwd: repo, windowsHide: true });
    execFileSync('git', ['config', 'user.name', 'ORVEX Smoke'], { cwd: repo, windowsHide: true });
    pass('git init runs against the real git binary');

    const status = await code.gitStatus();
    assert.equal(status.git, true);
    assert.ok(status.branch, 'branch name is detected');
    const paths = status.entries.map((e) => e.path);
    assert.ok(paths.includes('package.json'));
    assert.ok(status.entries.every((e) => e.untracked));
    pass('git status reports untracked files and the branch');

    await code.gitStage(['package.json', 'smoke-run.cjs', 'README.md', '.gitignore']);
    const stagedStatus = await code.gitStatus();
    const stagedPkg = stagedStatus.entries.find((e) => e.path === 'package.json');
    assert.ok(stagedPkg && stagedPkg.staged && !stagedPkg.unstaged);
    pass('stage moves entries into the index');

    const stagedDiff = await code.gitDiff({ path: 'package.json', staged: true });
    assert.match(stagedDiff.diff, /\+.*"smoke"/);
    assert.equal(stagedDiff.staged, true);
    pass('staged diff shows the new package.json');

    await code.gitCommit('initial smoke commit');
    const afterCommit = await code.gitStatus();
    assert.equal(afterCommit.entries.length, 0);
    pass('commit empties the working tree');

    await code.write('README.md', '# smoke\nneedle plus a change\n');
    const dirty = await code.gitStatus();
    const readme = dirty.entries.find((e) => e.path === 'README.md');
    assert.ok(readme && readme.unstaged && !readme.untracked);
    const workingDiff = await code.gitDiff({ path: 'README.md', staged: false });
    assert.match(workingDiff.diff, /\+needle plus a change/);
    pass('working-tree diff shows edits after a commit');

    await code.gitStage(['README.md']);
    await code.gitUnstage(['README.md']);
    const unstaged = (await code.gitStatus()).entries.find((e) => e.path === 'README.md');
    assert.ok(unstaged && !unstaged.staged && unstaged.worktree === 'M');
    pass('unstage returns a change to the working tree');

    const log = await code.gitLog(5);
    assert.ok(log.entries.length >= 1);
    assert.match(log.entries[0].hash, /^[0-9a-f]{7,}$/);
    assert.equal(log.entries[0].subject, 'initial smoke commit');
    pass('git log lists real commits');

    await rejects(() => code.runScript('not-a-script'), 'unknown scripts are refused', /not a script/);
    const script = await code.runScript('smoke');
    const scriptExit = await waitFor((e) => e.runId === script.runId && e.type === 'exit');
    assert.equal(scriptExit.code, 0);
    assert.match(outputOf(script.runId), /HELLO_FROM_SCRIPT/);
    assert.ok(events.some((e) => e.runId === script.runId && e.type === 'start' && e.kind === 'script'));
    pass('only package.json scripts run, with streamed stdout and exit code');

    const term = await code.terminal('node --version');
    const termExit = await waitFor((e) => e.runId === term.runId && e.type === 'exit');
    assert.equal(termExit.code, 0);
    assert.match(outputOf(term.runId), /^v\d+\./);
    assert.ok(events.some((e) => e.runId === term.runId && e.type === 'start' && e.kind === 'terminal'));
    pass('terminal streams real command output');

    await rejects(() => code.terminal('format c: /q'), 'dangerous commands stay blocked', /Blocked/);
    await rejects(() => code.terminal('echo hi', '..'), 'terminal cwd cannot leave the workspace', /outside/);
    pass('terminal guardrails and cwd containment hold');

    const long = await code.terminal('node -e "setInterval(function(){}, 1000)"');
    await waitFor((e) => e.runId === long.runId && e.type === 'start');
    await new Promise((r) => setTimeout(r, 350));
    const stopped = await code.stop(long.runId);
    assert.equal(stopped.stopped, true);
    const stopExit = await waitFor((e) => e.runId === long.runId && e.type === 'exit');
    assert.equal(stopExit.stopped, true);
    pass('stop terminates a running command');

    await code.close();
    assert.equal((await code.info()).root, null);
    pass('close forgets the workspace');

    const reopened = await code.open(repo);
    assert.equal(fs.realpathSync.native(reopened.root), fs.realpathSync.native(repo));
    pass('workspace choice persists in the profile');

    console.log(`\nSection 6 code backend: ${checks}/${checks} checks passed.`);
  } finally {
    code.dispose();
    await fsp.rm(base, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error('\nCODE SMOKE FAILED:', err && err.stack ? err.stack : err);
  code.dispose();
  process.exit(1);
});
