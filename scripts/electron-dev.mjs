import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5183;
const URL = `http://127.0.0.1:${PORT}`;

const vite = spawn(
  process.execPath,
  [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
  { cwd: root, stdio: 'inherit' },
);

let electron = null;

function shutdown(code = 0) {
  if (electron && !electron.killed) electron.kill();
  if (!vite.killed) vite.kill();
  process.exit(code);
}

vite.on('exit', (code) => {
  if (code && !electron) shutdown(code);
});

async function waitForServer(timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(URL);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  return false;
}

const up = await waitForServer(40000);
if (!up) {
  console.error(`[orvex] vite did not answer on ${URL}`);
  shutdown(1);
}

console.log(`[orvex] opening desktop shell on ${URL}`);
const env = { ...process.env, VITE_DEV_URL: URL };
// Some IDE terminals export ELECTRON_RUN_AS_NODE=1, which turns Electron into a
// plain Node process and makes the app crash on `app.getPath`.
delete env.ELECTRON_RUN_AS_NODE;

electron = spawn(electronPath, [root], {
  cwd: root,
  stdio: 'inherit',
  env,
});

electron.on('exit', (code) => {
  if (!vite.killed) vite.kill();
  process.exit(code ?? 0);
});

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
