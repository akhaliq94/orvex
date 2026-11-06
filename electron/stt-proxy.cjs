'use strict';

const MAX_AUDIO_BYTES = 40 * 1024 * 1024;

/** Hosts that speak the ElevenLabs dialect instead of the OpenAI one. */
const ELEVENLABS_HOSTS = new Set([
  'api.elevenlabs.io',
  'api.us.elevenlabs.io',
  'api.eu.residency.elevenlabs.io',
  'api.in.residency.elevenlabs.io',
  'api.sg.residency.elevenlabs.io',
]);

function sttProfile(url) {
  try {
    return ELEVENLABS_HOSTS.has(new URL(String(url || '')).hostname.toLowerCase()) ? 'elevenlabs' : 'openai';
  } catch {
    return 'openai';
  }
}

function describeTranscriptionError(err, endpoint) {
  const cause = err && err.cause;
  const nested = cause && Array.isArray(cause.errors) ? cause.errors[0] : null;
  const code = String((cause && cause.code) || (nested && nested.code) || '');
  const reason =
    code === 'ECONNREFUSED'
      ? 'nothing is listening on that address — start the speech server or change the endpoint'
      : code === 'ENOTFOUND'
        ? 'the host name does not resolve'
        : code === 'ETIMEDOUT'
          ? 'the connection timed out'
          : code === 'ECONNRESET'
            ? 'the connection was reset'
            : (cause && cause.message) || (err && err.message) || 'the request failed';
  return `The transcription endpoint did not answer (${reason}) — ${endpoint}`;
}

function isHttpFailure(err) {
  return /^HTTP \d/.test(err && err.message ? err.message : '');
}

async function postAudio(endpoint, { headers, form, timeoutMs, fetchImpl }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: headers || {},
      body: form,
      signal: controller.signal,
    });
    const raw = await res.text().catch(() => '');
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}${raw ? `: ${raw.slice(0, 160)}` : ''}`);
      // the status is what lets the key pool tell a dead key from a bad request
      err.status = res.status;
      throw err;
    }
    try {
      const data = JSON.parse(raw || '{}');
      return { text: String(data.text || '').trim() };
    } catch {
      return { text: '' };
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Posts a recorded clip to an OpenAI-compatible transcription endpoint.
 * Node resolves `localhost` to ::1 first, so a server bound to 127.0.0.1 is
 * retried on the IPv4 address before the failure is reported.
 */
async function transcribeAudio({ url, key, audio, type, model, timeoutMs, fetchImpl = fetch } = {}) {
  let parsed;
  try {
    parsed = new URL(String(url || '').trim());
  } catch {
    throw new Error('The transcription endpoint URL is not valid.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only http(s) transcription endpoints are supported.');

  const view =
    audio instanceof Uint8Array
      ? audio
      : audio instanceof ArrayBuffer
        ? new Uint8Array(audio)
        : ArrayBuffer.isView(audio)
          ? new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength)
          : null;
  if (!view || !view.byteLength) throw new Error('No audio was received.');
  if (view.byteLength > MAX_AUDIO_BYTES) throw new Error('That recording is larger than 40 MB.');

  const mime = String(type || 'audio/webm');
  const ext = mime.includes('wav') ? 'wav' : mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'm4a' : 'webm';
  const profile = sttProfile(parsed);
  const wanted = String(model || '').trim();
  const form = new FormData();
  form.append('file', new Blob([view], { type: mime }), `clip.${ext}`);
  // ElevenLabs calls the model `model_id` and has no Whisper; the name the
  // user chose is otherwise sent untouched.
  if (profile === 'elevenlabs') form.append('model_id', wanted || 'scribe_v2');
  else form.append('model', wanted || 'whisper-1');
  const headers = key
    ? profile === 'elevenlabs'
      ? { 'xi-api-key': String(key) }
      : { authorization: `Bearer ${String(key)}` }
    : {};
  const opts = {
    headers,
    form,
    timeoutMs: Math.min(Math.max(Number(timeoutMs) || 45000, 5000), 120000),
    fetchImpl,
  };

  try {
    return await postAudio(parsed.toString(), opts);
  } catch (err) {
    if (isHttpFailure(err)) throw err;
    if (parsed.hostname !== 'localhost') throw new Error(describeTranscriptionError(err, parsed.toString()));
    const retry = new URL(parsed.toString());
    retry.hostname = '127.0.0.1';
    try {
      return await postAudio(retry.toString(), opts);
    } catch (retryErr) {
      if (isHttpFailure(retryErr)) throw retryErr;
      throw new Error(describeTranscriptionError(retryErr, retry.toString()));
    }
  }
}

/**
 * Model names an endpoint reports for transcription. Groq and OpenAI list
 * everything they serve, so the speech models are picked out; ElevenLabs'
 * /v1/models table is about synthesis, so its documented Scribe models are
 * always offered as well. When a filter leaves nothing, the full list is
 * returned rather than an empty picker.
 */
const SPEECH_MODEL = /whisper|scribe|parakeet|asr|stt|transcri|audio/i;
const ELEVENLABS_MODELS = ['scribe_v2', 'scribe_v2_medical', 'scribe_v2_realtime', 'scribe_v1'];

/**
 * Where a server keeps its model list, relative to its origin. The
 * transcription path is cut back to the API root it sits under, because some
 * hosts serve the API from a prefix (Groq answers under /openai/v1, not /v1).
 */
function modelsPath(parsed, profile) {
  const path = parsed.pathname;
  if (profile === 'elevenlabs') return '/v1/models';
  if (/\/audio\/transcriptions?$/.test(path)) return `${path.replace(/\/audio\/transcriptions?$/, '')}/models`;
  const v1 = path.lastIndexOf('/v1');
  if (v1 >= 0) return `${path.slice(0, v1 + 3)}/models`;
  return `${path.replace(/\/[^/]*$/, '')}/models`;
}

async function listModels({ url, key, fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  let parsed;
  try {
    parsed = new URL(String(url || '').trim());
  } catch {
    throw new Error('The transcription endpoint URL is not valid.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only http(s) transcription endpoints are supported.');
  const profile = sttProfile(parsed);
  const endpoint = `${parsed.origin}${modelsPath(parsed, profile)}`;
  const headers = { accept: 'application/json' };
  if (key) {
    if (profile === 'elevenlabs') headers['xi-api-key'] = String(key);
    else headers.authorization = `Bearer ${String(key)}`;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(Math.max(Number(timeoutMs) || 15000, 2000), 30000));
  let reported = [];
  try {
    const res = await fetchImpl(endpoint, { method: 'GET', headers, signal: controller.signal });
    const raw = await res.text().catch(() => '');
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}${raw ? `: ${raw.slice(0, 160)}` : ''}`);
      err.status = res.status;
      throw err;
    }
    const data = JSON.parse(raw || '{}');
    const rows = Array.isArray(data) ? data : Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
    reported = rows
      .map((row) => String(typeof row === 'string' ? row : (row && (row.model_id || row.id || row.name)) || '').trim())
      .filter(Boolean);
  } finally {
    clearTimeout(timer);
  }
  const base = profile === 'elevenlabs' ? ELEVENLABS_MODELS : [];
  const merged = [...new Set([...base, ...reported])];
  const speech = merged.filter((id) => SPEECH_MODEL.test(id));
  const models = (speech.length ? speech : merged).slice(0, 80);
  return { models, endpoint, source: reported.length ? 'endpoint' : 'built-in list' };
}

module.exports = {
  MAX_AUDIO_BYTES,
  ELEVENLABS_MODELS,
  transcribeAudio,
  describeTranscriptionError,
  sttProfile,
  listModels,
};
