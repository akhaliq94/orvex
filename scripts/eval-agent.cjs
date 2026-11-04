'use strict';

/**
 * Section 18 — agent eval CLI against the live model gateway.
 *
 * Runs the app's own eval engine (the same one the Monitoring → Evals tab uses)
 * over the built-in "starter" suite. Credentials are read ONLY from environment
 * variables supplied for this process — never from the stored vault — and a run
 * without credentials reports an honest skip instead of faking results.
 *
 * Exit codes: 0 = every case passed, 1 = a case or the run failed, 2 = skipped
 * because no credentials/local endpoint were supplied (nothing was validated).
 *
 *   OPENAI_API_KEY=... node scripts/run-electron-smoke.mjs scripts/eval-agent.cjs
 *   ORVEX_EVAL_BASE_URL=http://localhost:11434/v1 ORVEX_EVAL_MODEL=llama3.1 \
 *     node scripts/run-electron-smoke.mjs scripts/eval-agent.cjs --suite=starter
 *
 * Flags: --suite=<id>  --provider=<id>  --model=<id>  --timeout=<ms>
 * Env:   ORVEX_EVAL_CANDIDATES (JSON array), ORVEX_EVAL_BASE_URL, ORVEX_EVAL_MODEL
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const gateway = require('../electron/model-gateway.cjs');
const monitor = require('../electron/monitor.cjs');
const db = require('../electron/db.cjs');

const HOSTED = [
  { id: 'openai', name: 'OpenAI', env: 'OPENAI_API_KEY', baseUrl: 'https://api.openai.com/v1', api: 'openai', model: 'gpt-4o-mini' },
  { id: 'anthropic', name: 'Anthropic', env: 'ANTHROPIC_API_KEY', baseUrl: 'https://api.anthropic.com/v1', api: 'anthropic', model: 'claude-haiku-4-5' },
  { id: 'google', name: 'Google Gemini', env: 'GEMINI_API_KEY', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', api: 'openai', model: 'gemini-2.5-flash' },
  { id: 'groq', name: 'Groq', env: 'GROQ_API_KEY', baseUrl: 'https://api.groq.com/openai/v1', api: 'openai', model: 'llama-3.3-70b-versatile' },
  { id: 'mistral', name: 'Mistral', env: 'MISTRAL_API_KEY', baseUrl: 'https://api.mistral.ai/v1', api: 'openai', model: 'mistral-small-latest' },
  { id: 'deepseek', name: 'DeepSeek', env: 'DEEPSEEK_API_KEY', baseUrl: 'https://api.deepseek.com/v1', api: 'openai', model: 'deepseek-chat' },
  { id: 'xai', name: 'xAI Grok', env: 'XAI_API_KEY', baseUrl: 'https://api.x.ai/v1', api: 'openai', model: 'grok-3-mini' },
  { id: 'openrouter', name: 'OpenRouter', env: 'OPENROUTER_API_KEY', baseUrl: 'https://openrouter.ai/api/v1', api: 'openai', model: 'anthropic/claude-sonnet-4.6' },
  { id: 'together', name: 'Together AI', env: 'TOGETHER_API_KEY', baseUrl: 'https://api.together.xyz/v1', api: 'openai', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' },
  { id: 'cerebras', name: 'Cerebras', env: 'CEREBRAS_API_KEY', baseUrl: 'https://api.cerebras.ai/v1', api: 'openai', model: 'llama3.1-8b' },
];

function flag(name, fallback = '') {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

/** Builds candidates from env only. Returns { candidates, skipped, reason }. */
function candidatesFromEnv() {
  const provider = flag('provider', process.env.ORVEX_EVAL_PROVIDER || '').trim();
  const modelOverride = flag('model', process.env.ORVEX_EVAL_MODEL || '').trim();

  if (process.env.ORVEX_EVAL_CANDIDATES) {
    let parsed;
    try {
      parsed = JSON.parse(process.env.ORVEX_EVAL_CANDIDATES);
    } catch {
      return { candidates: [], skipped: true, reason: 'ORVEX_EVAL_CANDIDATES is not valid JSON.' };
    }
    const candidates = gateway.normalizeCandidates(parsed);
    if (!candidates.length) return { candidates: [], skipped: true, reason: 'ORVEX_EVAL_CANDIDATES held no usable candidates.' };
    return { candidates, skipped: false };
  }

  const candidates = [];
  for (const preset of HOSTED) {
    if (provider && preset.id !== provider) continue;
    const key = process.env[preset.env];
    if (!key) continue;
    candidates.push({
      id: preset.id,
      presetId: preset.id,
      name: preset.name,
      baseUrl: preset.baseUrl,
      apiKey: key,
      api: preset.api,
      model: modelOverride || preset.model,
    });
  }

  const localUrl = (process.env.ORVEX_EVAL_BASE_URL || '').trim();
  const localModel = modelOverride || (process.env.ORVEX_EVAL_MODEL || '').trim();
  if ((!provider || provider === 'local') && localUrl && localModel) {
    candidates.push({
      id: 'local',
      presetId: 'custom',
      name: 'Local endpoint',
      baseUrl: localUrl,
      apiKey: '',
      api: 'openai',
      model: localModel,
    });
  }

  if (!candidates.length) {
    return {
      candidates: [],
      skipped: true,
      reason:
        'No model credentials were supplied. Set OPENAI_API_KEY (or ANTHROPIC_API_KEY / GEMINI_API_KEY / GROQ_API_KEY / ' +
        'MISTRAL_API_KEY / DEEPSEEK_API_KEY / XAI_API_KEY / OPENROUTER_API_KEY / TOGETHER_API_KEY / CEREBRAS_API_KEY), ' +
        'or ORVEX_EVAL_BASE_URL + ORVEX_EVAL_MODEL for a local server. Stored vault keys are never read by this CLI.',
    };
  }
  return { candidates, skipped: false };
}

function writeReport(report) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(__dirname, '..', 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const latest = path.join(dir, 'eval-latest.json');
  const archived = path.join(dir, `eval-${stamp}.json`);
  const text = `${JSON.stringify(report, null, 2)}\n`;
  fs.writeFileSync(latest, text, 'utf8');
  fs.writeFileSync(archived, text, 'utf8');
  return { latest, archived };
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orvex-eval-'));
  const dataDir = path.join(root, 'profile');
  fs.mkdirSync(dataDir, { recursive: true });

  const suiteId = flag('suite', process.env.ORVEX_EVAL_SUITE || 'starter').trim() || 'starter';
  const timeoutMs = Math.min(Math.max(Number(flag('timeout', '60000')) || 60000, 5000), 180000);
  const picked = candidatesFromEnv();

  try {
    monitor.init({ dataDir, gateway, sessionId: `eval-cli_${Date.now().toString(36)}` });

    if (picked.skipped) {
      const report = {
        generatedAt: new Date().toISOString(),
        skipped: true,
        reason: picked.reason,
        suite: { id: suiteId },
        candidates: [],
      };
      const paths = writeReport(report);
      console.log(`SKIP  agent eval — ${picked.reason}`);
      console.log(`report: ${paths.latest}`);
      // A skip validated nothing, so it must not look like a green run.
      process.exitCode = 2;
      return;
    }

    const suites = monitor.evalSuites().suites || [];
    const suite = suites.find((item) => item.id === suiteId);
    if (!suite) {
      throw new Error(`Eval suite "${suiteId}" was not found. Available: ${suites.map((s) => s.id).join(', ') || 'none'}.`);
    }

    console.log(`Running suite "${suite.name}" (${suite.caseCount} cases) against ${picked.candidates.length} model(s)\n`);

    const result = await monitor.evalRun({
      suiteId: suite.id,
      candidates: picked.candidates,
      timeoutMs,
      maxTokens: Number(process.env.ORVEX_EVAL_MAX_TOKENS) || 500,
    });

    for (const row of result.rows) {
      const failed = Array.isArray(row.detail && row.detail.checks) ? row.detail.checks.filter((c) => !c.ok) : [];
      const why = row.detail && row.detail.error ? row.detail.error : failed.map((c) => `${c.name}: ${c.detail || 'failed'}`).join('; ');
      console.log(`${row.ok ? 'PASS' : 'FAIL'}  ${row.caseId.padEnd(12)} ${row.model.padEnd(28)} ${String(row.ms).padStart(5)}ms${why ? ` — ${why}` : ''}`);
    }

    const { summary } = result;
    console.log(
      `\n${summary.passed}/${summary.runs} cases passed — score ${summary.score}, avg ${summary.avgMs}ms, models: ${summary.candidates.join(', ')}`,
    );

    const report = {
      generatedAt: new Date().toISOString(),
      skipped: false,
      suite: result.suite,
      candidates: picked.candidates.map((c) => ({ id: c.id, name: c.name, model: c.model, baseUrl: c.baseUrl })),
      summary,
      rows: result.rows,
    };
    const paths = writeReport(report);
    console.log(`report: ${paths.latest}`);
    process.exitCode = summary.failed ? 1 : 0;
  } catch (err) {
    const report = {
      generatedAt: new Date().toISOString(),
      skipped: false,
      error: String(err && err.message ? err.message : err),
      suite: { id: suiteId },
      candidates: picked.candidates.map((c) => ({ id: c.id, name: c.name, model: c.model, baseUrl: c.baseUrl })),
    };
    const paths = writeReport(report);
    console.error(`eval-agent failed: ${report.error}`);
    console.error(`report: ${paths.latest}`);
    process.exitCode = 1;
  } finally {
    try {
      db.close();
    } catch {
      /* never opened */
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
  }
})();
