'use strict';

/**
 * ElevenLabs realtime speech-to-text.
 *
 * A live conversation cannot wait for a recorded clip to be uploaded: the mic
 * is streamed to the service as it happens, partial transcripts come back while
 * the speaker is still talking, and the service decides when the turn ended.
 * The socket is opened here so the key never reaches the renderer.
 */

const { WebSocket } = require('ws');

const PATH = '/v1/speech-to-text/realtime';
const MODEL = 'scribe_v2_realtime';
const SAMPLE_RATE = 16000;
const OPEN_TIMEOUT_MS = 10000;
/** 1 s of 16-bit mono PCM — a chunk larger than this is refused by the service. */
const MAX_CHUNK_BYTES = 32000;
/** Silence the service waits for before it commits a turn. */
const DEFAULT_SILENCE_SECS = 0.6;

/** Refusals that belong to the credential, so the next saved key is worth trying. */
const KEY_REFUSALS = new Set(['auth_error', 'quota_exceeded', 'rate_limited', 'unaccepted_terms']);

function isKeyRefusal(code) {
  return KEY_REFUSALS.has(String(code || ''));
}

function realtimeUrl(origin, { model, language, commitStrategy, silenceSecs, threshold, minSpeechMs, minSilenceMs } = {}) {
  const base = String(origin || '').trim().replace(/\/+$/, '');
  if (!/^https:\/\//i.test(base)) throw new Error('Realtime speech input needs an https ElevenLabs endpoint.');
  const url = new URL(`${base.replace(/^https:/i, 'wss:')}${PATH}`);
  url.searchParams.set('model_id', String(model || MODEL));
  url.searchParams.set('audio_format', `pcm_${SAMPLE_RATE}`);
  url.searchParams.set('commit_strategy', String(commitStrategy || 'vad'));
  const silence = Number(silenceSecs);
  url.searchParams.set('vad_silence_threshold_secs', String(Number.isFinite(silence) && silence > 0 ? Math.min(5, silence) : DEFAULT_SILENCE_SECS));
  const level = Number(threshold);
  if (Number.isFinite(level) && level > 0 && level < 1) url.searchParams.set('vad_threshold', String(level));
  for (const [name, value] of [['min_speech_duration_ms', minSpeechMs], ['min_silence_duration_ms', minSilenceMs]]) {
    const ms = Number(value);
    if (Number.isFinite(ms) && ms >= 0) url.searchParams.set(name, String(Math.min(10000, Math.round(ms))));
  }
  const lang = String(language || '').trim();
  if (lang) url.searchParams.set('language_code', lang.slice(0, 12));
  return url.toString();
}

/**
 * Opens one session. `ready` resolves with the service config once the session
 * is accepted, or rejects with the refusal so the caller can rotate keys.
 */
function openSession({
  key,
  origin,
  model,
  language,
  commitStrategy,
  silenceSecs,
  threshold,
  minSpeechMs,
  minSilenceMs,
  signal,
  onEvent,
  handshakeTimeoutMs = OPEN_TIMEOUT_MS,
  socketImpl = WebSocket,
} = {}) {
  if (!String(key || '').trim()) throw new Error('Add an ElevenLabs key in Settings → Voice first.');
  const url = realtimeUrl(origin, { model, language, commitStrategy, silenceSecs, threshold, minSpeechMs, minSilenceMs });
  const emit = (event) => {
    if (typeof onEvent === 'function') onEvent(event);
  };
  const ws = new socketImpl(url, {
    headers: { 'xi-api-key': String(key) },
    handshakeTimeout: Math.max(1000, Number(handshakeTimeoutMs) || OPEN_TIMEOUT_MS),
    maxPayload: 1024 * 1024,
  });

  let settleReady = () => {};
  let failReady = () => {};
  let readySettled = false;
  const ready = new Promise((resolve, reject) => {
    settleReady = (value) => {
      if (readySettled) return;
      readySettled = true;
      resolve(value);
    };
    failReady = (err) => {
      if (readySettled) return;
      readySettled = true;
      reject(err);
    };
  });
  // A rejection nobody has awaited yet must not crash the process.
  ready.catch(() => {});

  const OPEN = socketImpl.OPEN ?? 1;
  const CONNECTING = socketImpl.CONNECTING ?? 0;

  let closed = false;
  const close = (code = 1000, reason = 'client finished') => {
    if (closed) return;
    closed = true;
    try {
      if (ws.readyState === OPEN || ws.readyState === CONNECTING) ws.close(code, reason);
      else ws.terminate();
    } catch {
      /* already gone */
    }
  };

  const refusal = (code, message) => {
    const err = new Error(String(message || code || 'the realtime session was refused').slice(0, 300));
    err.code = String(code || 'error');
    err.status = code === 'quota_exceeded' ? 402 : code === 'auth_error' ? 401 : code === 'rate_limited' ? 429 : 0;
    return err;
  };

  ws.on('message', (raw) => {
    let event;
    try {
      event = JSON.parse(String(raw));
    } catch {
      return;
    }
    const type = String((event && event.message_type) || '');
    if (type === 'session_started') {
      const config = (event && event.config) || {};
      settleReady({ sessionId: String(event.session_id || ''), config });
      emit({ type: 'ready', sessionId: String(event.session_id || ''), sampleRate: Number(config.sample_rate) || SAMPLE_RATE, model: String(config.model_id || model || MODEL), commitStrategy: String(config.commit_strategy || commitStrategy || 'vad') });
      return;
    }
    if (type === 'partial_transcript') {
      emit({ type: 'partial', text: String(event.text || '') });
      return;
    }
    if (type === 'committed_transcript' || type === 'committed_transcript_with_timestamps') {
      emit({ type: 'committed', text: String(event.text || '') });
      return;
    }
    if (type === 'warning') {
      emit({ type: 'warning', message: String(event.warning || '').slice(0, 200) });
      return;
    }
    if (type === 'error' || KEY_REFUSALS.has(type) || /_error$|_exceeded$|_limited$|_throttled$|_overflow$|_exhausted$/.test(type)) {
      const err = refusal(type, event.error);
      emit({ type: 'error', error: type, message: err.message });
      failReady(err);
      close(1000, 'refused');
      return;
    }
  });

  ws.on('close', (code, reason) => {
    const detail = String(reason || '').slice(0, 200);
    failReady(refusal('closed', `The realtime speech session closed before it started (${code}${detail ? `: ${detail}` : ''}).`));
    if (!closed) {
      closed = true;
      emit({ type: 'closed', code: Number(code) || 0, message: detail });
    }
  });

  ws.on('error', (err) => {
    const message = err && err.message ? err.message : String(err);
    failReady(refusal('socket', message));
    emit({ type: 'error', error: 'socket', message: message.slice(0, 200) });
    close(1000, 'socket error');
  });

  const onAbort = () => close(1000, 'cancelled');
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  ready.finally(() => signal?.removeEventListener('abort', onAbort)).catch(() => {});

  const send = (pcm, commit = false) => {
    if (closed || ws.readyState !== WebSocket.OPEN) throw new Error('The realtime speech session is not open.');
    const bytes = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm || []);
    if (bytes.length > MAX_CHUNK_BYTES) throw new Error('That microphone chunk is too large for realtime speech input.');
    ws.send(
      JSON.stringify({
        message_type: 'input_audio_chunk',
        audio_base_64: bytes.toString('base64'),
        commit: !!commit,
        sample_rate: SAMPLE_RATE,
      }),
    );
    return { sent: true, bytes: bytes.length };
  };

  return {
    ready,
    send,
    /** A manual commit still needs a chunk, so 20 ms of silence carries it. */
    commit: () => send(Buffer.alloc(640), true),
    close: () => {
      signal?.removeEventListener('abort', onAbort);
      close();
    },
    get open() {
      return !closed && ws.readyState === WebSocket.OPEN;
    },
  };
}

module.exports = {
  PATH,
  MODEL,
  SAMPLE_RATE,
  MAX_CHUNK_BYTES,
  DEFAULT_SILENCE_SECS,
  isKeyRefusal,
  realtimeUrl,
  openSession,
};