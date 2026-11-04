import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertOctagon } from 'lucide-react'
import Header from './components/Header'
import Sidebar from './components/Sidebar'
import Hero from './components/Hero'
import RightColumn from './components/RightColumn'
import SystemStatus from './components/SystemStatus'
import ActivityPanel from './components/ActivityPanel'
import AgentsPanel from './components/AgentsPanel'
import BottomStrip from './components/BottomStrip'
import GlobalSearch, { type PaletteCommand } from './components/GlobalSearch'
import { Toast } from './components/Overlays'
import LockScreen from './components/LockScreen'
import VoiceFocus from './components/VoiceFocus'
import Pages, { isPage } from './pages/Pages'
import { THEMES, themeVars, type Theme } from './themes'
import { useVoice } from './hooks/useVoice'
import { useDashboard } from './hooks/useDashboard'
import { useSecurity } from './hooks/useSecurity'
import type { OrvexSecurityStatus } from './types/desktop'
import { readVoiceConfig } from './data/stt'
import { ProvidersProvider } from './hooks/useProviders'
import { BackgroundProvider, useBackground } from './hooks/useBackground'
import { VoiceSettingsProvider } from './data/voice'
import {
  clearNotifications,
  clearRead,
  markAllRead,
  markRead,
  notificationsStore,
  pushNotification,
  unreadCount,
  useStore,
  type FeedKind,
  type Notification,
} from './data/stores'

export default function App() {
  const [themeId, setThemeId] = useState('default')
  const [auto, setAuto] = useState(false)
  const [activeNav, setActiveNav] = useState('home')
  const [pageTab, setPageTab] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [chatPrompt, setChatPrompt] = useState<string | null>(null)
  const [chatConvId, setChatConvId] = useState<string | null>(null)
  const [chatAgentId, setChatAgentId] = useState<string | null>(null)
  const [chatDraft, setChatDraft] = useState<string | null>(null)
  const [notifOpen, setNotifOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)

  const voice = useVoice()
  const dash = useDashboard()
  const security = useSecurity()
  const locked = Boolean(security.status?.locked)
  const listening = voice.status === 'listening' || voice.status === 'starting'
  const theme = THEMES.find((t) => t.id === themeId) ?? THEMES[0]

  const notify = useCallback((msg: string) => setToast(msg), [])

  // A locked app should not keep the microphone open.
  const stopVoiceRef = useRef(voice.stop)
  stopVoiceRef.current = voice.stop
  useEffect(() => {
    if (locked) stopVoiceRef.current()
  }, [locked])

  const clearEmergency = async () => {
    const bridge = typeof window !== 'undefined' ? window.orvex : undefined
    if (!bridge) return
    const res = await bridge.security.emergencyClear()
    if (res.ok) {
      security.setStatus(res.data)
      notify('Emergency stop cleared')
    } else {
      notify(res.error)
    }
  }

  useEffect(() => {
    if (!toast) return
    const id = window.setTimeout(() => setToast(null), 3000)
    return () => window.clearTimeout(id)
  }, [toast])

  useEffect(() => {
    if (!auto) return
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const apply = () => setThemeId(mq.matches ? 'light' : 'default')
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [auto])

  // global search hotkey
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The lock screen owns the keyboard; the palette must not open behind it.
      if (locked) return
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearchOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [locked])

  // Locking must also dismiss anything that was open on top of the app.
  useEffect(() => {
    if (!locked) return
    setSearchOpen(false)
    setNotifOpen(false)
  }, [locked])

  const selectTheme = (t: Theme) => {
    setThemeId(t.id)
    setAuto(false)
    notify(`${t.name} theme applied`)
  }

  const toggleAuto = () => {
    setAuto((v) => !v)
    notify(auto ? 'Manual theme selection' : 'Following system appearance')
  }

  const toggleListening = () => {
    if (listening) {
      voice.stop()
    } else {
      void voice.start()
    }
  }

  const handleCommand = (text: string) => {
    setChatPrompt(text)
    setChatConvId(null)
    setChatAgentId(null)
    setChatDraft(null)
    setActiveNav('chat')
  }

  const handleOpenChat = (agentId: string, draft?: string) => {
    setChatAgentId(agentId)
    setChatDraft(draft ?? null)
    setChatPrompt(null)
    setChatConvId(null)
    setActiveNav('chat')
  }

  const handleAction = (id: string) => {
    if (id === 'chat') {
      setChatPrompt(null)
      setChatConvId(null)
      setChatAgentId(null)
      setChatDraft(null)
      setPageTab(null)
      setActiveNav('chat')
      return
    }
    setPageTab(null)
    setActiveNav(id)
  }

  const navRef = useRef(activeNav)
  navRef.current = activeNav
  const commandRef = useRef(handleCommand)
  commandRef.current = handleCommand

  // Hands-free wake word: the mic keeps listening while ORVEX is open, and a
  // detected phrase either runs the spoken command or opens the chat composer.
  useEffect(() => {
    voice.setWakeHandler((command) => {
      if (navRef.current === 'chat') return
      const text = command.trim()
      if (text) {
        commandRef.current(text)
        setToast('Wake word detected — running your command')
      } else {
        setChatPrompt(null)
        setChatConvId(null)
        setActiveNav('chat')
        setToast('Wake word detected — speak your command')
      }
    })
    return () => voice.setWakeHandler(null)
  }, [voice])

  // Reopen the mic on launch when wake word was left enabled.
  const wakeBootRef = useRef(false)
  useEffect(() => {
    if (wakeBootRef.current) return
    wakeBootRef.current = true
    if (readVoiceConfig().wakeEnabled) void voice.start()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleNavigate = (id: string, _label?: string, tab?: string) => {
    setActiveNav(id)
    setPageTab(tab ?? null)
    if (id !== 'chat') {
      setChatPrompt(null)
      setChatConvId(null)
      setChatAgentId(null)
      setChatDraft(null)
    }
  }

  const onHome = () => handleNavigate('home')

  const openConversation = (id: string) => {
    setChatConvId(id)
    setChatPrompt(null)
    setChatAgentId(null)
    setChatDraft(null)
    setActiveNav('chat')
    setSearchOpen(false)
  }

  const paletteCommands = useMemo<PaletteCommand[]>(() => {
    const bridge = typeof window !== 'undefined' ? window.orvex : undefined
    const desktopOnly = () => notify('This action needs the ORVEX desktop app.')
    return [
      {
        id: 'notifications',
        title: 'Open notifications',
        sub: 'Command',
        hint: 'Inbox',
        run: () => setNotifOpen((v) => !v),
      },
      {
        id: 'mini-window',
        title: 'Toggle mini window',
        sub: 'Command',
        hint: 'Always on top',
        run: async () => {
          if (!bridge) return desktopOnly()
          const res = await bridge.app.window('toggleMini')
          if (!res.ok) return notify(res.error)
          await new Promise((r) => window.setTimeout(r, 350))
          const state = await bridge.app.window('state')
          if (!state.ok) return notify(state.error)
          notify(state.data.miniVisible ? 'Mini window opened' : 'Mini window hidden')
        },
      },
      {
        id: 'minimize',
        title: 'Minimize ORVEX',
        sub: 'Command',
        hint: 'Window',
        run: async () => {
          if (!bridge) return desktopOnly()
          const res = await bridge.app.window('minimize')
          if (!res.ok) notify(res.error)
        },
      },
      {
        id: 'lock',
        title: 'Lock ORVEX',
        sub: 'Command',
        hint: 'Security',
        run: async () => {
          if (!bridge) return desktopOnly()
          const res = await bridge.security.lock()
          if (res.ok) {
            security.setStatus(res.data)
            notify('ORVEX locked')
          } else {
            notify(res.error)
          }
        },
      },
      {
        id: 'new-chat',
        title: 'New chat',
        sub: 'Command',
        hint: 'Chat',
        run: () => {
          setChatConvId(null)
          setChatAgentId(null)
          setChatDraft(null)
          setChatPrompt(null)
          setPageTab(null)
          setActiveNav('chat')
        },
      },
    ]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notify, security.setStatus])

  return (
    <ProvidersProvider>
      <BackgroundProvider>
        <VoiceSettingsProvider>
          <AppShell
            themeId={themeId}
            auto={auto}
            activeNav={activeNav}
            pageTab={pageTab}
            dash={dash}
            toast={toast}
            chatPrompt={chatPrompt}
            chatConvId={chatConvId}
            chatAgentId={chatAgentId}
            chatDraft={chatDraft}
            notifOpen={notifOpen}
            searchOpen={searchOpen}
            voice={voice}
            listening={listening}
            theme={theme}
            security={security.status}
            onSecurityStatus={security.setStatus}
            onClearEmergency={() => void clearEmergency()}
            notify={notify}
            selectTheme={selectTheme}
            toggleAuto={toggleAuto}
            toggleListening={toggleListening}
            handleCommand={handleCommand}
            handleAction={handleAction}
            handleNavigate={handleNavigate}
            handleOpenChat={handleOpenChat}
            onHome={onHome}
            setNotifOpen={setNotifOpen}
            setSearchOpen={setSearchOpen}
            openConversation={openConversation}
            paletteCommands={paletteCommands}
          />
        </VoiceSettingsProvider>
      </BackgroundProvider>
    </ProvidersProvider>
  )
}

function AppShell(p: {
  themeId: string
  auto: boolean
  activeNav: string
  pageTab: string | null
  dash: ReturnType<typeof useDashboard>
  toast: string | null
  chatPrompt: string | null
  chatConvId: string | null
  chatAgentId: string | null
  chatDraft: string | null
  notifOpen: boolean
  searchOpen: boolean
  voice: ReturnType<typeof useVoice>
  listening: boolean
  theme: Theme
  security: OrvexSecurityStatus | null
  onSecurityStatus: (s: OrvexSecurityStatus) => void
  onClearEmergency: () => void
  notify: (m: string) => void
  selectTheme: (t: Theme) => void
  toggleAuto: () => void
  toggleListening: () => void
  handleCommand: (t: string) => void
  handleAction: (id: string) => void
  handleNavigate: (id: string, label?: string, tab?: string) => void
  handleOpenChat: (agentId: string, draft?: string) => void
  onHome: () => void
  setNotifOpen: React.Dispatch<React.SetStateAction<boolean>>
  setSearchOpen: React.Dispatch<React.SetStateAction<boolean>>
  openConversation: (id: string) => void
  paletteCommands: PaletteCommand[]
}) {
  const { style: bgStyle } = useBackground()
  const notifications = useStore(notificationsStore)
  const unread = useMemo(() => unreadCount(notifications), [notifications])

  const navigateRef = useRef(p.handleNavigate)
  navigateRef.current = p.handleNavigate

  // Real main-process notifications (agent runs, approvals, workflows) land in
  // the in-app inbox, and the mini window can route the main window anywhere.
  useEffect(() => {
    const bridge = typeof window !== 'undefined' ? window.orvex : undefined
    if (!bridge) return
    const offNavigate = bridge.app.onNavigate(({ id, tab }) => navigateRef.current(id, undefined, tab ?? undefined))
    const offNotify = bridge.app.onNotify((note) => {
      const kinds: FeedKind[] = ['agent', 'system', 'user', 'job', 'voice', 'model']
      pushNotification({
        title: note.title,
        body: note.body,
        kind: kinds.includes(note.kind as FeedKind) ? (note.kind as FeedKind) : 'system',
        target: note.target,
        runId: note.runId,
      })
    })
    return () => {
      offNavigate()
      offNotify()
    }
  }, [])

  const closeNotifications = () => {
    p.setNotifOpen(false)
  }

  const openNotification = (n: Notification) => {
    markRead(n.id)
    if (n.target) {
      p.handleNavigate(n.target)
      p.setNotifOpen(false)
    }
  }

  return (
    <div className="orvex-app" style={{ ...themeVars(p.theme), ...bgStyle }} data-theme={p.theme.id}>
      <div className="grid-overlay" />

      {p.security?.emergency.stopped && (
        <div className="sec-emergency-banner" role="alert">
          <AlertOctagon size={15} />
          <span className="sec-emergency-text">
            Emergency stop is active{p.security.emergency.reason ? ` — ${p.security.emergency.reason}` : ''}. Agents, workflows and
            model streams stay halted until it is cleared.
          </span>
          {p.security.role === 'owner' ? (
            <button className="ghost-btn" onClick={p.onClearEmergency}>
              Clear stop
            </button>
          ) : (
            <span className="sec-chip">owner only</span>
          )}
          <button className="ghost-btn" onClick={() => p.handleNavigate('security')}>
            Security
          </button>
        </div>
      )}

      <Header
        voice={p.voice}
        snapshot={p.dash.snapshot}
        onToggleListening={p.toggleListening}
        onOpenSettings={() => p.handleNavigate('settings')}
        onOpenSystem={() => p.handleNavigate('system', undefined, 'monitor')}
        onOpenNotifications={() => p.setNotifOpen((v) => !v)}
        onOpenSearch={() => p.setSearchOpen(true)}
        onNotice={p.notify}
        hasUnread={unread > 0}
      />

      <Sidebar active={p.activeNav} onNavigate={p.handleNavigate} />

      {isPage(p.activeNav) ? (
        <Pages
          view={p.activeNav}
          deps={{
            onBack: p.onHome,
            notify: p.notify,
            onNavigate: p.handleNavigate,
            voice: p.voice,
            onToggleListening: p.toggleListening,
            chatPrompt: p.chatPrompt,
            chatConvId: p.chatConvId,
            chatAgentId: p.chatAgentId,
            chatDraft: p.chatDraft,
            pageTab: p.pageTab,
            snapshot: p.dash.snapshot,
            onOpenChat: p.handleOpenChat,
            themeId: p.themeId,
            auto: p.auto,
            onSelectTheme: p.selectTheme,
            onToggleAuto: p.toggleAuto,
          }}
        />
      ) : (
        <>
          <Hero
            voice={p.voice}
            user={p.dash.snapshot?.system.user}
            onToggleListening={p.toggleListening}
            onCommand={p.handleCommand}
            onAction={p.handleAction}
          />

          <div className="widgets-area">
            <div className="widgets">
              <SystemStatus
                snapshot={p.dash.snapshot}
                history={p.dash.history}
                error={p.dash.error}
                onOpenSystem={() => p.handleNavigate('system')}
              />
              <ActivityPanel snapshot={p.dash.snapshot} />
              <AgentsPanel snapshot={p.dash.snapshot} onOpenAgents={() => p.handleNavigate('agents')} />
            </div>
          </div>

          <BottomStrip snapshot={p.dash.snapshot} notify={p.notify} />
        </>
      )}

      <RightColumn snapshot={p.dash.snapshot} notify={p.notify} onNavigate={p.handleNavigate} />

      <GlobalSearch
        open={p.searchOpen}
        onClose={() => p.setSearchOpen(false)}
        onNavigate={(id, tab) => {
          p.handleNavigate(id, undefined, tab)
          p.setSearchOpen(false)
        }}
        onOpenConversation={p.openConversation}
        commands={p.paletteCommands}
      />

      <Toast message={p.toast} />

      {p.notifOpen && (
        <div className="notif-panel panel" role="dialog" aria-label="Notifications">
          <div className="agent-log-head">
            <span>
              Notifications{unread > 0 ? ` · ${unread} unread` : ''}
            </span>
            <div className="ml-auto flex gap-1.5">
              <button className="ghost-btn !h-[20px] !text-[9px]" onClick={markAllRead} disabled={unread === 0}>
                Mark all read
              </button>
              <button className="ghost-btn !h-[20px] !text-[9px]" onClick={clearRead} disabled={notifications.every((n) => !n.read)}>
                Clear read
              </button>
              <button className="ghost-btn !h-[20px] !text-[9px]" onClick={clearNotifications} disabled={notifications.length === 0}>
                Clear all
              </button>
              <button className="page-tool-btn" onClick={closeNotifications} aria-label="Close notifications">
                ✕
              </button>
            </div>
          </div>
          <div className="agent-log-body">
            {notifications.length === 0 && (
              <p className="dim">No notifications yet — agent runs, approvals and workflow alerts land here.</p>
            )}
            {notifications.map((n: Notification) => (
              <button
                key={n.id}
                className={`notif-row ${n.read ? 'read' : ''}`}
                onClick={() => openNotification(n)}
                title={n.target ? `Open ${n.target}` : 'Mark as read'}
              >
                <span className="notif-dot" style={{ background: n.read ? 'transparent' : 'var(--accent)' }} />
                <span className="notif-text">
                  <strong>{n.title}</strong>
                  <span>{n.body}</span>
                </span>
                <span className="notif-time">{timeAgo(n.at)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <VoiceFocus voice={p.voice} />

      {p.security?.locked && <LockScreen status={p.security} onStatus={p.onSecurityStatus} />}
    </div>
  )
}

function timeAgo(at: number) {
  const s = Math.max(0, Math.floor((Date.now() - at) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}
