import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const bin =
  process.platform === 'win32'
    ? 'node_modules/electron/dist/electron.exe'
    : 'node_modules/electron/dist/electron';
const electron = path.join(root, bin);
const script = process.argv[2];
const extra = process.argv.slice(3);

if (!script) {
  console.error('usage: node scripts/run-electron-smoke.mjs <script.cjs> [args...]');
  process.exit(2);
}

const result = spawnSync(electron, [path.resolve(root, script), ...extra], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});

process.exit(result.status ?? 1);
