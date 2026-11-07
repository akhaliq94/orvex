'use strict';

/**
 * ElevenLabs text-to-speech as a live audio stream.
 *
 * The point of this module is the first sound, not the whole clip: speech is
 * pulled as raw 24 kHz PCM and handed to the renderer in 100 ms frames, so a
 * reply starts being heard while the rest is still arriving. Keys stay in the
 * main process — callers pass one in and get audio back.
 */

const ORIGIN = 'https://api.elevenlabs.io';
const SAMPLE_RATE = 24000;
const FRAME_BYTES = 4800; // 100 ms of signed 16-bit mono at 24 kHz
const MAX_TEXT = 5000;
const MAX_AUDIO_BYTES = 100 * 1024 * 1024;
const MAX_FRAMES = Math.ceil(MAX_AUDIO_BYTES / FRAME_BYTES);
const STREAM_TIMEOUT_MS = 120000;

/** Models that answer fast enough to hold a conversation. */
const TTS_MODELS = ['eleven_flash_v2_5', 'eleven_turbo_v2_5', 'eleven_multilingual_v2'];
const DEFAULT_MODEL = 'eleven_flash_v2_5';

function cleanText(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('There is nothing to say.');
  if (text.length > MAX_TEXT) throw new Error(`ElevenLabs takes ${MAX_TEXT} characters per request — this reply is ${text.length}.`);
  return text;
}

function cleanId(value, label) {
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error(`That ${label} is not a valid ElevenLabs id.`);
  return id;
}

function pickModel(value) {
  const model = String(value || '').trim();
  if (!model) return DEFAULT_MODEL;
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(model)) throw new Error('That speech model id is not valid.');
  return model;
}

/** Provider refusals carry the status so the key pool can rotate on them. */
async function refusal(res, what) {
  const raw = await res.text().catch(() => '');
  let detail = raw.slice(0, 200);
  try {
    const parsed = JSON.parse(raw || '{}');
    const inner = parsed && parsed.detail;
    detail = String((inner && (inner.message || inner.status)) || inner || parsed.message || detail).slice(0, 200);
  } catch {
    /* keep the raw snippet */
  }
  const err = new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
  err.status = res.status;
  err.what = what;
  return err;
}

function headers(key) {
  return { 'xi-api-key': String(key || ''), 'content-type': 'application/json', accept: 'audio/*' };
}

/**
 * Streams one utterance. `onAudio({ index, audio, sampleRate })` is called with
 * base64 PCM frames in order; awaiting it lets the caller apply backpressure.
 */
async function speakStream({
  key,
  text,
  voiceId,
  model,
  speed,
  stability,
  signal,
  onAudio,
  timeoutMs = STREAM_TIMEOUT_MS,
  fetchImpl = fetch,
} = {}) {
  if (!String(key || '').trim()) throw new Error('Add an ElevenLabs key in Settings → Voice first.');
  if (onAudio !== undefined && typeof onAudio !== 'function') throw new Error('ElevenLabs onAudio must be a function.');
  const clean = cleanText(text);
  const voice = cleanId(voiceId, 'voice id');
  const mdl = pickModel(model);
  const rate = Number(speed);
  const voiceSettings = { stability: 0.5, similarity_boost: 0.75, use_speaker_boost: true };
  // Flash accepts 0.7–1.2; anything outside that is refused by the endpoint.
  if (Number.isFinite(rate) && rate > 0) voiceSettings.speed = Math.min(1.2, Math.max(0.7, rate));
  const hold = Number(stability);
  if (Number.isFinite(hold)) voiceSettings.stability = Math.min(1, Math.max(0, hold));

  const controller = new AbortController();
  const cancel = () => controller.abort(Object.assign(new Error('The speech stream was cancelled.'), { name: 'AbortError' }));
  const onOuterAbort = () => cancel();
  signal?.addEventListener('abort', onOuterAbort, { once: true });
  if (signal?.aborted) cancel();
  const limit = Math.max(1000, Math.min(STREAM_TIMEOUT_MS, Number(timeoutMs) || STREAM_TIMEOUT_MS));
  const timer = setTimeout(
    () => controller.abort(Object.assign(new Error(`ElevenLabs did not finish speaking within ${Math.round(limit / 1000)}s.`), { name: 'TimeoutError' })),
    limit,
  );

  let reader = null;
  const stopReader = () => {
    if (reader) void reader.cancel().catch(() => {});
  };
  controller.signal.addEventListener('abort', stopReader, { once: true });

  let bytes = 0;
  let frames = 0;
  let pending = Buffer.alloc(0);
  try {
    const url = `${ORIGIN}/v1/text-to-speech/${voice}/stream?output_format=pcm_${SAMPLE_RATE}&optimize_streaming_latency=3`;
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: headers(key),
      body: JSON.stringify({ text: clean, model_id: mdl, voice_settings: voiceSettings }),
      signal: controller.signal,
    });
    if (!res.ok) throw await refusal(res, 'speech');
    reader = res.body?.getReader();
    if (!reader) throw new Error('ElevenLabs returned an empty speech stream.');

    const emit = async (slice) => {
      if (!slice.length) return;
      if (frames >= MAX_FRAMES) throw new Error('ElevenLabs speech exceeded 100 MB.');
      const index = frames++;
      bytes += slice.length;
      if (onAudio) await onAudio({ index, audio: slice.toString('base64'), sampleRate: SAMPLE_RATE });
      controller.signal.throwIfAborted();
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      controller.signal.throwIfAborted();
      if (!value || !value.length) continue;
      const chunk = Buffer.from(value);
      if (bytes + chunk.length > MAX_AUDIO_BYTES) throw new Error('ElevenLabs speech exceeded 100 MB.');
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= FRAME_BYTES) {
        const slice = pending.subarray(0, FRAME_BYTES);
        pending = pending.subarray(FRAME_BYTES);
        await emit(slice);
      }
    }
    controller.signal.throwIfAborted();
    // An odd tail is still audio; padding keeps the frame aligned for playback.
    if (pending.length) {
      const slice = pending.length % 2 ? Buffer.concat([pending, Buffer.alloc(1)]) : pending;
      pending = Buffer.alloc(0);
      await emit(slice);
    }
    if (!frames) throw new Error('ElevenLabs returned no audio for that text.');
    return { model: mdl, voiceId: voice, bytes, frames, sampleRate: SAMPLE_RATE, duration: bytes / 2 / SAMPLE_RATE };
  } catch (err) {
    if (controller.signal.aborted && err && err.name === 'AbortError') throw err;
    if (err && err.status) throw err;
    const cause = err && err.cause;
    const reason = (cause && cause.code) || (cause && cause.message) || (err && err.message) || 'the request failed';
    const wrapped = new Error(`ElevenLabs speech did not answer (${reason}).`);
    wrapped.cause = err;
    throw wrapped;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuterAbort);
    controller.signal.removeEventListener('abort', stopReader);
    stopReader();
  }
}

/** Voices this account can speak with. */
async function listVoices({ key, fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  if (!String(key || '').trim()) throw new Error('Add an ElevenLabs key in Settings → Voice first.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${ORIGIN}/v1/voices`, { headers: headers(key), signal: controller.signal });
    if (!res.ok) throw await refusal(res, 'voices');
    const data = await res.json();
    const rows = Array.isArray(data) ? data : Array.isArray(data.voices) ? data.voices : [];
    const voices = rows
      .map((row) => ({
        voiceId: String((row && (row.voice_id || row.id)) || ''),
        name: String((row && row.name) || '').slice(0, 80),
        category: String((row && row.category) || '').slice(0, 40),
        labels: row && row.labels && typeof row.labels === 'object' ? row.labels : {},
      }))
      .filter((row) => row.voiceId)
      .slice(0, 200);
    return { voices, endpoint: `${ORIGIN}/v1/voices` };
  } finally {
    clearTimeout(timer);
  }
}

/** Only the models that can actually speak — the account list also holds STT ones. */
async function listModels({ key, fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  if (!String(key || '').trim()) throw new Error('Add an ElevenLabs key in Settings → Voice first.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${ORIGIN}/v1/models`, { headers: headers(key), signal: controller.signal });
    if (!res.ok) throw await refusal(res, 'models');
    const data = await res.json();
    const rows = Array.isArray(data) ? data : Array.isArray(data.models) ? data.models : [];
    const reported = rows
      .filter((row) => row && (row.can_do_text_to_speech === true || row.can_do_text_to_speech === undefined))
      .map((row) => String(row.model_id || row.id || '').trim())
      .filter(Boolean);
    const models = [...new Set([...TTS_MODELS.filter((m) => !reported.length || reported.includes(m)), ...reported])].slice(0, 80);
    return { models: models.length ? models : TTS_MODELS, endpoint: `${ORIGIN}/v1/models`, source: reported.length ? 'endpoint' : 'built-in list' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  ORIGIN,
  SAMPLE_RATE,
  FRAME_BYTES,
  TTS_MODELS,
  DEFAULT_MODEL,
  speakStream,
  listVoices,
  listModels,
};