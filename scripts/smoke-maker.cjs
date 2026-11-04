'use strict';

/**
 * Phase 10 — Maker smoke.
 * Scaffolds real projects in a temporary profile, serves a live preview over
 * HTTP, edits and reloads it, exports a zip and runs a generated CLI.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const maker = require('../electron/maker.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-maker-'));
const dataDir = path.join(root, 'profile');

let pass = 0;
let fail = 0;

function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    process.exitCode = 1;
  }
}

(async () => {
  maker.init({ dataDir, emit: () => {} });
  check('init starts empty', maker.list().projects.length === 0);
  check('six templates are offered', maker.templates().length === 6);

  const site = await maker.create({ template: 'website', name: 'Smoke Site', title: 'Smoke <test>', description: 'Smoke project.' });
  check('website scaffold writes files', site.files.includes('index.html') && fs.existsSync(path.join(site.dir, 'index.html')), site.dir);
  const index = fs.readFileSync(path.join(site.dir, 'index.html'), 'utf8');
  check('page copy is escaped', index.includes('Smoke &lt;test&gt;') && !index.includes('Smoke <test>'));
  check('palette tokens are generated', fs.readFileSync(path.join(site.dir, 'styles.css'), 'utf8').includes('--brand:'));

  const preview = await maker.preview(site.id);
  const page = await fetch(preview.url);
  check('preview serves index.html', page.ok && (await page.text()).includes('Smoke &lt;test&gt;'));
  const post = await fetch(preview.url, { method: 'POST' });
  check('preview rejects writes', post.status === 405);

  await maker.writeFile(site.id, 'index.html', index.replace('Smoke &lt;test&gt;', 'Edited heading'));
  const edited = await (await fetch(preview.url)).text();
  check('preview reloads edited files', edited.includes('Edited heading'));

  const zip = await maker.exportZip(site.id);
  check('export writes a real zip', fs.existsSync(zip.file) && zip.bytes > 500, `${zip.bytes} bytes`);
  check('zip contains the source', fs.readFileSync(zip.file).includes(Buffer.from('styles.css')));

  const cli = await maker.create({ template: 'node-cli', name: 'Smoke Counter' });
  const help = await maker.run(cli.id, ['--help']);
  check('generated Node CLI runs', help.ok === true && help.stdout.includes('Usage:'), `exit ${help.code}`);
  const counted = await maker.run(cli.id, ['README.md', '--json']);
  check('generated CLI returns JSON', counted.ok === true && JSON.parse(counted.stdout).words > 0);

  await maker.stopPreview(site.id);
  await maker.remove(site.id);
  await maker.remove(cli.id);
  check('projects are removed with their folders', maker.list().projects.length === 0 && !fs.existsSync(site.dir));

  await maker.stopAll();
  fs.rmSync(root, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
