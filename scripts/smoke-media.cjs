'use strict';

/**
 * Media backend end-to-end test. Starts a local fake provider that speaks the
 * OpenAI image / chat-vision / ASR / TTS shapes plus Gemini and OpenRouter, so
 * every network path is exercised without a real key.
 *
 * Run: node scripts/smoke-media.cjs
 */

const fsp = require('node:fs/promises');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const sharp = require('sharp');

const creative = require('../electron/creative.cjs');

let pass = 0;
let fail = 0;

function check(name, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`  ok  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`);
  }
}

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, `got ${a}, expected ${e}`);
}

async function expectThrow(name, fn, includes) {
  try {
    await fn();
    check(name, false, 'no error thrown');
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    check(name, !includes || message.toLowerCase().includes(includes.toLowerCase()), message);
  }
}

async function main() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'orvex-media-'));
  const dataDir = path.join(root, 'appdata');
  const work = path.join(root, 'work');
  await fsp.mkdir(work, { recursive: true });

  const png = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 24, g: 110, b: 200 } } })
    .png()
    .toBuffer();
  const jpg = await sharp({ create: { width: 32, height: 20, channels: 3, background: { r: 200, g: 80, b: 40 } } })
    .jpeg()
    .toBuffer();
  const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(256, 0)]);

  const seen = { requests: [] };
  const origin = { value: '' };

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, origin.value);
    seen.requests.push({ method: req.method, path: url.pathname, auth: req.headers.authorization || '', type: req.headers['content-type'] || '' });
    const json = (status, value, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type });
      res.end(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
    };

    if (req.method === 'GET' && url.pathname === '/files/gen.png') return json(200, png, 'image/png');
    if (req.method === 'GET' && url.pathname === '/files/song.mp3') return json(200, mp3, 'audio/mpeg');

    if (url.pathname === '/v1/images/generations') {
      const payload = JSON.parse(body.toString('utf8') || '{}');
      if (payload.response_format) {
        return json(400, { error: { message: 'response_format is unsupported for this model' } });
      }
      if (payload.model === 'url-model') {
        return json(200, { data: [{ url: `${origin.value}/files/gen.png` }] });
      }
      const count = Math.max(1, Math.min(Number(payload.n) || 1, 4));
      return json(200, { data: Array.from({ length: count }, () => ({ b64_json: png.toString('base64') })) });
    }

    if (url.pathname === '/v1/images/edits') {
      if (!String(req.headers['content-type']).includes('multipart/form-data')) {
        return json(400, { error: 'expected multipart' });
      }
      return json(200, { data: [{ b64_json: png.toString('base64') }] });
    }

    if (url.pathname === '/generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent') {
      if (url.searchParams.get('key') !== 'gm-key') return json(401, { error: 'bad key' });
      return json(200, {
        candidates: [{ content: { parts: [{ text: 'here you go' }, { inlineData: { mimeType: 'image/png', data: png.toString('base64') } }] } }],
      });
    }

    if (url.pathname === '/openrouter.ai/api/v1/chat/completions') {
      const payload = JSON.parse(body.toString('utf8') || '{}');
      if (Array.isArray(payload.modalities)) {
        return json(200, {
          choices: [{ message: { role: 'assistant', images: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } }] } }],
        });
      }
      return json(200, { choices: [{ message: { role: 'assistant', content: 'chat ok' } }] });
    }

    if (url.pathname === '/asr/verbose') {
      return json(200, {
        text: 'Hello world this is a subtitle test of the media page',
        language: 'en',
        duration: 2.4,
        segments: [
          { start: 0, end: 1.2, text: 'Hello world' },
          { start: 1.2, end: 2.4, text: 'this is a subtitle test of the media page' },
        ],
      });
    }
    if (url.pathname === '/asr/plain') {
      const raw = body.toString('latin1');
      if (/verbose_json/.test(raw)) return json(400, { error: { message: 'response_format verbose_json is not supported' } });
      return json(200, { text: 'plain transcript only' });
    }

    if (url.pathname === '/tts') {
      return json(200, mp3, 'audio/mpeg');
    }
    if (url.pathname === '/music/json') {
      return json(200, { audio_url: `${origin.value}/files/song.mp3` });
    }
    if (url.pathname === '/music/direct') {
      return json(200, mp3, 'audio/mpeg');
    }

    return json(404, { error: `no route ${url.pathname}` });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  origin.value = `http://127.0.0.1:${port}`;

  const events = [];
  let gatewayPayload = null;
  const gateway = {
    async chat(payload) {
      gatewayPayload = payload;
      return { text: 'A blue test frame with no text.', provider: { name: 'Fake Vision', model: 'fake-vl' }, model: 'fake-vl', usage: { total_tokens: 21 } };
    },
  };

  await creative.init({ dataDir, gateway, emit: (event) => events.push(event) });

  console.log('\n— init & library');
  const info = creative.info();
  check('info is ready', info.ready === true, JSON.stringify(info));
  check('library dir created', fs.existsSync(info.libraryDir), info.libraryDir);

  const sourceImage = path.join(work, 'source.png');
  await fsp.writeFile(sourceImage, png);
  const imported = await creative.importAsset({ path: sourceImage });
  check('import keeps the image kind', imported.kind === 'image', imported.kind);
  check('import reads real dimensions', imported.meta && imported.meta.width === 64 && imported.meta.height === 48, JSON.stringify(imported.meta));
  check('import emits an add event', events.some((e) => e.type === 'add' && e.asset && e.asset.id === imported.id));
  check('asset url uses the media scheme', imported.url === `orvex-media://asset/${imported.id}`, imported.url);

  const lib = await creative.library({ kind: 'image', query: 'source' });
  eq('library filters by kind and query', lib.assets.map((a) => a.id), [imported.id]);
  const miss = await creative.library({ kind: 'audio' });
  eq('kind filter excludes images', miss.total, 0);

  console.log('\n— openai image generation');
  const openai = { id: 'fake', name: 'Fake OpenAI', api: 'openai', baseUrl: `${origin.value}/v1`, apiKey: 'sk-test', model: 'gpt-4o' };
  const gen = await creative.generateImage({ provider: openai, prompt: 'a blue square', model: 'gpt-image-1', n: 2, size: '512x512' });
  eq('generates the requested count', gen.assets.length, 2);
  check('generated asset is an image with pixels', gen.assets[0].kind === 'image' && gen.assets[0].meta.width === 64);
  check('generated asset records the model', gen.assets[0].model === 'gpt-image-1', gen.assets[0].model);
  check('response_format fallback reached the server', seen.requests.filter((r) => r.path === '/v1/images/generations').length >= 2);

  const urlGen = await creative.generateImage({ provider: openai, prompt: 'download from url', model: 'url-model' });
  check('downloads an image returned as a URL', urlGen.assets[0].bytes === png.length, `${urlGen.assets[0].bytes} vs ${png.length}`);

  const gemini = { id: 'gem', name: 'Gemini', api: 'openai', baseUrl: `${origin.value}/generativelanguage.googleapis.com/v1beta`, apiKey: 'gm-key', model: 'gemini-2.5-flash' };
  const gemGen = await creative.generateImage({ provider: gemini, prompt: 'a gemini image' });
  check('gemini inline image is saved', gemGen.assets[0].bytes > 0 && gemGen.model === 'gemini-2.5-flash-image', gemGen.model);

  const router = { id: 'or', name: 'OpenRouter', api: 'openai', baseUrl: `${origin.value}/openrouter.ai/api/v1`, apiKey: 'or-key', model: 'x' };
  const routerGen = await creative.generateImage({ provider: router, prompt: 'an openrouter image', model: 'google/gemini-2.5-flash-image' });
  check('openrouter message.images are saved', routerGen.assets[0].kind === 'image');

  await expectThrow('openai without a key is refused', () => creative.generateImage({ provider: { ...openai, apiKey: '' }, prompt: 'x', model: 'gpt-image-1' }), 'no api key');
  await expectThrow('anthropic cannot generate images', () => creative.generateImage({ provider: { id: 'a', name: 'Anthropic', api: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', apiKey: 'k' }, prompt: 'x' }), 'does not serve image');
  await expectThrow('empty prompt is refused', () => creative.generateImage({ provider: openai, prompt: '   ' }), 'write a prompt');

  console.log('\n— edit, background removal, upscale');
  const edited = await creative.editImage({ provider: openai, prompt: 'make it stormy', assetId: imported.id });
  check('edit saves a new asset', edited.assets.length === 1 && edited.assets[0].id !== imported.id);
  check('edit asset records its source', edited.assets[0].source === 'edit', edited.assets[0].source);
  check('edit asset keeps the prompt', edited.assets[0].prompt === 'make it stormy');

  const cut = await creative.removeBackground({ provider: openai, assetId: imported.id });
  check('background removal returns an asset', cut.assets[0].kind === 'image');

  const up = await creative.upscaleImage({ assetId: imported.id, factor: 2, sharpen: true });
  eq('upscale doubles real dimensions', [up.from.width, up.from.height, up.to.width, up.to.height], [64, 48, 128, 96]);
  check('upscale asset is saved', up.asset.bytes > png.length);

  const up3 = await creative.upscaleImage({ path: sourceImage, factor: 8, sharpen: false });
  eq('upscale clamps to 8x', [up3.to.width, up3.to.height], [512, 384]);

  console.log('\n— vision analysis');
  const analysis = await creative.analyzeImages({ candidates: [openai], prompt: 'what is in the frame?', images: [{ mime: 'image/png', data: png.toString('base64') }] });
  check('analysis returns model text', analysis.text === 'A blue test frame with no text.', analysis.text);
  check('gateway received the image payload', gatewayPayload && gatewayPayload.history[0].images.length === 1 && gatewayPayload.task === 'vision');
  await expectThrow('vision without images is refused', () => creative.analyzeImages({ candidates: [openai], prompt: 'x', images: [] }), 'no image');

  console.log('\n— transcription & subtitles');
  const audioFile = path.join(work, 'clip.mp3');
  await fsp.writeFile(audioFile, mp3);
  const tr = await creative.transcribe({ url: `${origin.value}/asr/verbose`, key: 'stt-key', path: audioFile, language: 'en' });
  eq('transcript segments parsed', tr.segments.map((s) => s.text), ['Hello world', 'this is a subtitle test of the media page']);
  check('transcript language reported', tr.language === 'en', tr.language);
  check('transcript duration reported', tr.duration === 2.4, String(tr.duration));
  check('auth header forwarded to ASR', seen.requests.some((r) => r.path === '/asr/verbose' && r.auth === 'Bearer stt-key'));

  const trPlain = await creative.transcribe({ url: `${origin.value}/asr/plain`, path: audioFile });
  check('plain JSON fallback works', trPlain.text === 'plain transcript only', trPlain.text);
  check('fallback produced one segment', trPlain.segments.length === 1);

  const srt = creative.buildSubtitles({ segments: tr.segments, format: 'srt', maxChars: 42 });
  check('SRT starts with cue 1', srt.text.startsWith('1\n00:00:00,000 --> '), srt.text.slice(0, 30));
  check('SRT splits the long segment into cues', srt.cues >= 3, String(srt.cues));
  const textLines = srt.text
    .split('\n')
    .filter((line) => line && !/^\d+$/.test(line) && !line.includes('-->'));
  check('SRT wraps every text line', textLines.every((line) => line.length <= 42), String(Math.max(...textLines.map((l) => l.length))));

  const vtt = creative.buildSubtitles({ segments: tr.segments, format: 'vtt', maxChars: 20 });
  check('VTT starts with WEBVTT', vtt.text.startsWith('WEBVTT\n\n'));
  check('VTT uses dot timestamps', vtt.text.includes(' --> ') && !vtt.text.includes(',000 -->'));

  const subFile = await creative.subtitleFile({ segments: tr.segments, format: 'srt', maxChars: 42, name: 'lecture.en.srt' });
  check('subtitle file is saved as a subtitle asset', subFile.asset.kind === 'subtitle' && subFile.asset.ext === 'srt');

  const fromAudio = await creative.subtitlesFromAudio({
    url: `${origin.value}/asr/verbose`,
    path: audioFile,
    format: 'vtt',
    maxChars: 30,
    name: 'clip-captions.vtt',
  });
  check('subtitles-from-audio carries the transcript', fromAudio.transcript.includes('Hello world'));
  check('subtitles-from-audio saved a VTT', fromAudio.asset.ext === 'vtt');

  console.log('\n— speech & music');
  const tts = await creative.synthesize({
    url: `${origin.value}/tts`,
    key: 'tts-key',
    body: { model: 'tts-1', input: 'Hello from the media studio', voice: 'alloy', response_format: 'mp3' },
    ext: 'mp3',
  });
  check('TTS audio saved', tts.asset.kind === 'audio' && tts.asset.ext === 'mp3' && tts.bytes === mp3.length);
  check('TTS prompt recorded', tts.asset.prompt === 'Hello from the media studio');
  await expectThrow('TTS without text is refused', () => creative.synthesize({ url: `${origin.value}/tts`, body: {} }), 'write the text');

  const musicJson = await creative.music({ url: `${origin.value}/music/json`, body: { prompt: 'warm pads' } });
  check('music JSON URL branch downloads audio', musicJson.bytes === mp3.length && musicJson.asset.kind === 'audio');
  const musicDirect = await creative.music({ url: `${origin.value}/music/direct`, body: { prompt: 'rain sfx' }, ext: 'mp3' });
  check('music direct-bytes branch saves audio', musicDirect.asset.kind === 'audio' && musicDirect.asset.source === 'music');
  await expectThrow('music without a prompt is refused', () => creative.music({ url: `${origin.value}/music/direct`, body: {} }), 'describe the music');
  await expectThrow('file:// music endpoints are blocked', () => creative.music({ url: 'file:///C:/x.mp3', body: { prompt: 'x' } }));

  console.log('\n— text, frames, subtitles from text');
  const note = await creative.saveText({ name: 'session-notes', text: 'Remember to export the mix.', ext: 'md' });
  check('markdown note saved', note.kind === 'file' && note.ext === 'md' && note.mime === 'text/markdown');
  await expectThrow('invalid JSON is refused', () => creative.saveText({ name: 'bad', text: '{nope', ext: 'json' }), 'not valid json');

  const frame = await creative.saveImageData({ dataUrl: `data:image/jpeg;base64,${jpg.toString('base64')}`, name: 'video-frame' });
  check('frame saved as a real image', frame.kind === 'image' && frame.ext === 'jpg' && frame.meta.width === 32);

  const manualSub = await creative.saveSubtitleText({ name: 'manual', text: '1\n00:00:00,000 --> 00:00:02,000\nManual cue\n', format: 'srt' });
  check('manual subtitle saved', manualSub.kind === 'subtitle' && manualSub.ext === 'srt');
  await expectThrow('subtitle text without cues is refused', () => creative.saveSubtitleText({ name: 'x', text: 'no timestamps' }), '-->');
  await expectThrow('VTT without WEBVTT is refused', () => creative.saveSubtitleText({ name: 'x', text: '1\n00:00:00.000 --> 00:00:01.000\nyo\n', format: 'vtt' }), 'webvtt');

  console.log('\n— 3D inspection');
  const gltf = {
    asset: { version: '2.0', generator: 'orvex-test' },
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'Root', mesh: 0 }],
    meshes: [{ name: 'Cube', primitives: [{ attributes: { POSITION: 0 } }] }],
    materials: [{ name: 'Red' }],
    textures: [{ source: 0 }],
    accessors: [{ count: 24 }],
    animations: [{ name: 'Spin' }],
  };
  const gltfPath = path.join(work, 'cube.gltf');
  await fsp.writeFile(gltfPath, JSON.stringify(gltf));
  const gltfRow = await creative.importAsset({ path: gltfPath });
  check('glTF imports as a model', gltfRow.kind === 'model');
  eq('glTF node/mesh/material counts', [gltfRow.meta.nodes, gltfRow.meta.meshes, gltfRow.meta.materials, gltfRow.meta.vertices], [1, 1, 1, 24]);
  check('glTF animation counted', gltfRow.meta.animations === 1);

  const objPath = path.join(work, 'shape.obj');
  await fsp.writeFile(objPath, 'o Cube\nv 0 0 0\nv 1 0 0\nv 0 1 0\nvn 0 0 1\nvt 0 0\nusemtl Red\nf 1 2 3\n');
  const obj = await creative.inspect3D({ path: objPath });
  eq('OBJ counts lines', [obj.meta.vertices, obj.meta.normals, obj.meta.uvs, obj.meta.faces, obj.meta.materials], [3, 1, 1, 1, 1]);

  const stlPath = path.join(work, 'tri.stl');
  const stl = Buffer.alloc(84 + 50 * 2);
  stl.writeUInt32LE(2, 80);
  await fsp.writeFile(stlPath, stl);
  const stlRow = await creative.inspect3D({ path: stlPath });
  check('binary STL triangle count', stlRow.meta.encoding === 'binary' && stlRow.meta.triangles === 2, JSON.stringify(stlRow.meta));

  const plyPath = path.join(work, 'cloud.ply');
  await fsp.writeFile(plyPath, 'ply\nformat ascii 1.0\nelement vertex 8\nelement face 6\nend_header\n');
  const ply = await creative.inspect3D({ path: plyPath });
  eq('PLY header counts', [ply.meta.encoding, ply.meta.vertices, ply.meta.faces], ['ascii', 8, 6]);

  await fsp.writeFile(path.join(work, 'readme.xyz'), 'x');
  await expectThrow('unsupported 3D formats are refused', () => creative.inspect3D({ path: path.join(work, 'readme.xyz') }), 'not a supported 3d');

  console.log('\n— prompts');
  const pr1 = await creative.savePrompt({ title: 'Neon portrait', text: 'portrait, neon rim light, 85mm', kind: 'image', tags: ['Portrait', 'Neon'], favorite: true });
  check('prompt stored with lowercased tags', JSON.stringify(pr1.tags) === '["portrait","neon"]', JSON.stringify(pr1.tags));
  const pr2 = await creative.savePrompt({ text: 'warm cinematic pad', kind: 'music' });
  check('untitled prompt derives its title', pr2.title === 'warm cinematic pad', pr2.title);
  const listed = await creative.prompts({ query: 'neon' });
  eq('prompt search matches tags', listed.prompts.map((p) => p.id), [pr1.id]);
  const favFirst = await creative.prompts({});
  check('favorites sort first', favFirst.prompts[0].id === pr1.id);
  const used = await creative.usePrompt({ id: pr1.id });
  check('usePrompt counts usage', used.uses === 1, String(used.uses));
  const updated = await creative.savePrompt({ id: pr1.id, text: 'portrait, teal rim light', favorite: false });
  check('prompt update keeps title', updated.title === 'Neon portrait' && updated.favorite === false);
  await creative.deletePrompt({ id: pr2.id });
  const afterDelete = await creative.prompts({});
  check('prompt delete removes the row', afterDelete.prompts.length === 1, String(afterDelete.prompts.length));
  await expectThrow('empty prompt refused', () => creative.savePrompt({ text: '  ' }), 'empty');

  console.log('\n— sources & protocol resolution');
  const source = creative.registerSource({ path: sourceImage });
  check('source url carries a token', source.url.startsWith('orvex-media://source/') && source.token.length >= 16);
  const resolvedSource = await creative.resolveUrl(source.url);
  check('source url resolves to the file', resolvedSource === path.resolve(sourceImage));
  const resolvedAsset = await creative.resolveUrl(imported.url);
  check('asset url resolves inside the library', resolvedAsset.endsWith(`.${imported.ext}`) && fs.existsSync(resolvedAsset));
  await expectThrow('unknown source tokens expire', () => creative.resolveUrl('orvex-media://source/deadbeef/x.png'), 'expired');
  await expectThrow('unknown asset urls fail', () => creative.resolveUrl('orvex-media://asset/nope'), 'no longer exists');

  console.log('\n— rename, export, delete, guardrails');
  const renamed = await creative.renameAsset({ id: imported.id, name: 'cover-art.png' });
  check('rename applied', renamed.name === 'cover-art.png');
  await expectThrow('rename rejects path separators', () => creative.renameAsset({ id: imported.id, name: 'a/b' }), 'cannot contain');

  const exported = await creative.exportTo({ id: renamed.id, destPath: path.join(work, 'out', 'cover.png') });
  check('export writes a copy', fs.existsSync(exported.path) && exported.bytes === png.length, exported.path);
  const exportedDir = await creative.exportAsset({ id: renamed.id, destDir: path.join(work, 'exports') });
  check('export to a folder keeps the name', path.basename(exportedDir.path) === 'cover-art.png');

  await expectThrow('system folders are blocked for import', () => creative.importAsset({ path: 'C:\\Windows\\win.ini' }), 'blocked');

  const before = (await creative.library({})).total;
  const deleted = await creative.deleteAsset(renamed.id);
  const after = await creative.library({});
  check('delete removes the record', after.total === before - 1 && deleted.name === 'cover-art.png');
  check('delete emits a delete event', events.some((e) => e.type === 'delete' && e.id === renamed.id));
  check('delete removes the backing file', !fs.existsSync(resolvedAsset));

  console.log('\n— persistence');
  await creative.close();
  await creative.init({ dataDir, gateway });
  const reloaded = await creative.library({});
  check('library survives a restart', reloaded.total === after.total, `${reloaded.total} vs ${after.total}`);
  const promptsReloaded = await creative.prompts({});
  check('prompts survive a restart', promptsReloaded.total === 1);
  const persistedInfo = creative.info();
  check('info reports counts', persistedInfo.assets === reloaded.total && persistedInfo.prompts === 1, JSON.stringify(persistedInfo));

  await creative.close();
  server.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
  await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
}

main().catch((err) => {
  console.error('\nmedia smoke crashed:', err);
  process.exit(1);
});
