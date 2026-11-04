'use strict';

/**
 * Section 10 Media page UI smoke over CDP.
 * Seeds real library assets through the bridge, then drives the page: tabs,
 * upscale, library filters/search/preview/rename/delete, prompt save/use,
 * subtitle editor, 3D metadata and the honest empty states for speech/video.
 *
 * Needs the ORVEX window running with --remote-debugging-port=9222.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

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
  let nextId = 1;
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', (e) => reject(e));
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
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { ws, send, ready };
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
  const work = path.join(os.tmpdir(), `orvex-media-ui-${Date.now().toString(36)}`);
  fs.mkdirSync(work, { recursive: true });
  const gltfPath = path.join(work, 'ui-smoke-model.gltf');
  fs.writeFileSync(
    gltfPath,
    JSON.stringify({
      asset: { version: '2.0', generator: 'ui-smoke' },
      scenes: [{ nodes: [0] }],
      nodes: [{ name: 'Root', mesh: 0 }],
      meshes: [{ name: 'Cube', primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [{ count: 12 }],
      materials: [{ name: 'Silver' }],
    }),
  );

  const png = await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 30, g: 180, b: 120 } } })
    .png()
    .toBuffer();
  const dataUrl = `data:image/png;base64,${png.toString('base64')}`;

  const list = await targets();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('No page target — is the ORVEX window open?');
  const cdp = connect(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');

  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      const detail = r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'evaluate failed';
      throw new Error(detail);
    }
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
  const clickButton = (text) =>
    evaluate(`(() => {
      const hit = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)});
      if (!hit) return false;
      hit.click();
      return true;
    })()`);
  const setValue = (selector, value) =>
    evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
      return el.value;
    })()`);
  const setField = (labelText, value) =>
    evaluate(`(() => {
      const field = [...document.querySelectorAll('.md-field')].find((f) => f.querySelector(':scope > span')?.textContent.includes(${JSON.stringify(labelText)}));
      const el = field && field.querySelector('input, textarea, select');
      if (!el) return false;
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
      return true;
    })()`);
  const setSelectByOption = (text, value) =>
    evaluate(`(() => {
      const hit = [...document.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.textContent.includes(${JSON.stringify(text)})));
      if (!hit) return false;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(hit, ${JSON.stringify(value)});
      hit.dispatchEvent(new Event('change', { bubbles: true }));
      return hit.value;
    })()`);
  const mediaEval = (body) =>
    evaluate(`(async () => {
      const api = window.orvex && window.orvex.media;
      if (!api) return { ok: false, error: 'no bridge' };
      ${body}
    })()`);
  const cardTitles = () => evaluate(`[...document.querySelectorAll('.md-asset-title')].map((n) => n.textContent.trim())`);

  const seeded = { assetIds: [], promptIds: [] };

  try {
    const exposed = await until(`!!window.orvex?.media && typeof window.orvex.media.library === 'function'`, 20000, 'the media bridge');
    check('media bridge is exposed', exposed === true);

    await until(`[...document.querySelectorAll('.nav-item')].some((n) => n.textContent.trim() === 'Media')`, 20000, 'the Media nav item');
    await clickText('.nav-item', 'Media', true);
    await until(`document.querySelector('.page-title')?.textContent === 'Media'`, 10000, 'the Media page');
    await until(`!!document.querySelector('.md-tabs')`, 10000, 'the media tabs');

    const tabs = await evaluate(`[...document.querySelectorAll('.md-tab')].map((n) => n.textContent.trim())`);
    check('seven media tools are listed', tabs.length === 7, JSON.stringify(tabs));
    check('tabs cover images, audio, video, subtitles, 3D, library and prompts', ['Images', 'Audio & Speech', 'Video', 'Subtitles', '3D Models', 'Library', 'Prompts'].every((t) => tabs.includes(t)), JSON.stringify(tabs));

    console.log('\n— seed the real library through the bridge');
    const seedResult = await mediaEval(`
      const image = await api.saveImage(${JSON.stringify(dataUrl)}, 'ui-smoke-cover');
      if (!image.ok) return { ok: false, error: 'image: ' + image.error };
      const note = await api.saveText('ui-smoke-note', 'note body', 'md');
      if (!note.ok) return { ok: false, error: 'text: ' + note.error };
      const sub = await api.saveSubtitle('ui-smoke-captions', '1\\n00:00:00,000 --> 00:00:02,000\\nSeed cue\\n', 'srt');
      if (!sub.ok) return { ok: false, error: 'subtitle: ' + sub.error };
      const model = await api.importFile(${JSON.stringify(gltfPath)});
      if (!model.ok) return { ok: false, error: 'model: ' + model.error };
      const prompt = await api.savePrompt({ title: 'UI Smoke Prompt', text: 'neon city at night, wet asphalt', kind: 'image', tags: ['ui', 'neon'] });
      if (!prompt.ok) return { ok: false, error: 'prompt: ' + prompt.error };
      return { ok: true, ids: [image.data.id, note.data.id, sub.data.id, model.data.id], promptId: prompt.data.id };
    `);
    check('library assets seeded through the bridge', seedResult?.ok === true, seedResult?.error || '');
    seeded.assetIds.push(...(seedResult?.ids || []));
    if (seedResult?.promptId) seeded.promptIds.push(seedResult.promptId);

    await until(`[...document.querySelectorAll('option')].some((o) => o.textContent.includes('ui-smoke-cover')) || [...document.querySelectorAll('.md-asset-title')].some((n) => n.textContent.includes('ui-smoke-cover'))`, 15000, 'the seeded image in the page');

    console.log('\n— images: local upscale, result grid');
    const picked = await setSelectByOption('ui-smoke-cover', (seedResult.ids || [])[0] || '');
    check('image picker lists the seeded asset', picked === (seedResult.ids || [])[0], String(picked));
    await clickButton('Upscale');
    await until(`[...document.querySelectorAll('.md-result span')].some((n) => n.textContent.includes('ui-smoke-cover-2x'))`, 20000, 'the upscaled result tile');
    const up = await mediaEval(`
      const r = await window.orvex.media.library({ query: 'ui-smoke-cover-2x' });
      if (!r.ok) return { ok: false, error: r.error };
      const row = r.data.assets[0];
      return { ok: true, meta: row && row.meta, name: row && row.name };
    `);
    check('upscale really doubled the pixels', up.ok && up.meta && up.meta.width === 80 && up.meta.height === 60, JSON.stringify(up.meta));
    if (up.ok) {
      const found = await mediaEval(`
        const r = await window.orvex.media.library({ query: 'ui-smoke-cover-2x' });
        return r.ok && r.data.assets[0] ? r.data.assets[0].id : '';
      `);
      if (found) seeded.assetIds.push(found);
    }

    console.log('\n— library: filters, search, preview, rename, delete');
    await clickText('.md-tab', 'Library', true);
    await until(`document.querySelectorAll('.md-asset-card').length >= 4`, 15000, 'the seeded asset cards');
    const allCount = await evaluate(`document.querySelectorAll('.md-asset-card').length`);
    check('library shows every seeded asset', allCount >= 4, `${allCount} cards`);

    await evaluate(`document.querySelector('[aria-label="Search media library"]').focus()`);
    await setValue('[aria-label="Search media library"]', 'ui-smoke-captions');
    await until(`document.querySelectorAll('.md-asset-card').length === 1`, 10000, 'the filtered library');
    check('library search narrows to the subtitle', (await cardTitles())[0]?.includes('ui-smoke-captions'), JSON.stringify(await cardTitles()));

    await setValue('[aria-label="Search media library"]', '');
    await clickText('.md-filter', '3D', true);
    await until(`document.querySelectorAll('.md-asset-card').length === 1 && document.querySelector('.md-kind')?.textContent === '3D'`, 10000, 'the 3D filter');
    check('kind filter isolates 3D models', (await cardTitles())[0]?.includes('ui-smoke-model'), JSON.stringify(await cardTitles()));
    await clickText('.md-filter', 'All', true);
    await until(`document.querySelectorAll('.md-asset-card').length >= 4`, 10000, 'all assets again');

    await evaluate(`document.querySelector('[aria-label="Preview ui-smoke-cover.png"]')?.click()`);
    await until(`!!document.querySelector('.md-preview')`, 5000, 'the preview dialog');
    check('preview renders the real image', await evaluate(`!!document.querySelector('.md-preview-body img')`));
    await evaluate(`document.querySelector('[aria-label="Close preview"]')?.click()`);
    await until(`!document.querySelector('.md-preview')`, 5000, 'the preview to close');

    await evaluate(`document.querySelector('[aria-label="Rename ui-smoke-cover.png"]')?.click()`);
    await until(`!!document.querySelector('.md-asset-card .md-inline input')`, 5000, 'the rename input');
    await setValue('.md-asset-card .md-inline input', 'ui-cover-renamed.png');
    await clickText('.md-asset-card .md-inline .btn-primary', 'Save', true);
    await until(`[...document.querySelectorAll('.md-asset-title')].some((n) => n.textContent.trim() === 'ui-cover-renamed.png')`, 10000, 'the renamed card');
    check('rename updates the asset card', true);

    await evaluate(`window.confirm = () => true`);
    await evaluate(`document.querySelector('[aria-label="Delete ui-cover-renamed.png"]')?.click()`);
    await until(`![...document.querySelectorAll('.md-asset-title')].some((n) => n.textContent.trim() === 'ui-cover-renamed.png')`, 10000, 'the deleted card');
    const gone = await mediaEval(`
      const r = await window.orvex.media.library({ query: 'ui-cover-renamed' });
      return r.ok ? r.data.total : -1;
    `);
    check('delete removes the asset from the library', gone === 0, String(gone));

    console.log('\n— prompts: save, favorite, use');
    await clickText('.md-tab', 'Prompts', true);
    await until(`!!document.querySelector('.md-prompt-card')`, 10000, 'the seeded prompt card');
    await setValue('.md-card textarea', 'a rainy neon alley, 35mm');
    await setValue('input[placeholder="Optional title"]', 'UI Prompt Two');
    await clickButton('Save prompt');
    await until(`[...document.querySelectorAll('.md-prompt-card h4')].some((n) => n.textContent.trim() === 'UI Prompt Two')`, 10000, 'the saved prompt card');
    check('prompt saved from the page', true);
    const promptRows = await mediaEval(`
      const r = await window.orvex.media.prompts({ query: 'UI Prompt Two' });
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, id: r.data.prompts[0] && r.data.prompts[0].id, text: r.data.prompts[0] && r.data.prompts[0].text };
    `);
    check('prompt text persisted', promptRows.ok && promptRows.text === 'a rainy neon alley, 35mm', JSON.stringify(promptRows));
    if (promptRows.ok && promptRows.id) seeded.promptIds.push(promptRows.id);

    await evaluate(`(() => {
      const card = [...document.querySelectorAll('.md-prompt-card')].find((c) => c.querySelector('h4')?.textContent.trim() === 'UI Smoke Prompt');
      card?.querySelector('.md-star')?.click();
    })()`);
    await until(`(() => {
      const card = [...document.querySelectorAll('.md-prompt-card')].find((c) => c.querySelector('h4')?.textContent.trim() === 'UI Smoke Prompt');
      return !!card?.querySelector('.md-star.on');
    })()`, 10000, 'the favorite star');
    check('favorite toggles on the real prompt row', true);

    await evaluate(`(() => {
      const card = [...document.querySelectorAll('.md-prompt-card')].find((c) => c.querySelector('h4')?.textContent.trim() === 'UI Smoke Prompt');
      [...card.querySelectorAll('footer button')].find((b) => b.textContent.trim() === 'Use')?.click();
    })()`);
    await until(`document.querySelector('.md-tab.active')?.textContent.includes('Images')`, 10000, 'the Images tab');
    const usedText = await evaluate(`document.querySelector('.md-card textarea')?.value || ''`);
    check('Use loads the prompt into the image studio', usedText.includes('neon city at night'), usedText);

    console.log('\n— subtitles: manual editor + asset loading');
    await clickText('.md-tab', 'Subtitles', true);
    await until(`!!document.querySelector('[aria-label="Subtitle text"]')`, 10000, 'the subtitle editor');
    check('subtitle tool explains the real ASR path', await evaluate(`document.querySelector('.md-card .md-hint')?.textContent.includes('ASR') === true`));
    const manual = '1\n00:00:00,000 --> 00:00:01,500\nUI smoke manual cue\n';
    await setValue('[aria-label="Subtitle text"]', manual);
    await setField('File name', 'ui-manual-captions');
    await clickButton('Save subtitle file');
    await until(`[...document.querySelectorAll('.md-list-name')].some((n) => n.textContent.includes('ui-manual-captions.srt'))`, 10000, 'the saved subtitle row');
    check('manual subtitle saved from the page', true);
    const savedSub = await mediaEval(`
      const r = await window.orvex.media.library({ kind: 'subtitle', query: 'ui-manual-captions' });
      if (!r.ok) return { ok: false, error: r.error };
      const row = r.data.assets[0];
      if (!row) return { ok: false, error: 'missing' };
      const text = await fetch(row.url).then((res) => res.text());
      return { ok: true, id: row.id, text };
    `);
    check('saved subtitle file contains the typed cue', savedSub.ok && savedSub.text.includes('UI smoke manual cue'), savedSub.text);
    if (savedSub.ok) seeded.assetIds.push(savedSub.id);

    await evaluate(`(() => {
      const row = [...document.querySelectorAll('.md-list-row')].find((r) => r.textContent.includes('ui-smoke-captions.srt'));
      [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Edit')?.click();
    })()`);
    await until(`document.querySelector('[aria-label="Subtitle text"]')?.value.includes('Seed cue')`, 10000, 'the loaded subtitle text');
    check('Edit loads a stored subtitle back into the editor', true);

    console.log('\n— 3D metadata and the honest audio/video states');
    await clickText('.md-tab', '3D Models', true);
    await until(`!!document.querySelector('.md-card')`, 5000, 'the 3D tab');
    const threeText = await evaluate(`document.body.textContent`);
    check('imported model is listed with real mesh metadata', threeText.includes('ui-smoke-model.gltf') && /1 meshes/.test(threeText));
    check('3D tool names every supported format', ['glTF', 'GLB', 'OBJ', 'STL', 'PLY', 'FBX'].every((f) => threeText.includes(f)));

    await clickText('.md-tab', 'Audio & Speech', true);
    await until(`!!document.querySelector('.md-audio-row') || document.body.textContent.includes('TTS studio')`, 5000, 'the audio tab');
    const audioText = await evaluate(`document.body.textContent`);
    check('TTS studio, music and transcription are present', ['TTS studio', 'Music & SFX', 'Transcription'].every((t) => audioText.includes(t)));
    const voice = await evaluate(`(() => {
      const cfg = JSON.parse(localStorage.getItem('orvex-voice-config') || '{}');
      const engine = cfg.engine || 'browser';
      const hasAsr = !!(cfg.asrUrl || (engine !== 'browser' && cfg.serverUrl));
      return { engine, hasAsr };
    })()`);
    check(
      'transcription reports its real endpoint state',
      voice.hasAsr ? audioText.includes('Endpoint: http') : audioText.includes('not configured'),
      JSON.stringify(voice),
    );
    check('saving speech is refused exactly when the browser voice is active', await evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Save audio');
      return !!b && b.disabled === ${voice.engine === 'browser'};
    })()`));

    await clickText('.md-tab', 'Video', true);
    await until(`document.body.textContent.includes('Video understanding')`, 5000, 'the video tab');
    check('video frame capture explains its real sampling', await evaluate(`document.body.textContent.includes('samples real frames')`));
    check('analyze needs captured frames first', await evaluate(`![...document.querySelectorAll('button')].some((b) => b.textContent.includes('Analyze with vision model'))`));
  } finally {
    await evaluate(`window.confirm = () => true`).catch(() => {});
    if (seeded.assetIds.length) {
      await mediaEval(`
        for (const id of ${JSON.stringify(seeded.assetIds)}) await window.orvex.media.remove(id);
        return { ok: true };
      `).catch(() => {});
    }
    if (seeded.promptIds.length) {
      await mediaEval(`
        for (const id of ${JSON.stringify(seeded.promptIds)}) await window.orvex.media.deletePrompt(id);
        return { ok: true };
      `).catch(() => {});
    }
    fs.rmSync(work, { recursive: true, force: true });
    cdp.ws.close();
  }

  console.log(`\n${pass} checks passed`);
  if (process.exitCode) console.log('UI smoke reported failures.');
}

main().catch((err) => {
  console.error('\nmedia UI smoke crashed:', err.message || err);
  process.exit(1);
});
