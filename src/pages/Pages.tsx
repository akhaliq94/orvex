import ChatPage from './ChatPage'
import VoicePage from './VoicePage'
import AgentsPage from './AgentsPage'
import WorkforcePage from './WorkforcePage'
import AdvisorPage from './AdvisorPage'
import EnginePage from './EnginePage'
import CodePage from './CodePage'
import MakerPage from './MakerPage'
import BrowserPage from './BrowserPage'
import ResearchPage from './ResearchPage'
import FilesPage from './FilesPage'
import MediaPage from './MediaPage'
import AutomationPage from './AutomationPage'
import ToolsPage from './ToolsPage'
import ProductivityPage from './ProductivityPage'
import AdvancedPage from './AdvancedPage'
import TrainingPage from './TrainingPage'
import KnowledgePage from './KnowledgePage'
import MemoryPage from './MemoryPage'
import IntegrationsPage from './IntegrationsPage'
import MonitoringPage from './MonitoringPage'
import SecurityPage from './SecurityPage'
import SystemPage from './SystemPage'
import ControlPcPage from './ControlPcPage'
import GamePilotPage from './GamePilotPage'
import AirTouchPage from './AirTouchPage'
import SettingsPage from './SettingsPage'
import type { Voice } from '../hooks/useVoice'
import type { Theme } from '../themes'
import type { OrvexDashboardSnapshot } from '../types/desktop'

type Deps = {
  onBack: () => void
  notify: (msg: string) => void
  onNavigate: (id: string, label?: string, tab?: string) => void
  voice: Voice
  onToggleListening: () => void
  handsFree: boolean
  onHandsFreeChange: (enabled: boolean) => void
  chatPrompt: string | null
  chatConvId: string | null
  chatAgentId: string | null
  chatDraft: string | null
  pageTab: string | null
  snapshot: OrvexDashboardSnapshot | null
  onOpenChat: (agentId: string, draft?: string) => void
  themeId: string
  auto: boolean
  onSelectTheme: (t: Theme) => void
  onToggleAuto: () => void
}

/** All sidebar/action destinations except 'home', which renders the dashboard. */
export const PAGE_IDS = [
  'chat',
  'voice',
  'agents',
  'workforce',
  'advisor',
  'engine',
  'code',
  'maker',
  'browser',
  'research',
  'files',
  'media',
  'automation',
  'tools',
  'productivity',
  'training',
  'advanced',
  'knowledge',
  'memory',
  'integrations',
  'monitoring',
  'security',
  'system',
  'control-pc',
  'game',
  'air-touch',
  'settings',
] as const

export type PageId = (typeof PAGE_IDS)[number]

export function isPage(id: string): id is PageId {
  return (PAGE_IDS as readonly string[]).includes(id)
}

export default function Pages({ view, deps }: { view: PageId; deps: Deps }) {
  const {
    onBack,
    notify,
    onNavigate,
    voice,
    onToggleListening,
    handsFree,
    onHandsFreeChange,
    chatPrompt,
    chatConvId,
    chatAgentId,
    chatDraft,
    pageTab,
    snapshot,
    onOpenChat,
    themeId,
    auto,
    onSelectTheme,
    onToggleAuto,
  } = deps
  switch (view) {
    case 'chat':
      return (
        <ChatPage
          onBack={onBack}
          initialPrompt={chatPrompt}
          initialConvId={chatConvId}
          initialAgentId={chatAgentId}
          initialDraft={chatDraft}
          voice={voice}
          handsFree={handsFree}
          onHandsFreeChange={onHandsFreeChange}
        />
      )
    case 'voice':
      return <VoicePage onBack={onBack} voice={voice} onToggleListening={onToggleListening} notify={notify} />
    case 'agents':
      return (
        <AgentsPage
          onBack={onBack}
          notify={notify}
          snapshot={snapshot}
          onOpenChat={onOpenChat}
          initialTab={pageTab}
        />
      )
    case 'workforce':
      return <WorkforcePage onBack={onBack} notify={notify} />
    case 'advisor':
      return <AdvisorPage onBack={onBack} notify={notify} onNavigate={onNavigate} />
    case 'engine':
      return <EnginePage onBack={onBack} notify={notify} voice={voice} />
    case 'code':
      return <CodePage onBack={onBack} notify={notify} />
    case 'maker':
      return <MakerPage onBack={onBack} notify={notify} />
    case 'browser':
      return <BrowserPage onBack={onBack} notify={notify} />
    case 'research':
      return <ResearchPage onBack={onBack} notify={notify} />
    case 'files':
      return <FilesPage onBack={onBack} notify={notify} />
    case 'media':
      return <MediaPage onBack={onBack} notify={notify} />
    case 'automation':
      return <AutomationPage onBack={onBack} notify={notify} />
    case 'tools':
      return <ToolsPage onBack={onBack} />
    case 'productivity':
      return <ProductivityPage onBack={onBack} notify={notify} initialTab={pageTab} />
    case 'training':
      return <TrainingPage onBack={onBack} notify={notify} initialTab={pageTab} />
    case 'advanced':
      return <AdvancedPage onBack={onBack} notify={notify} initialTab={pageTab} />
    case 'knowledge':
      return <KnowledgePage onBack={onBack} notify={notify} />
    case 'memory':
      return <MemoryPage onBack={onBack} notify={notify} />
    case 'integrations':
      return <IntegrationsPage onBack={onBack} notify={notify} />
    case 'monitoring':
      return <MonitoringPage onBack={onBack} notify={notify} initialTab={pageTab} />
    case 'security':
      return <SecurityPage onBack={onBack} notify={notify} initialTab={pageTab} />
    case 'system':
      return <SystemPage onBack={onBack} notify={notify} snapshot={snapshot} initialTab={pageTab} />
    case 'control-pc':
      return <ControlPcPage onBack={onBack} voice={voice} onToggleListening={onToggleListening} notify={notify} />
    case 'game':
      return <GamePilotPage onBack={onBack} notify={notify} />
    case 'air-touch':
      return <AirTouchPage onBack={onBack} notify={notify} />
    case 'settings':
      return (
        <SettingsPage
          onBack={onBack}
          notify={notify}
          themeId={themeId}
          auto={auto}
          onSelectTheme={onSelectTheme}
          onToggleAuto={onToggleAuto}
        />
      )
  }
}
