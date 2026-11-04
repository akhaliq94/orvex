#!/usr/bin/env node
/**
 * Build a Windows release and publish it to the public channel.
 *
 *   npm run release -- 1.0.1
 *   npm run release -- 1.0.1 --dry-run
 *
 * Steps: validate version, require a clean tree, build installer + portable +
 * SHA256SUMS, verify the sums locally, commit the version bump, push the
 * private source, then create the release on the public repo with the three
 * assets. Any failing step stops the run before the next write.
 */

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const RELEASE_REPO = 'akhaliq94/orvex-releases';
const ROOT = path.resolve(import.meta.dirname, '..');
const RELEASE_DIR = path.join(ROOT, 'release');

function fail(message) {
  console.error(`\nrelease: ${message}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32', ...opts });
  if (result.error) fail(`${cmd} could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`${cmd} ${args.join(' ')} exited with ${result.status}`);
  return result;
}

function capture(cmd, args) {
  const result = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' });
  if (result.error) fail(`${cmd} could not start: ${result.error.message}`);
  return { ok: result.status === 0, out: String(result.stdout || '').trim(), err: String(result.stderr || '').trim() };
}

function ghBin() {
  const found = capture('gh', ['--version']);
  if (found.ok) return 'gh';
  const fallback = 'C:\\Program Files\\GitHub CLI\\gh.exe';
  if (fs.existsSync(fallback)) return fallback;
  fail('GitHub CLI (gh) is not installed. Install it and run gh auth login.');
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function assetPath(name) {
  const file = path.join(RELEASE_DIR, name);
  if (!fs.existsSync(file)) fail(`missing build artifact ${name}; did electron-builder finish?`);
  return file;
}

const version = String(process.argv[2] || '').replace(/^v/, '');
const dryRun = process.argv.includes('--dry-run');
if (!/^\d+\.\d+\.\d+$/.test(version)) fail('usage: npm run release -- <x.y.z> [--dry-run]');

const gh = ghBin();

const auth = capture(gh, ['auth', 'status']);
if (!auth.ok) fail('gh is not logged in. Run: gh auth login');

const clean = capture('git', ['status', '--porcelain']);
if (!clean.ok) fail('not a git repository');
if (clean.out) fail(`working tree is not clean:\n${clean.out}`);
if (dryRun) {
  console.log(`release: checks passed for v${version} (dry run, nothing built or published)`);
  process.exit(0);
}

const existing = capture(gh, ['release', 'view', `v${version}`, '--repo', RELEASE_REPO]);
if (existing.ok) fail(`v${version} already exists in ${RELEASE_REPO}`);

console.log(`\nrelease: setting version ${version}`);
run('npm', ['version', version, '--no-git-tag-version', '--allow-same-version']);

console.log('\nrelease: building installer, portable exe and checksums');
run('npm', ['run', 'dist']);

const sumsFile = path.join(RELEASE_DIR, 'SHA256SUMS.txt');
if (!fs.existsSync(sumsFile)) fail('SHA256SUMS.txt was not written');
const sums = new Map(
  fs
    .readFileSync(sumsFile, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [hash, name] = line.trim().split(/\s+\*?/);
      return [name, hash];
    }),
);
for (const [name, hash] of sums) {
  const actual = sha256(assetPath(name));
  if (actual !== hash) fail(`checksum mismatch for ${name}: file ${actual}, sums ${hash}`);
  console.log(`release: ${name} sha256 ok`);
}

console.log('\nrelease: committing and pushing the version bump');
run('git', ['add', 'package.json', 'package-lock.json']);
run('git', ['commit', '-m', `Release v${version}`]);
run('git', ['push', 'origin', 'HEAD:main']);

console.log('\nrelease: publishing to the public channel');
run(gh, [
  'release',
  'create',
  `v${version}`,
  ...sums.keys().map((name) => assetPath(name)).filter((file) => file.endsWith('.exe')),
  sumsFile,
  '--repo',
  RELEASE_REPO,
  '--title',
  `ORVEX ${version}`,
  '--notes',
  [
    `ORVEX ${version} - Windows x64 desktop agent.`,
    '',
    'Assets',
    `- ORVEX-Setup-${version}.exe - NSIS installer (per-user, choose install dir)`,
    `- ORVEX-Portable-${version}.exe - portable single exe`,
    '- SHA256SUMS.txt - the in-app updater refuses a download that does not match',
    '',
    'Honest notes',
    '- Unsigned build. Windows SmartScreen will warn; there is no code-signing certificate. Install at your own risk.',
    '- The updater verifies SHA-256 and installs only after you confirm.',
    '- Windows-first: macOS/Linux adapters exist but are not live-tested in Windows packaging.',
  ].join('\n'),
]);

console.log(`\nrelease: done - https://github.com/${RELEASE_REPO}/releases/tag/v${version}`);
