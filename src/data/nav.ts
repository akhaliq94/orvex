/** A sidebar shortcut that opens an existing tab on the destination page. */
export type NavLink = { label: string; tab: string }

export type NavItem = { id: string; label: string; submenu?: NavLink[] }

export const NAV_ITEMS: NavItem[] = [
  { id: 'home', label: 'Home' },
  { id: 'chat', label: 'Chat' },
  { id: 'voice', label: 'Voice' },
  {
    id: 'agents',
    label: 'Agents',
    submenu: [
      { label: 'Personas', tab: 'overview' },
      { label: 'SOUL.md', tab: 'soul' },
      { label: 'Tools', tab: 'tools' },
    ],
  },
  { id: 'workforce', label: 'Workforce' },
  { id: 'advisor', label: 'Advisor' },
  { id: 'engine', label: 'Engine' },  { id: 'code', label: 'Code' },
  { id: 'maker', label: 'Maker' },
  { id: 'browser', label: 'Browser' },
  { id: 'research', label: 'Research' },
  { id: 'files', label: 'Files' },
  { id: 'media', label: 'Media' },
  { id: 'automation', label: 'Automation' },
  { id: 'tools', label: 'Tools' },
  { id: 'productivity', label: 'Productivity' },
  {
    id: 'training',
    label: 'Training',
    submenu: [
      { label: 'Overview', tab: 'overview' },
      { label: 'Vault & quota', tab: 'vault' },
      { label: 'Episodes', tab: 'episodes' },
      { label: 'Skills & scorer', tab: 'skills' },
      { label: 'Train kit', tab: 'kit' },
      { label: 'Fine-tune', tab: 'tune' },
      { label: 'Local brain', tab: 'brain' },
    ],
  },
  { id: 'advanced', label: 'Advanced' },
  { id: 'knowledge', label: 'Knowledge' },
  { id: 'memory', label: 'Memory' },
  { id: 'integrations', label: 'Integrations' },
  {
    id: 'monitoring',
    label: 'Monitoring',
    submenu: [
      { label: 'Overview', tab: 'overview' },
      { label: 'Usage & cost', tab: 'usage' },
      { label: 'Traces', tab: 'traces' },
      { label: 'Compare', tab: 'compare' },
      { label: 'Evals', tab: 'evals' },
      { label: 'Health', tab: 'health' },
      { label: 'Recovery', tab: 'recovery' },
    ],
  },
  {
    id: 'security',
    label: 'Security',
    submenu: [
      { label: 'Overview', tab: 'overview' },
      { label: 'Permissions', tab: 'permissions' },
      { label: 'Secrets', tab: 'secrets' },
      { label: 'Policy', tab: 'policy' },
      { label: 'Audit', tab: 'audit' },
      { label: 'Backup', tab: 'backup' },
      { label: 'Privacy', tab: 'privacy' },
    ],
  },
  {
    id: 'system',
    label: 'System',
    submenu: [
      { label: 'Monitor', tab: 'monitor' },
      { label: 'Goals', tab: 'goals' },
      { label: 'Failures', tab: 'failures' },
    ],
  },
  { id: 'control-pc', label: 'Control PC' },
  { id: 'game', label: 'Game Pilot' },
  { id: 'air-touch', label: 'Air Touch' },
  { id: 'settings', label: 'Settings' },
]
