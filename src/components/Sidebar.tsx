import { useState } from 'react'
import {
  Activity,
  BookOpen,
  Brain,
  Briefcase,
  ChevronRight,
  Code2,
  Cpu,
  Clapperboard,
  FolderOpen,
  Gamepad2,
  Globe2,
  GraduationCap,
  Hammer,
  Hand,
  Home,
  Lightbulb,
  MessageSquare,
  Mic,
  Microscope,
  Monitor,
  Plug,
  RefreshCcw,
  Settings,
  ShieldCheck,
  Sparkles,
  UserCog,
  Users,
  Wrench,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { NAV_ITEMS } from '../data/nav'

const ICONS: Record<string, LucideIcon> = {
  home: Home,
  chat: MessageSquare,
  voice: Mic,
  agents: Users,
  workforce: UserCog,
  advisor: Lightbulb,
  engine: Cpu,
  code: Code2,
  maker: Hammer,
  browser: Globe2,
  research: Microscope,
  files: FolderOpen,
  media: Clapperboard,
  automation: RefreshCcw,
  tools: Wrench,
  productivity: Briefcase,
  training: GraduationCap,
  advanced: Sparkles,
  knowledge: BookOpen,
  memory: Brain,
  integrations: Plug,
  monitoring: Activity,
  security: ShieldCheck,
  system: Settings,
  'control-pc': Monitor,
  game: Gamepad2,
  'air-touch': Hand,
  settings: Settings,
}

type Props = { active: string; onNavigate: (id: string, label: string, tab?: string) => void }

export default function Sidebar({ active, onNavigate }: Props) {
  const [open, setOpen] = useState<string | null>(null)

  return (
    <aside className="sidebar-area">
      <nav className="sidebar panel" aria-label="Primary">
        {NAV_ITEMS.map((item) => {
          const Icon = ICONS[item.id]
          const isActive = active === item.id
          const expanded = open === item.id
          return (
            <div key={item.id}>
              <button
                className={`nav-item w-full ${isActive ? 'active' : ''}`}
                onClick={() => {
                  onNavigate(item.id, item.label)
                  if (item.submenu) setOpen(expanded ? null : item.id)
                }}
                aria-current={isActive ? 'page' : undefined}
                aria-expanded={item.submenu ? expanded : undefined}
              >
                <Icon size={17} strokeWidth={1.7} />
                <span className="nav-label">{item.label}</span>
                {item.submenu && (
                  <ChevronRight
                    size={13}
                    className="nav-chevron"
                    style={{ transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform .2s ease' }}
                  />
                )}
              </button>
              {item.submenu && expanded && (
                <div className="nav-sub">
                  {item.submenu.map((s) => (
                    <button
                      key={s.tab}
                      className="nav-sub-item"
                      onClick={() => onNavigate(item.id, `${item.label} · ${s.label}`, s.tab)}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </nav>
    </aside>
  )
}
