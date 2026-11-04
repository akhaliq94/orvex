'use strict';

/**
 * Phase 12 — agent guard smoke: approval floors, progressive skill catalog and
 * the final-answer tripwire. Runs inside Electron-as-Node on a temp profile.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const db = require('../electron/db.cjs');
const approvalAdvisor = require('../electron/approval-advisor.cjs');
const learner = require('../electron/learner.cjs');
const permissions = require('../electron/permissions.cjs');
const security = require('../electron/security.cjs');
const tools = require('../electron/tools.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-guard-'));
const dataDir = path.join(root, 'profile');
fs.mkdirSync(dataDir, { recursive: true });

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  db.init({ file: path.join(dataDir, 'orvex.db') });
  learner.init({ dataDir, emit: () => {} });
  permissions.init({
    dataDir,
    registry: () => [
      { name: 'shell_exec', description: 'run a shell command' },
      { name: 'system_status', description: 'read system status' },
    ],
  });
  tools.init({ auditFile: path.join(root, 'audit.jsonl') });

  /* ---------------------------------- floors -------------------------------- */

  check('no floors at start', permissions.state().floors.length === 0);
  const added = permissions.addFloor({ tool: 'shell_exec', pattern: 'rm\\s+-rf', note: 'no recursive delete' });
  check('floor is stored', added.floors.length === 1 && added.counts.floors === 1);
  check('floor matches the call', /no recursive delete/.test(permissions.floorReason('shell_exec', { command: 'rm -rf C:\\data' }) || ''));
  check('floor does not leak to another tool', permissions.floorReason('system_status', { command: 'rm -rf x' }) === null);
  check('floor explains auto-approve immunity', /auto-approve/i.test(permissions.floorReason('shell_exec', { command: 'rm -rf x' }) || ''));

  let rejected = '';
  try {
    permissions.addFloor({ tool: 'shell_exec', pattern: '([' });
  } catch (err) {
    rejected = String(err.message);
  }
  check('invalid regex is refused', /valid regular expression/.test(rejected), rejected);

  permissions.addFloor({ tool: '*', pattern: 'never-in-a-tool-name', note: 'wildcard' });
  check('wildcard floor is listed', permissions.state().floors.length === 2);

  // A permission policy of allow and the agent's autoApprove must not bypass a
  // floor: runTool checks the floor before the handler and before approvals.
  permissions.setPolicy({ tool: 'system_status', policy: 'allow' });
  permissions.addFloor({ tool: 'system_status', pattern: 'system_status', note: 'status locked' });
  const floored = await tools.runTool('system_status', {}, { runId: 'smoke_floor' });
  check('tool execution is blocked by a floor', floored.ok === false && /approval floor/i.test(floored.error || ''), floored.error);

  const statusFloor = permissions.state().floors.find((f) => f.note === 'status locked');
  permissions.removeFloor(statusFloor.id);
  permissions.setPolicy({ tool: 'system_status', policy: 'default' });
  permissions.addFloor({ tool: 'system_status', pattern: 'not-this-call' });
  const nonMatching = await tools.runTool('system_status', {}, { runId: 'smoke_floor_2' });
  check('a non-matching floor does not block the tool', !/approval floor/i.test(nonMatching.error || ''));

  permissions.addFloor({ tool: 'shell_exec', pattern: 'format\\s+[a-z]:', note: 'no drive format' });
  permissions.reset();
  check('resetting tool policies keeps floors', permissions.state().floors.length >= 4 && permissions.state().counts.floors >= 4);

  await sleep(250);
  permissions.init({ dataDir, registry: () => [] });
  check('floors survive a restart', permissions.state().floors.some((f) => f.note === 'no recursive delete'));

  const removable = permissions.state().floors.find((f) => f.note === 'wildcard');
  const removed = permissions.removeFloor(removable.id);
  check('a floor can be removed', removed.removed === true && !permissions.state().floors.some((f) => f.id === removable.id));

  /* ----------------------------- approval advisor --------------------------- */

  approvalAdvisor._reset();
  approvalAdvisor.init({ dataDir, auditTail: (limit) => db.auditTail(limit) });
  check('no escalation rules at start', approvalAdvisor.state().rules.length === 0);
  check('an unruled call is not escalated', tools.escalationReason('shell_exec', { command: 'npm publish' }) === null);

  approvalAdvisor.add({ tool: 'shell_exec', pattern: 'npm\\s+publish', reason: 'publishes a package to the registry' });
  const escalated = tools.escalationReason('shell_exec', { command: 'npm publish --access public' });
  check('escalation matches the risky call', !!escalated && /publishes a package/.test(escalated.reason), escalated && escalated.reason);
  check('escalation does not leak to other tools', tools.escalationReason('sys_info', { command: 'npm publish' }) === null);
  check(
    'escalation forces approval even under auto-approve',
    approvalAdvisor.approvalMode({ risk: 'some risk', autoApprove: true, escalation: escalated }) === 'ask',
  );
  check(
    'ordinary risk still auto-approves without an escalation',
    approvalAdvisor.approvalMode({ risk: 'some risk', autoApprove: true, escalation: null }) === 'auto',
  );

  tools.audit({ kind: 'approval', tool: 'browser_open', args: '{"url":"https://bank.example"}', ok: false });
  tools.audit({ kind: 'approval', tool: 'browser_open', args: '{"url":"https://bank.example"}', ok: false });
  const learned = approvalAdvisor.learn();
  check('repeated refusals become a suggestion', learned.created.some((rule) => rule.tool === 'browser_open' && rule.status === 'suggested'));
  check('a suggestion stays inactive until accepted', tools.escalationReason('browser_open', { url: 'https://bank.example' }) === null);

  await sleep(250);
  approvalAdvisor.init({ dataDir, auditTail: () => [] });
  check('escalation rules survive a restart', /publishes a package/.test((tools.escalationReason('shell_exec', { command: 'npm publish' }) || {}).reason || ''));
  approvalAdvisor._reset();

  /* ------------------------------- skill catalog ---------------------------- */

  const skill = learner.saveSkill({
    name: 'Read a log tail',
    when: 'when the user asks what changed in a log file today',
    steps: [{ tool: 'fs_read', args: { path: 'C:\\logs\\app.log' } }, { tool: 'fs_write', args: { path: 'summary.md' } }],
    successCheck: 'The summary exists.',
    status: 'active',
  });
  const catalog = learner.skillCatalog(12);
  check('catalog lists one line per enabled skill', catalog.length === 1 && catalog[0].includes(skill.id));
  check('catalog line carries name, when and step count', catalog[0].includes('Read a log tail') && catalog[0].includes('2 steps'));
  check('catalog line is compact', catalog[0].split('\n').length === 1);

  const loaded = await tools.runTool('skill_load', { id: skill.id }, { runId: 'smoke_skill' });
  check('skill_load returns the full steps', loaded.ok === true && loaded.output.includes('1. fs_read') && loaded.output.includes('2. fs_write'));
  check('skill_load is read-only', learner.approvalReason('skill_load') === null);
  check('skill_load is registered with the agent', tools.definitions.some((def) => def.name === 'skill_load'));

  learner.setSkillStatus({ id: skill.id, status: 'disabled' });
  const disabledResult = await tools.runTool('skill_load', { id: skill.id }, { runId: 'smoke_skill_3' });
  check('disabled skill leaves the catalog', learner.skillCatalog(12).length === 0);
  check('disabled skill cannot be loaded', disabledResult.ok === false && /disabled/i.test(disabledResult.error || ''), disabledResult.error);

  const missing = await tools.runTool('skill_load', { id: 'skill_missing' }, { runId: 'smoke_skill_4' });
  check('unknown skill is refused', missing.ok === false && /No skill/.test(missing.error || ''));

  /* -------------------------------- tripwire -------------------------------- */

  security.setSecretValues(['plain-looking-vault-value']);
  const tripwire = security.outputTripwire('the key is sk-proj-abcdefghijklmnopqrstuvwx and the vault value is plain-looking-vault-value');
  check('tripwire finds the API key', tripwire.findings.includes('API key'));
  check('tripwire redacts every secret', !tripwire.text.includes('sk-proj-abcdefghijklmnopqrstuvwx') && !tripwire.text.includes('plain-looking-vault-value'));
  security.setSecretValues([]);

  const pem = security.outputTripwire('-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----');
  check('tripwire catches a private key', pem.findings.includes('private key') && pem.text.includes('[redacted-private-key]'));
  const clean = security.outputTripwire('Renamed three log files in D:/logs.');
  check('ordinary answers pass untouched', clean.findings.length === 0 && clean.text === 'Renamed three log files in D:/logs.');

  console.log(`\n${pass}/${pass + fail} checks passed`);
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* the profile is deleted by the OS temp cleaner */
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode || 0));
