'use strict';

const MAX_AUDIO_BYTES = 40 * 1024 * 1024;

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

async function postAudio(endpoint, { key, form, timeoutMs, fetchImpl }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: key ? { authorization: `Bearer ${key}` } : {},
      body: form,
      signal: controller.signal,
    });
    const raw = await res.text().catch(() => '');
    if (!res.ok) throw new Error(`HTTP ${res.status}${raw ? `: ${raw.slice(0, 160)}` : ''}`);
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
  const form = new FormData();
  form.append('file', new Blob([view], { type: mime }), `clip.${ext}`);
  form.append('model', String(model || 'whisper-1'));
  const opts = {
    key,
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

module.exports = {
  MAX_AUDIO_BYTES,
  transcribeAudio,
  describeTranscriptionError,
};
