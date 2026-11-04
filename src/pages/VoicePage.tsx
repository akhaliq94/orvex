import { useEffect, useRef, useState } from 'react'
import { motion, useTransform } from 'framer-motion'
import {
  Activity,
  Loader2,
  Mic,
  MicOff,
  Radio,
  RefreshCw,
  Server,
  Trash2,
  UserPlus,
  Volume2,
} from 'lucide-react'
import PageShell from './PageShell'
import AICore from '../components/AICore'
import type { Voice } from '../hooks/useVoice'
import { useLevelMotion } from '../hooks/useLevelMotion'
import { useVoiceSettings } from '../data/voice'
import { transcribeAudio } from '../data/voicestudio'
import { micConstraints } from '../voice/devices'
import { addProfile, identify, loadProfiles, removeProfile, vectorFromBlob, type SpeakerProfile } from '../voice/speaker'

type Props = { onBack: () => void; voice: Voice; onToggleListening: () => void; notify: (msg: string) => void }

const HISTORY_KEY = 'orvex-voice-history'
const ENROLL_SECONDS = 4
const IDENTIFY_SECONDS = 3

function loadHistory(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function saveHistory(next: string[]) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next))
  } catch {
    /* history is a convenience, not required for voice to work */
  }
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString('en-US', { hour12: false })
}

export default function VoicePage({ onBack, voice, onToggleListening, notify }: Props) {
  const listening = voice.status === 'listening' || voice.status === 'starting'
  const [history, setHistory] = useState<string[]>(loadHistory)
  const lv = useLevelMotion(voice.levelRef)
  const meter = useTransform(lv, [0, 1], ['0%', '100%'])
  const { cfg, setCfg } = useVoiceSettings()
  const [recording, setRecording] = useState(false)
  const [busy, setBusy] = useState(false)
  const recRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])

  const [profiles, setProfiles] = useState<SpeakerProfile[]>(() => loadProfiles())
  const [speakerName, setSpeakerName] = useState('')
  const [speakerBusy, setSpeakerBusy] = useState<'enroll' | 'identify' | null>(null)
  const [speakerMsg, setSpeakerMsg] = useState('')
  const [speakerHit, setSpeakerHit] = useState<{ name: string; score: number } | null>(null)

  // commit final transcript segments into history
  useEffect(() => {
    if (!voice.transcript) return
    setHistory((h) => {
      const last = h[0]
      if (last === voice.transcript) return h
      const next = [voice.transcript, ...h.filter((x) => x !== voice.transcript)].slice(0, 12)
      saveHistory(next)
      return next
    })
  }, [voice.transcript])

  // Stop a clip recording (and release the microphone) when the page unmounts.
  useEffect(
    () => () => {
      try {
        recRef.current?.stop()
      } catch {
        /* already stopped */
      }
      recRef.current?.stream?.getTracks().forEach((t) => t.stop())
      recRef.current = null
    },
    [],
  )

  const clear = () => {
    setHistory([])
    try {
      localStorage.removeItem(HISTORY_KEY)
    } catch {
      /* storage unavailable */
    }
    voice.clearTranscript()
    notify('Voice history cleared')
  }

  /** Records a short clip and sends it to the VoiceStudio-compatible ASR endpoint. */
  const transcribeOnServer = async () => {
    if (recording || busy) {
      recRef.current?.stop()
      return
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      notify('This browser cannot record audio for server transcription.')
      return
    }
    let stream: MediaStream | null = null
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const rec = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '' })
      chunksRef.current = []
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      rec.onstop = async () => {
        stream?.getTracks().forEach((t) => t.stop())
        setRecording(false)
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' })
        if (!blob.size) return
        setBusy(true)
        const res = await transcribeAudio(cfg.serverUrl, cfg.asrPath, blob, { model: cfg.model })
        setBusy(false)
        if (!res.ok) {
          notify(res.detail)
          return
        }
        setHistory((h) => {
          const next = [res.text, ...h.filter((x) => x !== res.text)].slice(0, 12)
          saveHistory(next)
          return next
        })
        notify(`Server transcript: ${res.detail}`)
      }
      rec.start()
      recRef.current = rec
      setRecording(true)
      notify('Recording — press again to stop and transcribe.')
    } catch {
      stream?.getTracks().forEach((t) => t.stop())
      notify('Could not access the microphone for recording.')
    }
  }

  const recordClip = async (seconds: number): Promise<Blob | null> => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      notify('This build cannot record audio samples.')
      return null
    }
    const stream = await navigator.mediaDevices.getUserMedia(micConstraints(cfg.micDeviceId || null, cfg))
    const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : ''
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
    const chunks: Blob[] = []
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data)
    }
    const finished = new Promise<Blob | null>((resolve) => {
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop())
        resolve(chunks.length ? new Blob(chunks, { type: rec.mimeType || 'audio/webm' }) : null)
      }
    })
    rec.start()
    window.setTimeout(() => {
      if (rec.state !== 'inactive') rec.stop()
    }, seconds * 1000)
    return finished
  }

  const enroll = async () => {
    const name = speakerName.trim()
    if (!name) {
      notify('Give the speaker a name first.')
      return
    }
    if (speakerBusy) return
    setSpeakerBusy('enroll')
    setSpeakerMsg(`Recording ${ENROLL_SECONDS}s — say a few sentences…`)
    try {
      const blob = await recordClip(ENROLL_SECONDS)
      const vector = blob ? await vectorFromBlob(blob) : []
      if (!vector.length) {
        setSpeakerMsg('Could not fingerprint that clip — use a quieter room and speak normally.')
        notify('Enrollment failed — no voiced audio detected.')
        return
      }
      setProfiles(addProfile(name, vector))
      setSpeakerMsg(`Enrolled “${name}”. Enroll again to average a second sample.`)
      notify(`${name} enrolled`)
    } catch (e) {
      const msg = e instanceof DOMException && e.name === 'NotAllowedError' ? 'Microphone blocked.' : e instanceof Error ? e.message : String(e)
      setSpeakerMsg(`Recording failed — ${msg}`)
      notify(`Recording failed — ${msg}`)
    } finally {
      setSpeakerBusy(null)
    }
  }

  const identifyNow = async () => {
    if (speakerBusy) return
    const list = loadProfiles()
    if (!list.length) {
      notify('Enroll a speaker first.')
      return
    }
    setSpeakerBusy('identify')
    setSpeakerMsg(`Listening for ${IDENTIFY_SECONDS}s…`)
    try {
      const blob = await recordClip(IDENTIFY_SECONDS)
      const vector = blob ? await vectorFromBlob(blob) : []
      if (!vector.length) {
        setSpeakerMsg('No voiced audio in that sample.')
        return
      }
      const hit = identify(vector, list, 0.8)
      if (!hit) {
        setSpeakerMsg('No enrolled speaker matched that voice.')
        setSpeakerHit(null)
        return
      }
      setSpeakerHit({ name: hit.profile.name, score: hit.score })
      setSpeakerMsg(`Matched ${hit.profile.name} (${Math.round(hit.score * 100)}% similarity).`)
    } catch (e) {
      const msg = e instanceof DOMException && e.name === 'NotAllowedError' ? 'Microphone blocked.' : e instanceof Error ? e.message : String(e)
      setSpeakerMsg(`Recording failed — ${msg}`)
    } finally {
      setSpeakerBusy(null)
    }
  }

  const dropProfile = (id: string) => {
    setProfiles(removeProfile(id))
    setSpeakerHit(null)
    setSpeakerMsg('Profile removed.')
  }

  const wakeArmed = cfg.wakeEnabled && listening && !voice.sttUnavailable
  const needsStt = cfg.wakeEnabled && (!!voice.sttUnavailable || !voice.speechSupported)

  return (
    <PageShell
      title="Voice"
      sub={voice.speechSupported ? 'Live microphone — speech-to-text, wake word and speaker identification' : 'Live microphone works here; speech-to-text needs an endpoint or Chrome/Edge'}
      onBack={onBack}
      actions={
        <div className="flex gap-2">
          <button
            className="page-tool-btn"
            onClick={transcribeOnServer}
            aria-label={recording ? 'Stop recording and transcribe' : 'Record and transcribe on the server'}
            title={recording ? 'Stop & transcribe' : 'Record clip → server ASR'}
          >
            {busy ? <Loader2 size={14} className="spin" /> : recording ? <MicOff size={14} /> : <Server size={14} />}
          </button>
          <button className="page-tool-btn" onClick={clear} aria-label="Clear voice history" title="Clear history">
            <Trash2 size={14} />
          </button>
        </div>
      }
    >
      <div className="voice-page">
        <div className="voice-main">
          <div className="voice-stage">
            <div className="voice-stage-orb">
              <AICore listening={listening} levelRef={voice.levelRef} />
            </div>
            <div className="voice-controls">
              <button className={`voice-main-btn ${listening ? 'live' : ''}`} onClick={onToggleListening}>
                {listening ? <MicOff size={18} /> : <Mic size={18} />}
                {listening ? 'Stop session' : 'Start voice session'}
              </button>
              <div className="voice-meter" aria-hidden>
                <motion.div className="voice-meter-fill" style={{ width: meter }} />
              </div>
              <p className="voice-status-line">
                {voice.status === 'starting' && 'Starting microphone…'}
                {voice.status === 'listening' && (voice.interim ? 'Hearing: ' + voice.interim : 'Listening — speak now')}
                {voice.status === 'idle' && 'Idle — press the button or tap the core'}
                {(voice.status === 'denied' || voice.status === 'unsupported') && (voice.error ?? 'Mic unavailable')}
              </p>
              <div className="voice-chips">
                {wakeArmed && <span className="voice-chip live">Wake armed — “{cfg.wakePhrase}”</span>}
                {voice.speaking && <span className="voice-chip warn"><Volume2 size={9} /> speaking</span>}
                {voice.partial && <span className="voice-chip"><Loader2 size={9} className="spin" /> streaming partial</span>}
                {voice.speaker && <span className="voice-chip live">Speaker: {voice.speaker.name} ({Math.round(voice.speaker.score * 100)}%)</span>}
                {voice.error && listening && <span className="voice-chip bad" title={voice.error}>voice warning</span>}
              </div>
            </div>
          </div>

          <div className="voice-lower">
            <div className="voice-transcript panel">
              <div className="voice-panel-head">
                <span>Current transcript</span>
                {voice.status === 'listening' && <span className="voice-chip live">{voice.interim ? 'hearing' : 'live'}</span>}
              </div>
              {voice.transcript || voice.interim ? (
                <>
                  {voice.transcript && <p>{voice.transcript}</p>}
                  {voice.interim && <p className="interim">{voice.interim}</p>}
                </>
              ) : (
                <p className="dim">Your words will appear here…</p>
              )}
            </div>
            <div className="voice-history">
              <div className="voice-panel-head"><span>Recent sessions</span></div>
              {history.length === 0 && <p className="dim">No voice sessions yet.</p>}
              {history.map((h, i) => (
                <div key={i} className="voice-history-item panel">
                  <Mic size={12} />
                  <span>{h}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="voice-config">
          <section className="voice-card panel" aria-label="Microphone">
            <div className="voice-card-head">
              <Mic size={13} />
              <h3 className="voice-card-title">Microphone</h3>
              <span className={`voice-chip ${voice.devices.length ? 'live' : 'bad'}`}>{voice.devices.length ? `${voice.devices.length} input${voice.devices.length > 1 ? 's' : ''}` : 'none'}</span>
            </div>
            <div className="voice-device-row">
              <select
                className="select"
                aria-label="Microphone device"
                value={cfg.micDeviceId}
                onChange={(e) => setCfg({ micDeviceId: e.target.value })}
              >
                <option value="">System default</option>
                {voice.devices.map((d) => (
                  <option key={d.id} value={d.id}>{d.label}</option>
                ))}
              </select>
              <button className="page-tool-btn" title="Refresh device list" aria-label="Refresh microphones" onClick={() => void voice.refreshDevices()}>
                <RefreshCw size={13} />
              </button>
            </div>
            <p className="voice-card-note">
              {voice.deviceError ?? (listening ? 'Changing the device reopens the stream automatically.' : 'Hot-plug is watched — unplugging the selected mic falls back to the default.')}
            </p>
            <div className="voice-checks">
              <label className="voice-check"><input type="checkbox" checked={cfg.echoCancellation} onChange={(e) => setCfg({ echoCancellation: e.target.checked })} /> Echo cancel</label>
              <label className="voice-check"><input type="checkbox" checked={cfg.noiseSuppression} onChange={(e) => setCfg({ noiseSuppression: e.target.checked })} /> Noise suppress</label>
              <label className="voice-check"><input type="checkbox" checked={cfg.autoGainControl} onChange={(e) => setCfg({ autoGainControl: e.target.checked })} /> Auto gain</label>
            </div>
          </section>

          <section className="voice-card panel" aria-label="Wake word">
            <div className="voice-card-head">
              <Radio size={13} />
              <h3 className="voice-card-title">Wake word</h3>
              <span className={`voice-chip ${wakeArmed ? 'live' : cfg.wakeEnabled ? 'warn' : ''}`}>{wakeArmed ? 'armed' : needsStt ? 'needs STT' : cfg.wakeEnabled ? 'needs session' : 'off'}</span>
            </div>
            <label className="voice-check">
              <input
                type="checkbox"
                checked={cfg.wakeEnabled}
                onChange={(e) => {
                  setCfg({ wakeEnabled: e.target.checked })
                  if (e.target.checked && voice.status === 'idle') onToggleListening()
                }}
              />
              Listen for the phrase hands-free
            </label>
            <div className="voice-device-row">
              <input
                className="text-input"
                aria-label="Wake phrase"
                value={cfg.wakePhrase}
                onChange={(e) => setCfg({ wakePhrase: e.target.value })}
                placeholder="Hey Orvex"
              />
            </div>
            <label className="voice-check"><input type="checkbox" checked={cfg.wakeFuzzy} onChange={(e) => setCfg({ wakeFuzzy: e.target.checked })} /> Tolerate one-letter transcription slips</label>
            <p className="voice-card-note">
              {needsStt
                ? voice.sttUnavailable ?? 'Wake detection needs a transcription endpoint (Settings → Voice) or browser speech recognition — no phrase spotting is simulated without one.'
                : 'Matching runs on the finished transcript. Whatever follows the phrase is sent as the command.'}
            </p>
            <p className="voice-card-note">
              {voice.wake
                ? `Last hit ${clock(voice.wake.at)} — “${voice.wake.command || '(no command)'}”`
                : 'No wake events this session.'}
            </p>
          </section>

          <section className="voice-card panel" aria-label="Streaming transcription">
            <div className="voice-card-head">
              <Activity size={13} />
              <h3 className="voice-card-title">Streaming STT</h3>
              <span className={`voice-chip ${voice.partial ? 'warn' : ''}`}>{voice.partial ? 'uploading' : 'ready'}</span>
            </div>
            <label className="voice-check">
              <input type="checkbox" checked={cfg.streaming} onChange={(e) => setCfg({ streaming: e.target.checked })} />
              Send ~1s partials while I am still speaking
            </label>
            <p className="voice-card-note">
              The growing turn is re-sent to the transcription endpoint about once a second and overlapping results are merged.
              {cfg.streaming ? '' : ' Off — only the finished turn is transcribed.'}
            </p>
            {voice.interim && <p className="voice-card-note" style={{ color: 'var(--text)' }}>Partial: {voice.interim.slice(-120)}</p>}
          </section>

          <section className="voice-card panel" aria-label="Barge-in">
            <div className="voice-card-head">
              <Volume2 size={13} />
              <h3 className="voice-card-title">Barge-in</h3>
              <span className={`voice-chip ${voice.speaking ? 'warn' : ''}`}>{voice.speaking ? 'speaking' : 'idle'}</span>
            </div>
            <label className="voice-check">
              <input type="checkbox" checked={cfg.bargeIn} onChange={(e) => setCfg({ bargeIn: e.target.checked })} />
              Stop talking when I start speaking
            </label>
            <div className="voice-slider">
              <input
                type="range"
                min={0.05}
                max={0.5}
                step={0.01}
                value={cfg.bargeInThreshold}
                aria-label="Barge-in threshold"
                onChange={(e) => setCfg({ bargeInThreshold: Number(e.target.value) })}
              />
              <span className="range-val">{Math.round(cfg.bargeInThreshold * 100)}%</span>
            </div>
            <p className="voice-card-note">
              Playback stops after {voice.speaking ? 'sustained speech' : 'about 260ms of sustained speech'} above the level. Raise the threshold in noisy rooms.
            </p>
            <p className="voice-card-note">{voice.bargeInAt ? `Last interruption ${clock(voice.bargeInAt)}` : 'No interruptions yet.'}</p>
          </section>

          <section className="voice-card panel" aria-label="Speaker ID">
            <div className="voice-card-head">
              <UserPlus size={13} />
              <h3 className="voice-card-title">Speaker ID</h3>
              <span className={`voice-chip ${profiles.length ? 'live' : ''}`}>{profiles.length} profile{profiles.length === 1 ? '' : 's'}</span>
            </div>
            <label className="voice-check">
              <input type="checkbox" checked={cfg.speakerId} onChange={(e) => setCfg({ speakerId: e.target.checked })} />
              Identify the speaker on every finished turn
            </label>
            <div className="voice-device-row">
              <input
                className="text-input"
                aria-label="Speaker name"
                placeholder="Name (e.g. Abdul)"
                value={speakerName}
                onChange={(e) => setSpeakerName(e.target.value)}
              />
              <button className="ghost-btn" onClick={() => void enroll()} disabled={!!speakerBusy}>
                {speakerBusy === 'enroll' ? <Loader2 size={11} className="spin" /> : <UserPlus size={11} />} Enroll
              </button>
            </div>
            <div className="voice-device-row">
              <button className="ghost-btn" onClick={() => void identifyNow()} disabled={!!speakerBusy || !profiles.length}>
                {speakerBusy === 'identify' ? <Loader2 size={11} className="spin" /> : <Mic size={11} />} Identify from mic
              </button>
              {speakerHit && <span className="voice-chip live">{speakerHit.name} · {Math.round(speakerHit.score * 100)}%</span>}
            </div>
            {speakerMsg && <p className="voice-card-note" style={{ color: 'var(--text)' }}>{speakerMsg}</p>}
            {profiles.map((p) => (
              <div key={p.id} className="voice-profile">
                <span>{p.name}</span>
                <span className="dim">· {p.clips} clip{p.clips === 1 ? '' : 's'}</span>
                <span className="voice-profile-score">{voice.speaker?.name === p.name ? Math.round(voice.speaker.score * 100) + '%' : ''}</span>
                <button className="page-tool-btn" title={`Delete ${p.name}`} aria-label={`Delete ${p.name}`} onClick={() => dropProfile(p.id)}>
                  <Trash2 size={11} />
                </button>
              </div>
            ))}
            <p className="voice-card-note">
              Lightweight timbre fingerprint — 24 mel bands plus pitch statistics. It separates enrolled voices from the same
              microphone; it is not a forensic identity system.
            </p>
          </section>
        </div>
      </div>
    </PageShell>
  )
}
