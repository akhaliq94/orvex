import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  AudioLines,
  Box,
  Clapperboard,
  Copy,
  Download,
  ExternalLink,
  FileText,
  Film,
  FolderOpen,
  Image as ImageIcon,
  ImagePlus,
  Layers,
  Library,
  Loader2,
  Maximize2,
  Music,
  RefreshCw,
  Save,
  Search,
  Sparkles,
  Star,
  Subtitles,
  Trash2,
  Upload,
  Video,
  Wand2,
  X,
} from 'lucide-react'
import PageShell from './PageShell'
import { onTablistKeyDown } from '../data/a11y'
import { useProviders } from '../hooks/useProviders'
import { useVoiceSettings, speak, VOICE_PRESETS } from '../data/voice'
import { sttTarget } from '../data/stt'
import { buildCandidates, orderForTask } from '../data/routing'
import type { ProviderConfig } from '../data/providers'
import type {
  OrvexMediaAsset,
  OrvexMediaInfo,
  OrvexMediaKind,
  OrvexMediaPrompt,
  OrvexMediaSubtitleSegment,
  OrvexMediaSubtitles,
} from '../types/desktop'

type Props = { onBack: () => void; notify: (msg: string) => void }

type Tab = 'images' | 'audio' | 'video' | 'subtitles' | 'models3d' | 'library' | 'prompts'

type MediaCfg = {
  imageProviderId: string
  imageModel: string
  editModel: string
  asrUrl: string
  asrModel: string
  language: string
  musicUrl: string
}

const bridge = typeof window !== 'undefined' ? window.orvex : undefined
const mediaApi = bridge?.media
const CFG_KEY = 'orvex-media-config'

const DEFAULT_CFG: MediaCfg = {
  imageProviderId: '',
  imageModel: '',
  editModel: '',
  asrUrl: '',
  asrModel: 'whisper-1',
  language: '',
  musicUrl: '',
}

const TABS: { id: Tab; label: string; icon: typeof ImageIcon }[] = [
  { id: 'images', label: 'Images', icon: ImagePlus },
  { id: 'audio', label: 'Audio & Speech', icon: AudioLines },
  { id: 'video', label: 'Video', icon: Film },
  { id: 'subtitles', label: 'Subtitles', icon: Subtitles },
  { id: 'models3d', label: '3D Models', icon: Box },
  { id: 'library', label: 'Library', icon: Library },
  { id: 'prompts', label: 'Prompts', icon: Sparkles },
]

const IMAGE_SIZES = ['1024x1024', '1024x1536', '1536x1024', '512x512', 'auto']
const KIND_FILTERS: { id: OrvexMediaKind | 'all'; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'image', label: 'Images' },
  { id: 'audio', label: 'Audio' },
  { id: 'video', label: 'Video' },
  { id: 'model', label: '3D' },
  { id: 'subtitle', label: 'Subtitles' },
  { id: 'file', label: 'Text' },
]

function loadCfg(): MediaCfg {
  try {
    const raw = localStorage.getItem(CFG_KEY)
    return raw ? { ...DEFAULT_CFG, ...(JSON.parse(raw) as Partial<MediaCfg>) } : { ...DEFAULT_CFG }
  } catch {
    return { ...DEFAULT_CFG }
  }
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let n = bytes
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i += 1
  }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`
}

function formatDate(ts: number) {
  if (!ts) return ''
  return new Date(ts).toLocaleString('en-US', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function defaultImageModel(p: ProviderConfig | null) {
  if (!p) return ''
  const base = p.baseUrl.toLowerCase()
  if (base.includes('generativelanguage.googleapis.com')) return 'gemini-2.5-flash-image'
  if (base.includes('openai.com')) return 'gpt-image-1'
  if (base.includes('together.xyz')) return 'black-forest-labs/FLUX.1-schnell'
  return ''
}

function providerReady(p: ProviderConfig | null) {
  if (!p) return false
  return p.kind === 'local' || !!p.apiKey || !!p.hasKey
}

function assetKindLabel(kind: string) {
  if (kind === 'model') return '3D'
  if (kind === 'file') return 'text'
  return kind
}

export default function MediaPage({ onBack, notify }: Props) {
  const { providers, activeId } = useProviders()
  const { cfg: voiceCfg } = useVoiceSettings()
  const [tab, setTab] = useState<Tab>('images')
  const [info, setInfo] = useState<OrvexMediaInfo | null>(null)
  const [cfg, setCfgState] = useState<MediaCfg>(loadCfg)
  const [assets, setAssets] = useState<OrvexMediaAsset[]>([])
  const [prompts, setPrompts] = useState<OrvexMediaPrompt[]>([])
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  const setCfg = useCallback((patch: Partial<MediaCfg>) => {
    setCfgState((prev) => {
      const next = { ...prev, ...patch }
      try {
        localStorage.setItem(CFG_KEY, JSON.stringify(next))
      } catch {
        /* the setting still applies until the window closes */
      }
      return next
    })
  }, [])

  const fail = useCallback(
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      notify(message)
    },
    [notify],
  )

  const call = useCallback(async <T,>(promise: Promise<{ ok: true; data: T } | { ok: false; error: string }>): Promise<T> => {
    const result = await promise
    if (!result.ok) throw new Error(result.error)
    return result.data
  }, [])

  const withBusy = useCallback(
    async (key: string, fn: () => Promise<void>) => {
      setBusy(key)
      setError('')
      try {
        await fn()
      } catch (err) {
        fail(err)
      } finally {
        setBusy('')
      }
    },
    [fail],
  )

  const refreshLibrary = useCallback(async () => {
    if (!mediaApi) return
    const data = await call(mediaApi.library({ limit: 1000 }))
    setAssets(data.assets)
  }, [call])

  const refreshPrompts = useCallback(async () => {
    if (!mediaApi) return
    const data = await call(mediaApi.prompts({ limit: 1000 }))
    setPrompts(data.prompts)
  }, [call])

  useEffect(() => {
    if (!mediaApi) return
    mediaApi
      .info()
      .then((res) => {
        if (res.ok) setInfo(res.data)
      })
      .catch(() => {})
    void refreshLibrary().catch(fail)
    void refreshPrompts().catch(fail)
    const off = mediaApi.onChange(() => {
      void refreshLibrary().catch(() => {})
    })
    return () => off()
  }, [refreshLibrary, refreshPrompts, fail])

  // Prompts can be added by the agent while this page is open, so re-read the
  // store whenever the tab is shown.
  useEffect(() => {
    if (tab !== 'prompts' || !mediaApi) return
    void refreshPrompts().catch(fail)
  }, [tab, refreshPrompts, fail])

  /* ------------------------------------------------------------- providers */

  const imageProviderOptions = useMemo(() => providers.filter((p) => p.api !== 'anthropic' && p.baseUrl), [providers])
  const selectedProvider = useMemo(
    () => imageProviderOptions.find((p) => p.id === cfg.imageProviderId) ?? imageProviderOptions[0] ?? null,
    [imageProviderOptions, cfg.imageProviderId],
  )
  const genericId = selectedProvider?.id ?? ''

  useEffect(() => {
    if (!genericId || cfg.imageProviderId === genericId) return
    setCfg({ imageProviderId: genericId, imageModel: cfg.imageModel || defaultImageModel(selectedProvider) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [genericId])

  const visionCandidates = useMemo(
    () => orderForTask(buildCandidates(providers, activeId), 'vision'),
    [providers, activeId],
  )

  /* ---------------------------------------------------------------- images */

  const [prompt, setPrompt] = useState('')
  const [size, setSize] = useState(IMAGE_SIZES[0])
  const [count, setCount] = useState(1)
  const [imageResults, setImageResults] = useState<OrvexMediaAsset[]>([])
  const [editAssetId, setEditAssetId] = useState('')
  const [editPrompt, setEditPrompt] = useState('')
  const [upFactor, setUpFactor] = useState(2)
  const [sharpen, setSharpen] = useState(true)

  const imageAssets = useMemo(() => assets.filter((a) => a.kind === 'image'), [assets])
  const audioAssets = useMemo(() => assets.filter((a) => a.kind === 'audio'), [assets])
  const videoAssets = useMemo(() => assets.filter((a) => a.kind === 'video'), [assets])
  const modelAssets = useMemo(() => assets.filter((a) => a.kind === 'model'), [assets])
  const subtitleAssets = useMemo(() => assets.filter((a) => a.kind === 'subtitle'), [assets])

  const generate = () =>
    withBusy('generate', async () => {
      if (!mediaApi) throw new Error('Desktop bridge unavailable.')
      if (!selectedProvider) throw new Error('Add an image provider in Settings → Providers first.')
      const result = await call(
        mediaApi.generate({
          provider: selectedProvider,
          prompt,
          model: cfg.imageModel || defaultImageModel(selectedProvider),
          size: size === 'auto' ? undefined : size,
          n: count,
        }),
      )
      setImageResults(result.assets)
      notify(`Generated ${result.assets.length} image${result.assets.length === 1 ? '' : 's'}.`)
      await refreshLibrary()
    })

  const editImage = (mode: 'edit' | 'background') =>
    withBusy(mode, async () => {
      if (!mediaApi) throw new Error('Desktop bridge unavailable.')
      if (!selectedProvider) throw new Error('Add an image provider in Settings → Providers first.')
      if (!editAssetId) throw new Error('Pick an image from the library to edit.')
      const payload = {
        provider: selectedProvider,
        assetId: editAssetId,
        model: cfg.editModel || cfg.imageModel || defaultImageModel(selectedProvider),
        prompt: editPrompt,
      }
      const result =
        mode === 'background'
          ? await call(mediaApi.removeBackground(payload))
          : await call(mediaApi.edit({ ...payload, prompt: editPrompt }))
      setImageResults(result.assets)
      notify(mode === 'background' ? 'Background removal result saved.' : 'Edited image saved.')
      await refreshLibrary()
    })

  const upscale = () =>
    withBusy('upscale', async () => {
      if (!mediaApi) throw new Error('Desktop bridge unavailable.')
      if (!editAssetId) throw new Error('Pick an image from the library to upscale.')
      const result = await call(mediaApi.upscale({ assetId: editAssetId, factor: upFactor, sharpen }))
      setImageResults([result.asset])
      notify(`Upscaled ${result.from.width}×${result.from.height} → ${result.to.width}×${result.to.height}.`)
      await refreshLibrary()
    })

  /* ----------------------------------------------------------------- audio */

  const [ttsText, setTtsText] = useState('')
  const [musicPrompt, setMusicPrompt] = useState('')
  const [musicDuration, setMusicDuration] = useState(10)
  const [musicKey, setMusicKey] = useState('')
  const [musicKeySaved, setMusicKeySaved] = useState(false)
  const [ttsAudio, setTtsAudio] = useState<OrvexMediaAsset | null>(null)
  const [musicAudio, setMusicAudio] = useState<OrvexMediaAsset | null>(null)
  const [transcribePath, setTranscribePath] = useState('')
  const [transcript, setTranscript] = useState('')

  useEffect(() => {
    if (!bridge) return
    void bridge.secrets
      .get()
      .then((res) => {
        if (res.ok) setMusicKeySaved(!!res.data.keys.music)
      })
      .catch(() => {})
  }, [])

  const saveMusicKey = async () => {
    if (!bridge) return
    const res = await bridge.secrets.set('music', musicKey.trim(), cfg.musicUrl.trim() || undefined)
    if (!res.ok) {
      notify(res.error)
      return
    }
    setMusicKeySaved(!!musicKey.trim())
    setMusicKey('')
    notify(musicKey.trim() ? 'Music key saved in the OS vault.' : 'Music key cleared.')
  }

  const asrUrl = cfg.asrUrl.trim() || sttTarget(voiceCfg)?.url || ''
  const asrModel = cfg.asrModel.trim() || voiceCfg.asrModel || 'whisper-1'

  const synthesize = () =>
    withBusy('tts', async () => {
      if (!mediaApi) throw new Error('Desktop bridge unavailable.')
      if (voiceCfg.engine === 'browser') {
        throw new Error('The browser voice cannot be written to a file — configure a TTS server in Settings → Voice, or use Preview.')
      }
      const base = voiceCfg.serverUrl.replace(/\/+$/, '')
      const pathPart = voiceCfg.synthPath.startsWith('/') ? voiceCfg.synthPath : `/${voiceCfg.synthPath}`
      const body: Record<string, unknown> = {
        model: voiceCfg.model,
        input: ttsText,
        voice: voiceCfg.preset,
        speed: voiceCfg.speed,
        response_format: voiceCfg.format,
      }
      if (voiceCfg.instruct.trim()) body.instruct = voiceCfg.instruct.trim()
      const result = await call(
        mediaApi.tts({ url: `${base}${pathPart}`, body, ext: voiceCfg.format, name: `speech-${Date.now()}` }),
      )
      setTtsAudio(result.asset)
      notify(`Saved ${formatBytes(result.bytes)} of speech.`)
      await refreshLibrary()
    })

  const previewTts = () =>
    withBusy('tts-preview', async () => {
      const res = await speak(ttsText, voiceCfg)
      notify(res.detail)
      if (!res.ok) throw new Error(res.detail)
    })

  const generateMusic = () =>
    withBusy('music', async () => {
      if (!mediaApi) throw new Error('Desktop bridge unavailable.')
      if (!cfg.musicUrl.trim()) throw new Error('Set a music/SFX endpoint URL first.')
      const result = await call(
        mediaApi.music({
          url: cfg.musicUrl.trim(),
          body: { prompt: musicPrompt, duration_seconds: musicDuration, model: 'musicgen' },
          ext: 'mp3',
          name: `music-${Date.now()}`,
        }),
      )
      setMusicAudio(result.asset)
      notify(`Music saved (${formatBytes(result.bytes)}).`)
      await refreshLibrary()
    })

  const pickAudio = () =>
    withBusy('pick-audio', async () => {
      if (!mediaApi) throw new Error('Desktop bridge unavailable.')
      const picked = await call(
        mediaApi.pickFile([
          { name: 'Audio', extensions: ['mp3', 'wav', 'm4a', 'ogg', 'flac', 'aac'] },
          { name: 'All files', extensions: ['*'] },
        ]),
      )
      if (!picked.cancelled && picked.path) setTranscribePath(picked.path)
    })

  const transcribeAudio = () =>
    withBusy('transcribe', async () => {
      if (!mediaApi) throw new Error('Desktop bridge unavailable.')
      if (!transcribePath) throw new Error('Pick an audio file first.')
      if (!asrUrl) throw new Error('Set a transcription endpoint (Settings → Voice → ASR) first.')
      const result = await call(
        mediaApi.transcribe({ url: asrUrl, model: asrModel, path: transcribePath, language: cfg.language || undefined }),
      )
      setTranscript(result.text)
      notify(`Transcribed ${result.text.length} characters in ${result.segments.length} segments.`)
    })

  const saveTranscript = () =>
    withBusy('save-transcript', async () => {
      if (!mediaApi) throw new Error('Desktop bridge unavailable.')
      if (!transcript.trim()) throw new Error('There is no transcript to save.')
      const asset = await call(mediaApi.saveText(`transcript-${Date.now()}`, transcript, 'txt'))
      notify(`Saved transcript as ${asset.name}.`)
      await refreshLibrary()
    })

  /* ----------------------------------------------------------------- video */

  const videoRef = useRef<HTMLVideoElement>(null)
  const [videoPath, setVideoPath] = useState('')
  const [videoUrl, setVideoUrl] = useState('')
  const [videoFrames, setVideoFrames] = useState<string[]>([])
  const [frameCount, setFrameCount] = useState(6)
  const [videoPrompt, setVideoPrompt] = useState('Describe what happens in this video, step by step.')
  const [videoAnalysis, setVideoAnalysis] = useState('')
  const [videoDuration, setVideoDuration] = useState(0)

  const pickVideo = () =>
    withBusy('pick-video', async () => {
      if (!mediaApi) throw new Error('Desktop bridge unavailable.')
      const picked = await call(
        mediaApi.pickFile([
          { name: 'Video', extensions: ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v'] },
          { name: 'All files', extensions: ['*'] },
        ]),
      )
      if (picked.cancelled || !picked.path) return
      const source = await call(mediaApi.source(picked.path))
      setVideoPath(picked.path)
      setVideoUrl(source.url)
      setVideoFrames([])
      setVideoAnalysis('')
      setVideoDuration(0)
    })

  const captureFrames = () =>
    withBusy('frames', async () => {
      const video = videoRef.current
      if (!video) throw new Error('Load a video first.')
      const duration = video.duration
      if (!Number.isFinite(duration) || duration <= 0) throw new Error('The video has no readable duration.')
      const width = video.videoWidth
      const height = video.videoHeight
      if (!width || !height) throw new Error('The video has no decodable frames.')
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Could not create a canvas.')
      const total = Math.min(12, Math.max(2, Math.round(frameCount)))
      const shots: string[] = []
      const wasPaused = video.paused
      for (let i = 0; i < total; i += 1) {
        const at = (duration * (i + 0.5)) / total
        await new Promise<void>((resolve, reject) => {
          const onSeeked = () => {
            video.removeEventListener('seeked', onSeeked)
            resolve()
          }
          const timer = window.setTimeout(() => {
            video.removeEventListener('seeked', onSeeked)
            reject(new Error('Seeking the video timed out.'))
          }, 8000)
          video.addEventListener('seeked', () => window.clearTimeout(timer))
          video.addEventListener('seeked', onSeeked, { once: true })
          video.currentTime = Math.min(Math.max(at, 0), Math.max(0, duration - 0.05))
        })
        context.drawImage(video, 0, 0, width, height)
        shots.push(canvas.toDataURL('image/jpeg', 0.82))
      }
      if (!wasPaused) void video.play().catch(() => {})
      setVideoFrames(shots)
      notify(`Captured ${shots.length} frames at ${width}×${height}.`)
    })

  const analyzeVideo = () =>
    withBusy('analyze', async () => {
      if (!mediaApi) throw new Error('Desktop bridge unavailable.')
      if (!videoFrames.length) throw new Error('Capture frames first.')
      const result = await call(
        mediaApi.analyze({
          candidates: visionCandidates,
          provider: selectedProvider ?? undefined,
          prompt: videoPrompt,
          images: videoFrames.map((dataUrl) => ({ dataUrl })),
          maxTokens: 1200,
          task: 'vision',
        }),
      )
      setVideoAnalysis(result.text || '(the model returned no text)')
      notify('Video analysis ready.')
    })

  const saveFrame = (dataUrl: string, index: number) =>
    withBusy(`frame-${index}`, async () => {
      if (!mediaApi) throw new Error('Desktop bridge unavailable.')
      const asset = await call(mediaApi.saveImage(dataUrl, `frame-${Date.now()}-${index + 1}`))
      notify(`Frame saved as ${asset.name}.`)
      await refreshLibrary()
    })

  /* ------------------------------------------------------------- subtitles */

  const [subPath, setSubPath] = useState('')
  const [subFormat, setSubFormat] = useState<'srt' | 'vtt'>('srt')
  const [subMaxChars, setSubMaxChars] = useState(42)
  const [subResult, setSubResult] = useState<(OrvexMediaSubtitles & { transcript?: string; segments?: OrvexMediaSubtitleSegment[] }) | null>(null)
  const [manualSub, setManualSub] = useState('1\n00:00:00,000 --> 00:00:02,000\nEdit this cue, then save it.\n')
  const [manualName, setManualName] = useState('subtitles')

  const pickSubFile = () =>
    withBusy('pick-sub', async () => {
      if (!mediaApi) throw new Error('Desktop bridge unavailable.')
      const picked = await call(
        mediaApi.pickFile([
          { name: 'Audio or video', extensions: ['mp3', 'wav', 'm4a', 'ogg', 'flac', 'mp4', 'mov', 'webm', 'mkv'] },
          { name: 'All files', extensions: ['*'] },
        ]),
      )
      if (!picked.cancelled && picked.path) setSubPath(picked.path)
    })

  const makeSubtitles = () =>
    withBusy('subtitles', async () => {
      if (!mediaApi) throw new Error('Desktop bridge unavailable.')
      if (!subPath) throw new Error('Pick an audio or video file first.')
      if (!asrUrl) throw new Error('Set a transcription endpoint (Settings → Voice → ASR) first.')
      const name = `${subPath.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') || 'subtitles'}.${subFormat}`
      const result = await call(
        mediaApi.subtitles({
          url: asrUrl,
          model: asrModel,
          path: subPath,
          language: cfg.language || undefined,
          format: subFormat,
          maxChars: subMaxChars,
          name,
        }),
      )
      setSubResult(result)
      setManualSub(result.text)
      notify(`Wrote ${result.cues} cues (${formatBytes(result.asset.bytes)}).`)
      await refreshLibrary()
    })

  const saveManualSub = () =>
    withBusy('save-sub', async () => {
      if (!mediaApi) throw new Error('Desktop bridge unavailable.')
      const asset = await call(mediaApi.saveSubtitle(manualName || 'subtitles', manualSub, subFormat))
      notify(`Saved ${asset.name}.`)
      await refreshLibrary()
    })

  const loadSubtitleAsset = (asset: OrvexMediaAsset) =>
    withBusy('load-sub', async () => {
      const text = await fetch(asset.url).then((r) => r.text())
      setManualSub(text.trim())
      setManualName(asset.name.replace(/\.[^.]+$/, ''))
      setSubFormat(asset.ext === 'vtt' ? 'vtt' : 'srt')
      notify(`Loaded ${asset.name}.`)
    })

  /* ------------------------------------------------------------------- 3D */

  const [modelInfo, setModelInfo] = useState<{ name: string; path: string; ext: string; bytes: number; meta: Record<string, unknown> } | null>(null)

  const importModel = () =>
    withBusy('import-3d', async () => {
      if (!mediaApi) throw new Error('Desktop bridge unavailable.')
      const picked = await call(mediaApi.importPick())
      if (picked.cancelled || !picked.asset) return
      setModelInfo({
        name: picked.asset.name,
        path: '',
        ext: picked.asset.ext,
        bytes: picked.asset.bytes,
        meta: picked.asset.meta ?? {},
      })
      notify(`Imported ${picked.asset.name}.`)
      await refreshLibrary()
    })

  const inspectModel = () =>
    withBusy('inspect-3d', async () => {
      if (!mediaApi) throw new Error('Desktop bridge unavailable.')
      const picked = await call(
        mediaApi.pickFile([
          { name: '3D models', extensions: ['gltf', 'glb', 'obj', 'stl', 'ply', 'fbx', 'dae', '3ds'] },
          { name: 'All files', extensions: ['*'] },
        ]),
      )
      if (picked.cancelled || !picked.path) return
      const result = await call(mediaApi.inspect3d(picked.path))
      setModelInfo(result)
      notify(`Read ${result.name}.`)
    })

  /* -------------------------------------------------------------- library */

  const [libraryKind, setLibraryKind] = useState<OrvexMediaKind | 'all'>('all')
  const [libraryQuery, setLibraryQuery] = useState('')
  const [previewAsset, setPreviewAsset] = useState<OrvexMediaAsset | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  const visibleAssets = useMemo(() => {
    const q = libraryQuery.trim().toLowerCase()
    return assets.filter((a) => {
      if (libraryKind !== 'all' && a.kind !== libraryKind) return false
      if (!q) return true
      return (
        a.name.toLowerCase().includes(q) ||
        String(a.prompt || '').toLowerCase().includes(q) ||
        String(a.model || '').toLowerCase().includes(q)
      )
    })
  }, [assets, libraryKind, libraryQuery])

  const importAny = () =>
    withBusy('import', async () => {
      if (!mediaApi) throw new Error('Desktop bridge unavailable.')
      const picked = await call(mediaApi.importPick())
      if (picked.cancelled || !picked.asset) return
      notify(`Imported ${picked.asset.name}.`)
      await refreshLibrary()
    })

  const removeAsset = (asset: OrvexMediaAsset) =>
    withBusy(`delete-${asset.id}`, async () => {
      if (!mediaApi) throw new Error('Desktop bridge unavailable.')
      if (!window.confirm(`Delete "${asset.name}" from the media library?`)) return
      await call(mediaApi.remove(asset.id))
      if (previewAsset?.id === asset.id) setPreviewAsset(null)
      notify(`Deleted ${asset.name}.`)
      await refreshLibrary()
    })

  const renameAsset = (asset: OrvexMediaAsset) =>
    withBusy(`rename-${asset.id}`, async () => {
      if (!mediaApi) throw new Error('Desktop bridge unavailable.')
      const next = renameValue.trim()
      if (!next) throw new Error('Name is empty.')
      await call(mediaApi.rename(asset.id, next))
      setRenaming(null)
      setRenameValue('')
      notify('Renamed.')
      await refreshLibrary()
    })

  const exportAsset = (asset: OrvexMediaAsset) =>
    withBusy(`export-${asset.id}`, async () => {
      if (!mediaApi) throw new Error('Desktop bridge unavailable.')
      const result = await call(mediaApi.exportAsset(asset.id))
      if (result.cancelled) return
      notify(`Exported to ${result.path}`)
    })

  /* -------------------------------------------------------------- prompts */

  const [promptQuery, setPromptQuery] = useState('')
  const [promptTitle, setPromptTitle] = useState('')
  const [promptTags, setPromptTags] = useState('')
  const [promptKind, setPromptKind] = useState('image')
  const [promptFavorite, setPromptFavorite] = useState(false)
  const [editingPrompt, setEditingPrompt] = useState<string | null>(null)

  const visiblePrompts = useMemo(() => {
    const q = promptQuery.trim().toLowerCase()
    if (!q) return prompts
    return prompts.filter(
      (p) => p.text.toLowerCase().includes(q) || p.title.toLowerCase().includes(q) || p.tags.some((t) => t.includes(q)),
    )
  }, [prompts, promptQuery])

  const savePromptRow = () =>
    withBusy('save-prompt', async () => {
      if (!mediaApi) throw new Error('Desktop bridge unavailable.')
      if (!prompt.trim()) throw new Error('Write the prompt text first.')
      await call(
        mediaApi.savePrompt({
          id: editingPrompt ?? undefined,
          title: promptTitle,
          text: prompt,
          kind: promptKind,
          tags: promptTags.split(',').map((t) => t.trim()).filter(Boolean),
          favorite: promptFavorite,
        }),
      )
      setEditingPrompt(null)
      setPromptTitle('')
      setPromptTags('')
      setPromptFavorite(false)
      notify('Prompt saved.')
      await refreshPrompts()
    })

  const usePromptRow = (row: OrvexMediaPrompt) =>
    withBusy(`use-prompt-${row.id}`, async () => {
      if (!mediaApi) throw new Error('Desktop bridge unavailable.')
      setPrompt(row.text)
      setTab('images')
      await mediaApi.usePrompt(row.id)
      notify(`Loaded "${row.title}" into the image prompt.`)
      await refreshPrompts()
    })

  const removePromptRow = (row: OrvexMediaPrompt) =>
    withBusy(`del-prompt-${row.id}`, async () => {
      if (!mediaApi) throw new Error('Desktop bridge unavailable.')
      if (!window.confirm(`Delete the prompt "${row.title}"?`)) return
      await call(mediaApi.deletePrompt(row.id))
      notify('Prompt deleted.')
      await refreshPrompts()
    })

  /* ---------------------------------------------------------------- render */

  const activeBusy = (key: string) => busy === key

  return (
    <PageShell
      title="Media"
      sub="Real image generation, editing, upscaling, speech, music, subtitles and 3D assets"
      onBack={onBack}
      actions={
        <button className="page-tool-btn" onClick={() => void refreshLibrary().catch(fail)} title="Refresh library" aria-label="Refresh library">
          <RefreshCw size={14} />
        </button>
      }
    >
      {!mediaApi && (
        <div className="md-banner">
          <AlertTriangle size={14} />
          <div>
            <strong>Browser mode.</strong> Media generation and the asset library run through the desktop app. Start it with <code>npm run desktop:dev</code>.
          </div>
        </div>
      )}

      <div className="md-page">
        <div className="md-tabs" role="tablist" aria-label="Media tools" onKeyDown={onTablistKeyDown}>
          {TABS.map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.id}
                role="tab"
                aria-selected={tab === item.id}
                tabIndex={tab === item.id ? 0 : -1}
                className={`md-tab ${tab === item.id ? 'active' : ''}`}
                onClick={() => setTab(item.id)}
              >
                <Icon size={13} />
                {item.label}
              </button>
            )
          })}
          <span className="md-tabs-hint">
            {info ? `${info.assets} assets · ${info.prompts} prompts` : 'library'}
            {assets.length ? ` · ${assets.filter((a) => a.kind === 'image').length} images` : ''}
          </span>
        </div>

        {error && (
          <div className="md-error">
            <AlertTriangle size={13} />
            <span>{error}</span>
            <button onClick={() => setError('')} aria-label="Dismiss error">
              <X size={12} />
            </button>
          </div>
        )}

        <div className="md-body">
          {tab === 'images' && (
            <div className="md-stack">
              {!providerReady(selectedProvider) && (
                <div className="md-note">
                  <AlertTriangle size={13} />
                  <span>
                    {selectedProvider
                      ? `${selectedProvider.name} has no API key. Add one in Settings → Providers, or pick a local image endpoint.`
                      : 'Add an image provider (OpenAI, Gemini, Together, OpenRouter or a local endpoint) in Settings → Providers.'}
                  </span>
                </div>
              )}

              <section className="md-card">
                <div className="md-card-head">
                  <Wand2 size={14} />
                  <h3>Generate an image</h3>
                </div>
                <label className="md-field">
                  <span>Prompt</span>
                  <textarea className="text-input md-textarea" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="A cinematic photo of a lighthouse at dusk, volumetric fog, 35mm" rows={3} />
                </label>
                <div className="md-row">
                  <label className="md-field">
                    <span>Provider</span>
                    <select
                      className="select"
                      value={selectedProvider?.id ?? ''}
                      onChange={(e) => {
                        const next = imageProviderOptions.find((p) => p.id === e.target.value) ?? null
                        setCfg({ imageProviderId: e.target.value, imageModel: defaultImageModel(next), editModel: '' })
                      }}
                    >
                      {imageProviderOptions.length === 0 && <option value="">No image-capable provider</option>}
                      {imageProviderOptions.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="md-field">
                    <span>Model</span>
                    <input className="text-input" value={cfg.imageModel} onChange={(e) => setCfg({ imageModel: e.target.value })} placeholder={defaultImageModel(selectedProvider) || 'gpt-image-1'} />
                  </label>
                  <label className="md-field">
                    <span>Size</span>
                    <select className="select" value={size} onChange={(e) => setSize(e.target.value)}>
                      {IMAGE_SIZES.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="md-field md-field-narrow">
                    <span>Count</span>
                    <input className="text-input" type="number" min={1} max={4} value={count} onChange={(e) => setCount(Math.max(1, Math.min(4, Number(e.target.value) || 1)))} />
                  </label>
                  <button className="btn-primary md-btn" onClick={() => void generate()} disabled={!!busy || !prompt.trim()}>
                    {activeBusy('generate') ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />}
                    Generate
                  </button>
                </div>
              </section>

              <section className="md-card">
                <div className="md-card-head">
                  <ImageIcon size={14} />
                  <h3>Edit, cut out or upscale</h3>
                </div>
                <div className="md-row">
                  <label className="md-field">
                    <span>Image from library</span>
                    <select className="select" value={editAssetId} onChange={(e) => setEditAssetId(e.target.value)}>
                      <option value="">Choose an image…</option>
                      {imageAssets.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="md-field md-field-grow">
                    <span>Edit instruction</span>
                    <input className="text-input" value={editPrompt} onChange={(e) => setEditPrompt(e.target.value)} placeholder="Make the sky stormy and add rain" />
                  </label>
                </div>
                <div className="md-row">
                  <label className="md-field">
                    <span>Edit model</span>
                    <input className="text-input" value={cfg.editModel} onChange={(e) => setCfg({ editModel: e.target.value })} placeholder={cfg.imageModel || defaultImageModel(selectedProvider) || 'gpt-image-1'} />
                  </label>
                  <button className="btn-ghost md-btn" onClick={() => void editImage('edit')} disabled={!!busy || !editAssetId || !editPrompt.trim()}>
                    {activeBusy('edit') ? <Loader2 size={13} className="spin" /> : <Wand2 size={13} />}
                    Apply edit
                  </button>
                  <button className="btn-ghost md-btn" onClick={() => void editImage('background')} disabled={!!busy || !editAssetId}>
                    {activeBusy('background') ? <Loader2 size={13} className="spin" /> : <Layers size={13} />}
                    Remove background
                  </button>
                  <label className="md-field md-field-narrow">
                    <span>Scale</span>
                    <select className="select" value={upFactor} onChange={(e) => setUpFactor(Number(e.target.value))}>
                      {[2, 3, 4, 8].map((f) => (
                        <option key={f} value={f}>
                          {f}×
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="md-check">
                    <input type="checkbox" checked={sharpen} onChange={(e) => setSharpen(e.target.checked)} />
                    sharpen
                  </label>
                  <button className="btn-ghost md-btn" onClick={() => void upscale()} disabled={!!busy || !editAssetId}>
                    {activeBusy('upscale') ? <Loader2 size={13} className="spin" /> : <Maximize2 size={13} />}
                    Upscale
                  </button>
                </div>
                <p className="md-hint">
                  Upscaling runs locally with Lanczos resampling and works without any provider. Background removal is done by the provider you selected.
                </p>
              </section>

              {imageResults.length > 0 && (
                <section className="md-card">
                  <div className="md-card-head">
                    <ImageIcon size={14} />
                    <h3>Latest results</h3>
                  </div>
                  <div className="md-grid">
                    {imageResults.map((asset) => (
                      <AssetTile key={asset.id} asset={asset} onOpen={() => setPreviewAsset(asset)} />
                    ))}
                  </div>
                </section>
              )}
            </div>
          )}

          {tab === 'audio' && (
            <div className="md-stack">
              <section className="md-card">
                <div className="md-card-head">
                  <AudioLines size={14} />
                  <h3>TTS studio</h3>
                  <span className="md-chip">{voiceCfg.engine === 'browser' ? 'browser voice' : voiceCfg.engine}</span>
                </div>
                <p className="md-hint">
                  {voiceCfg.engine === 'browser'
                    ? 'Preview uses the browser voice. Saving a file needs a TTS server — configure it in Settings → Voice.'
                    : `Speaks through ${voiceCfg.serverUrl}${voiceCfg.synthPath}.`}
                </p>
                <label className="md-field">
                  <span>Text</span>
                  <textarea className="text-input md-textarea" value={ttsText} onChange={(e) => setTtsText(e.target.value)} rows={4} placeholder="Write what ORVEX should say…" />
                </label>
                <div className="md-row">
                  <label className="md-field">
                    <span>Voice (Settings → Voice)</span>
                    <input
                      className="text-input"
                      value={VOICE_PRESETS.find((v) => v.id === voiceCfg.preset)?.name ?? voiceCfg.preset}
                      readOnly
                    />
                  </label>
                  <label className="md-field md-field-narrow">
                    <span>Format</span>
                    <input className="text-input" value={voiceCfg.format} readOnly />
                  </label>
                  <button className="btn-ghost md-btn" onClick={() => void previewTts()} disabled={!!busy || !ttsText.trim()}>
                    {activeBusy('tts-preview') ? <Loader2 size={13} className="spin" /> : <AudioLines size={13} />}
                    Preview
                  </button>
                  <button className="btn-primary md-btn" onClick={() => void synthesize()} disabled={!!busy || !ttsText.trim() || voiceCfg.engine === 'browser'}>
                    {activeBusy('tts') ? <Loader2 size={13} className="spin" /> : <Save size={13} />}
                    Save audio
                  </button>
                </div>
                {ttsAudio && (
                  <div className="md-audio-row">
                    <audio controls src={ttsAudio.url} />
                    <span>{ttsAudio.name} · {formatBytes(ttsAudio.bytes)}</span>
                  </div>
                )}
              </section>

              <section className="md-card">
                <div className="md-card-head">
                  <Music size={14} />
                  <h3>Music &amp; SFX</h3>
                </div>
                <p className="md-hint">
                  Point this at any HTTP music/SFX endpoint that accepts JSON and returns audio bytes (or JSON with an audio URL).
                </p>
                <div className="md-row">
                  <label className="md-field md-field-grow">
                    <span>Endpoint URL</span>
                    <input className="text-input" value={cfg.musicUrl} onChange={(e) => setCfg({ musicUrl: e.target.value })} placeholder="http://localhost:8001/v1/music/generate" />
                  </label>
                  <label className="md-field">
                    <span>API key {musicKeySaved ? '(saved)' : '(optional)'}</span>
                    <div className="md-inline">
                      <input className="text-input" type="password" value={musicKey} onChange={(e) => setMusicKey(e.target.value)} placeholder={musicKeySaved ? '••••••••' : 'key'} />
                      <button className="btn-ghost md-btn" onClick={() => void saveMusicKey()}>Save key</button>
                    </div>
                  </label>
                </div>
                <label className="md-field">
                  <span>Prompt</span>
                  <textarea className="text-input md-textarea" value={musicPrompt} onChange={(e) => setMusicPrompt(e.target.value)} rows={2} placeholder="Warm cinematic pad with soft drums, 120 bpm" />
                </label>
                <div className="md-row">
                  <label className="md-field md-field-narrow">
                    <span>Seconds</span>
                    <input className="text-input" type="number" min={1} max={180} value={musicDuration} onChange={(e) => setMusicDuration(Math.max(1, Math.min(180, Number(e.target.value) || 10)))} />
                  </label>
                  <button className="btn-primary md-btn" onClick={() => void generateMusic()} disabled={!!busy || !musicPrompt.trim() || !cfg.musicUrl.trim()}>
                    {activeBusy('music') ? <Loader2 size={13} className="spin" /> : <Music size={13} />}
                    Generate music
                  </button>
                </div>
                {musicAudio && (
                  <div className="md-audio-row">
                    <audio controls src={musicAudio.url} />
                    <span>{musicAudio.name} · {formatBytes(musicAudio.bytes)}</span>
                  </div>
                )}
              </section>

              <section className="md-card">
                <div className="md-card-head">
                  <FileText size={14} />
                  <h3>Transcription</h3>
                </div>
                <p className="md-hint">Endpoint: {asrUrl || 'not configured — set it in Settings → Voice → ASR.'}</p>
                <div className="md-row">
                  <button className="btn-ghost md-btn" onClick={() => void pickAudio()} disabled={!!busy}>
                    <FolderOpen size={13} />
                    Pick audio
                  </button>
                  <span className="md-path" title={transcribePath}>{transcribePath || 'No file selected'}</span>
                  <label className="md-field">
                    <span>Language (optional)</span>
                    <input className="text-input" value={cfg.language} onChange={(e) => setCfg({ language: e.target.value })} placeholder="en" />
                  </label>
                  <button className="btn-primary md-btn" onClick={() => void transcribeAudio()} disabled={!!busy || !transcribePath || !asrUrl}>
                    {activeBusy('transcribe') ? <Loader2 size={13} className="spin" /> : <AudioLines size={13} />}
                    Transcribe
                  </button>
                </div>
                {transcript && (
                  <>
                    <textarea className="text-input md-textarea md-mono" value={transcript} onChange={(e) => setTranscript(e.target.value)} rows={8} aria-label="Transcript" />
                    <div className="md-row">
                      <button className="btn-ghost md-btn" onClick={() => void saveTranscript()} disabled={!!busy}>
                        <Save size={13} /> Save to library
                      </button>
                      <button
                        className="btn-ghost md-btn"
                        onClick={() => {
                          void navigator.clipboard.writeText(transcript).then(() => notify('Transcript copied.')).catch(fail)
                        }}
                      >
                        <Copy size={13} /> Copy
                      </button>
                    </div>
                  </>
                )}
              </section>

              {audioAssets.length > 0 && (
                <section className="md-card">
                  <div className="md-card-head">
                    <AudioLines size={14} />
                    <h3>Audio in the library</h3>
                  </div>
                  <div className="md-stack-tight">
                    {audioAssets.slice(0, 8).map((asset) => (
                      <div key={asset.id} className="md-audio-row">
                        <audio controls preload="metadata" src={asset.url} />
                        <span>{asset.name} · {formatBytes(asset.bytes)}</span>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>
          )}

          {tab === 'video' && (
            <div className="md-stack">
              <section className="md-card">
                <div className="md-card-head">
                  <Video size={14} />
                  <h3>Video understanding</h3>
                </div>
                <p className="md-hint">
                  ORVEX samples real frames from the file and sends them to your vision model. No frame is invented — if the browser cannot decode the codec, it will say so.
                </p>
                <div className="md-row">
                  <button className="btn-ghost md-btn" onClick={() => void pickVideo()} disabled={!!busy}>
                    <FolderOpen size={13} /> Pick video
                  </button>
                  <span className="md-path" title={videoPath}>{videoPath || 'No video selected'}</span>
                  <label className="md-field md-field-narrow">
                    <span>Frames</span>
                    <input className="text-input" type="number" min={2} max={12} value={frameCount} onChange={(e) => setFrameCount(Math.max(2, Math.min(12, Number(e.target.value) || 6)))} />
                  </label>
                  <button className="btn-ghost md-btn" onClick={() => void captureFrames()} disabled={!!busy || !videoUrl}>
                    {activeBusy('frames') ? <Loader2 size={13} className="spin" /> : <Film size={13} />}
                    Capture frames
                  </button>
                </div>
                {videoUrl && (
                  <video
                    ref={videoRef}
                    className="md-video"
                    src={videoUrl}
                    controls
                    muted
                    preload="metadata"
                    onLoadedMetadata={(e) => setVideoDuration(e.currentTarget.duration || 0)}
                  />
                )}
                {videoUrl && <p className="md-hint">Duration: {videoDuration ? `${videoDuration.toFixed(1)}s` : 'reading…'}</p>}
                {videoFrames.length > 0 && (
                  <>
                    <div className="md-frames">
                      {videoFrames.map((frame, index) => (
                        <figure key={index} className="md-frame">
                          <img src={frame} alt={`Frame ${index + 1}`} />
                          <button onClick={() => void saveFrame(frame, index)} title="Save frame to library" aria-label={`Save frame ${index + 1}`}>
                            <Download size={12} />
                          </button>
                        </figure>
                      ))}
                    </div>
                    <label className="md-field">
                      <span>Question</span>
                      <textarea className="text-input md-textarea" value={videoPrompt} onChange={(e) => setVideoPrompt(e.target.value)} rows={2} />
                    </label>
                    <button className="btn-primary md-btn" onClick={() => void analyzeVideo()} disabled={!!busy}>
                      {activeBusy('analyze') ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />}
                      Analyze with vision model
                    </button>
                  </>
                )}
                {videoAnalysis && (
                  <div className="md-analysis">
                    <div className="md-analysis-head">
                      <Sparkles size={12} /> Analysis
                    </div>
                    <pre>{videoAnalysis}</pre>
                  </div>
                )}
              </section>

              {videoAssets.length > 0 && (
                <section className="md-card">
                  <div className="md-card-head">
                    <Film size={14} />
                    <h3>Video in the library</h3>
                  </div>
                  <div className="md-grid">
                    {videoAssets.map((asset) => (
                      <AssetTile key={asset.id} asset={asset} onOpen={() => setPreviewAsset(asset)} />
                    ))}
                  </div>
                </section>
              )}
            </div>
          )}

          {tab === 'subtitles' && (
            <div className="md-stack">
              <section className="md-card">
                <div className="md-card-head">
                  <Subtitles size={14} />
                  <h3>Transcribe to subtitles</h3>
                </div>
                <p className="md-hint">
                  Uses your OpenAI-compatible ASR endpoint with timestamps, then writes real SRT/VTT cues with line wrapping.
                </p>
                <div className="md-row">
                  <button className="btn-ghost md-btn" onClick={() => void pickSubFile()} disabled={!!busy}>
                    <FolderOpen size={13} /> Pick audio or video
                  </button>
                  <span className="md-path" title={subPath}>{subPath || 'No file selected'}</span>
                  <label className="md-field md-field-narrow">
                    <span>Format</span>
                    <select className="select" value={subFormat} onChange={(e) => setSubFormat(e.target.value as 'srt' | 'vtt')}>
                      <option value="srt">SRT</option>
                      <option value="vtt">VTT</option>
                    </select>
                  </label>
                  <label className="md-field md-field-narrow">
                    <span>Line length</span>
                    <input className="text-input" type="number" min={16} max={120} value={subMaxChars} onChange={(e) => setSubMaxChars(Math.max(16, Math.min(120, Number(e.target.value) || 42)))} />
                  </label>
                  <button className="btn-primary md-btn" onClick={() => void makeSubtitles()} disabled={!!busy || !subPath || !asrUrl}>
                    {activeBusy('subtitles') ? <Loader2 size={13} className="spin" /> : <Subtitles size={13} />}
                    Build subtitles
                  </button>
                </div>
                {subResult && (
                  <p className="md-hint">
                    {subResult.cues} cues · {formatBytes(subResult.asset.bytes)} · saved as {subResult.asset.name}
                  </p>
                )}
              </section>

              <section className="md-card">
                <div className="md-card-head">
                  <FileText size={14} />
                  <h3>Subtitle editor</h3>
                  <span className="md-chip">{subFormat.toUpperCase()}</span>
                </div>
                <div className="md-row">
                  <label className="md-field md-field-grow">
                    <span>File name</span>
                    <input className="text-input" value={manualName} onChange={(e) => setManualName(e.target.value)} />
                  </label>
                  <button className="btn-ghost md-btn" onClick={() => void saveManualSub()} disabled={!!busy || !manualSub.trim()}>
                    {activeBusy('save-sub') ? <Loader2 size={13} className="spin" /> : <Save size={13} />}
                    Save subtitle file
                  </button>
                </div>
                <textarea className="text-input md-textarea md-mono" value={manualSub} onChange={(e) => setManualSub(e.target.value)} rows={12} aria-label="Subtitle text" spellCheck={false} />
              </section>

              {subtitleAssets.length > 0 && (
                <section className="md-card">
                  <div className="md-card-head">
                    <Subtitles size={14} />
                    <h3>Subtitle files</h3>
                  </div>
                  <div className="md-stack-tight">
                    {subtitleAssets.map((asset) => (
                      <div key={asset.id} className="md-list-row">
                        <FileText size={13} />
                        <span className="md-list-name">{asset.name}</span>
                        <span className="md-muted">{formatBytes(asset.bytes)} · {formatDate(asset.createdAt)}</span>
                        <button className="btn-ghost md-btn md-btn-sm" onClick={() => void loadSubtitleAsset(asset)}>Edit</button>
                        <button className="btn-ghost md-btn md-btn-sm" onClick={() => void exportAsset(asset)}>Export</button>
                        <button className="md-icon-btn" onClick={() => void removeAsset(asset)} aria-label={`Delete ${asset.name}`}>
                          <Trash2 size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>
          )}

          {tab === 'models3d' && (
            <div className="md-stack">
              <section className="md-card">
                <div className="md-card-head">
                  <Box size={14} />
                  <h3>3D models</h3>
                </div>
                <p className="md-hint">
                  Import glTF, GLB, OBJ, STL, PLY or FBX files. ORVEX reads the real scene structure — meshes, nodes, vertices, materials and animations — and keeps the file in the library.
                </p>
                <div className="md-row">
                  <button className="btn-primary md-btn" onClick={() => void importModel()} disabled={!!busy}>
                    {activeBusy('import-3d') ? <Loader2 size={13} className="spin" /> : <Upload size={13} />}
                    Import 3D model
                  </button>
                  <button className="btn-ghost md-btn" onClick={() => void inspectModel()} disabled={!!busy}>
                    {activeBusy('inspect-3d') ? <Loader2 size={13} className="spin" /> : <Search size={13} />}
                    Inspect a file
                  </button>
                </div>
                {modelInfo && (
                  <div className="md-model">
                    <div className="md-model-head">
                      <Box size={13} /> {modelInfo.name} <span className="md-muted">{modelInfo.ext.toUpperCase()} · {formatBytes(modelInfo.bytes)}</span>
                    </div>
                    <div className="md-meta-grid">
                      {Object.entries(modelInfo.meta).map(([key, value]) => (
                        <div key={key} className="md-meta-cell">
                          <span>{key}</span>
                          <b>{typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value ?? '—')}</b>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </section>

              {modelAssets.length > 0 && (
                <section className="md-card">
                  <div className="md-card-head">
                    <Box size={14} />
                    <h3>Imported models</h3>
                  </div>
                  <div className="md-stack-tight">
                    {modelAssets.map((asset) => (
                      <div key={asset.id} className="md-list-row">
                        <Box size={13} />
                        <span className="md-list-name">{asset.name}</span>
                        <span className="md-muted">
                          {formatBytes(asset.bytes)} · {String((asset.meta as Record<string, unknown> | null)?.meshes ?? '—')} meshes
                        </span>
                        <button className="btn-ghost md-btn md-btn-sm" onClick={() => { void mediaApi?.open(asset.id).then((r) => { if (!r.ok) fail(r.error) }).catch(fail) }}>
                          Open
                        </button>
                        <button className="md-icon-btn" onClick={() => void removeAsset(asset)} aria-label={`Delete ${asset.name}`}>
                          <Trash2 size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>
          )}

          {tab === 'library' && (
            <div className="md-stack">
              <div className="md-toolbar">
                <div className="md-search">
                  <Search size={12} />
                  <input value={libraryQuery} onChange={(e) => setLibraryQuery(e.target.value)} placeholder="Search name, prompt, model…" aria-label="Search media library" />
                </div>
                <div className="md-filters">
                  {KIND_FILTERS.map((k) => (
                    <button key={k.id} className={`md-filter ${libraryKind === k.id ? 'active' : ''}`} onClick={() => setLibraryKind(k.id)}>
                      {k.label}
                    </button>
                  ))}
                </div>
                <button className="btn-ghost md-btn" onClick={() => void importAny()} disabled={!!busy}>
                  {activeBusy('import') ? <Loader2 size={13} className="spin" /> : <Upload size={13} />}
                  Import
                </button>
              </div>

              {visibleAssets.length === 0 ? (
                <div className="md-empty">
                  <Library size={22} />
                  <p>No assets here yet. Generate an image, transcribe audio, or import a file.</p>
                </div>
              ) : (
                <div className="md-grid">
                  {visibleAssets.map((asset) => (
                    <div key={asset.id} className="md-asset-card">
                      <button className="md-asset-preview" onClick={() => setPreviewAsset(asset)} aria-label={`Preview ${asset.name}`}>
                        <AssetPreview asset={asset} />
                      </button>
                      <div className="md-asset-body">
                        <div className="md-asset-title" title={asset.name}>{asset.name}</div>
                        <div className="md-asset-meta">
                          <span className="md-kind">{assetKindLabel(asset.kind)}</span>
                          <span>{formatBytes(asset.bytes)}</span>
                          <span>{formatDate(asset.createdAt)}</span>
                        </div>
                        {asset.prompt && <p className="md-asset-prompt" title={asset.prompt}>{asset.prompt}</p>}
                        {renaming === asset.id ? (
                          <div className="md-inline">
                            <input className="text-input" value={renameValue} onChange={(e) => setRenameValue(e.target.value)} aria-label="New asset name" autoFocus />
                            <button className="btn-primary md-btn md-btn-sm" onClick={() => void renameAsset(asset)}>Save</button>
                            <button className="btn-ghost md-btn md-btn-sm" onClick={() => setRenaming(null)}>Cancel</button>
                          </div>
                        ) : null}
                        <div className="md-asset-actions">
                          <button className="md-icon-btn" onClick={() => exportAsset(asset)} title="Export" aria-label={`Export ${asset.name}`}>
                            <Download size={12} />
                          </button>
                          <button className="md-icon-btn" onClick={() => { setRenaming(asset.id); setRenameValue(asset.name) }} title="Rename" aria-label={`Rename ${asset.name}`}>
                            <FileText size={12} />
                          </button>
                          <button
                            className="md-icon-btn"
                            onClick={() => {
                              void mediaApi?.reveal(asset.id).then((r) => { if (!r.ok) fail(r.error) }).catch(fail)
                            }}
                            title="Show in folder"
                            aria-label={`Show ${asset.name} in folder`}
                          >
                            <ExternalLink size={12} />
                          </button>
                          <button className="md-icon-btn danger" onClick={() => void removeAsset(asset)} title="Delete" aria-label={`Delete ${asset.name}`}>
                            <Trash2 size={12} />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === 'prompts' && (
            <div className="md-stack">
              <section className="md-card">
                <div className="md-card-head">
                  <Sparkles size={14} />
                  <h3>{editingPrompt ? 'Edit prompt' : 'Save the current prompt'}</h3>
                </div>
                <label className="md-field">
                  <span>Prompt text</span>
                  <textarea className="text-input md-textarea" value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} placeholder="The prompt text to keep…" />
                </label>
                <div className="md-row">
                  <label className="md-field">
                    <span>Title</span>
                    <input className="text-input" value={promptTitle} onChange={(e) => setPromptTitle(e.target.value)} placeholder="Optional title" />
                  </label>
                  <label className="md-field">
                    <span>Tags</span>
                    <input className="text-input" value={promptTags} onChange={(e) => setPromptTags(e.target.value)} placeholder="portrait, neon" />
                  </label>
                  <label className="md-field">
                    <span>Kind</span>
                    <select className="select" value={promptKind} onChange={(e) => setPromptKind(e.target.value)}>
                      <option value="image">image</option>
                      <option value="video">video</option>
                      <option value="music">music</option>
                      <option value="speech">speech</option>
                    </select>
                  </label>
                  <label className="md-check">
                    <input type="checkbox" checked={promptFavorite} onChange={(e) => setPromptFavorite(e.target.checked)} />
                    favorite
                  </label>
                  <button className="btn-primary md-btn" onClick={() => void savePromptRow()} disabled={!!busy || !prompt.trim()}>
                    {activeBusy('save-prompt') ? <Loader2 size={13} className="spin" /> : <Save size={13} />}
                    {editingPrompt ? 'Update' : 'Save prompt'}
                  </button>
                </div>
              </section>

              <div className="md-toolbar">
                <div className="md-search">
                  <Search size={12} />
                  <input value={promptQuery} onChange={(e) => setPromptQuery(e.target.value)} placeholder="Search prompts…" aria-label="Search prompts" />
                </div>
                <span className="md-tabs-hint">{visiblePrompts.length} prompts</span>
              </div>

              {visiblePrompts.length === 0 ? (
                <div className="md-empty">
                  <Sparkles size={22} />
                  <p>No prompts saved yet.</p>
                </div>
              ) : (
                <div className="md-prompt-grid">
                  {visiblePrompts.map((row) => (
                    <article key={row.id} className="md-prompt-card">
                      <header>
                        <button
                          className={`md-star ${row.favorite ? 'on' : ''}`}
                          onClick={() => {
                            void mediaApi
                              ?.savePrompt({ id: row.id, text: row.text, favorite: !row.favorite })
                              .then(() => refreshPrompts())
                              .catch(fail)
                          }}
                          aria-label={row.favorite ? 'Unfavorite prompt' : 'Favorite prompt'}
                        >
                          <Star size={12} />
                        </button>
                        <div>
                          <h4>{row.title}</h4>
                          <span className="md-muted">{row.kind} · used {row.uses}×</span>
                        </div>
                      </header>
                      <p>{row.text}</p>
                      {row.tags.length > 0 && (
                        <div className="md-tags">
                          {row.tags.map((tag) => (
                            <span key={tag}>#{tag}</span>
                          ))}
                        </div>
                      )}
                      <footer>
                        <button className="btn-ghost md-btn md-btn-sm" onClick={() => void usePromptRow(row)}>Use</button>
                        <button
                          className="btn-ghost md-btn md-btn-sm"
                          onClick={() => {
                            setPrompt(row.text)
                            setPromptTitle(row.title)
                            setPromptTags(row.tags.join(', '))
                            setPromptKind(row.kind)
                            setPromptFavorite(row.favorite)
                            setEditingPrompt(row.id)
                          }}
                        >
                          Edit
                        </button>
                        <button className="md-icon-btn danger" onClick={() => void removePromptRow(row)} aria-label={`Delete prompt ${row.title}`}>
                          <Trash2 size={12} />
                        </button>
                      </footer>
                    </article>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {previewAsset && (
          <div className="md-preview" role="dialog" aria-label="Asset preview">
            <div className="md-preview-box">
              <header>
                <div>
                  <strong>{previewAsset.name}</strong>
                  <span className="md-muted">
                    {assetKindLabel(previewAsset.kind)} · {formatBytes(previewAsset.bytes)} · {formatDate(previewAsset.createdAt)}
                  </span>
                </div>
                <button className="md-icon-btn" onClick={() => setPreviewAsset(null)} aria-label="Close preview">
                  <X size={13} />
                </button>
              </header>
              <div className="md-preview-body">
                {previewAsset.kind === 'image' && <img src={previewAsset.url} alt={previewAsset.name} />}
                {previewAsset.kind === 'audio' && <audio controls src={previewAsset.url} />}
                {previewAsset.kind === 'video' && <video controls src={previewAsset.url} />}
                {previewAsset.kind !== 'image' && previewAsset.kind !== 'audio' && previewAsset.kind !== 'video' && (
                  <div className="md-preview-file">
                    {previewAsset.kind === 'model' ? <Box size={34} /> : <FileText size={34} />}
                    <p>Preview is not rendered for {assetKindLabel(previewAsset.kind)} files — open it with the default app or export it.</p>
                  </div>
                )}
                {previewAsset.prompt && (
                  <div className="md-prompt-line">
                    <span>Prompt</span>
                    <p>{previewAsset.prompt}</p>
                  </div>
                )}
              </div>
              <footer>
                <button className="btn-ghost md-btn md-btn-sm" onClick={() => void exportAsset(previewAsset)}>
                  <Download size={12} /> Export
                </button>
                <button
                  className="btn-ghost md-btn md-btn-sm"
                  onClick={() => {
                    void mediaApi?.open(previewAsset.id).then((r) => { if (!r.ok) fail(r.error) }).catch(fail)
                  }}
                >
                  <ExternalLink size={12} /> Open
                </button>
                <button className="btn-ghost md-btn md-btn-sm" onClick={() => void removeAsset(previewAsset)}>
                  <Trash2 size={12} /> Delete
                </button>
              </footer>
            </div>
          </div>
        )}
      </div>
    </PageShell>
  )
}

function AssetPreview({ asset }: { asset: OrvexMediaAsset }) {
  if (asset.kind === 'image') return <img src={asset.url} alt={asset.name} loading="lazy" />
  if (asset.kind === 'video') return <video src={asset.url} preload="metadata" muted />
  if (asset.kind === 'audio') return <div className="md-asset-icon"><Clapperboard size={22} /></div>
  if (asset.kind === 'model') return <div className="md-asset-icon"><Box size={22} /></div>
  if (asset.kind === 'subtitle') return <div className="md-asset-icon"><Subtitles size={22} /></div>
  return <div className="md-asset-icon"><FileText size={22} /></div>
}

function AssetTile({ asset, onOpen }: { asset: OrvexMediaAsset; onOpen: () => void }) {
  return (
    <button className="md-result" onClick={onOpen} aria-label={`Open ${asset.name}`}>
      <AssetPreview asset={asset} />
      <span>{asset.name}</span>
    </button>
  )
}
