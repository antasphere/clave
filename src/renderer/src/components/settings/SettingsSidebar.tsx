import {
  ChevronLeftIcon,
  AdjustmentsHorizontalIcon,
  SwatchIcon,
  ArrowDownTrayIcon,
  ChartBarIcon,
  CommandLineIcon,
  PuzzlePieceIcon,
  CpuChipIcon
} from '@heroicons/react/24/outline'
import { useUpdaterStore } from '../../store/updater-store'
import { useSessionStore, type SettingsSection } from '../../store/session-store'
import { WordmarkStrip } from '../layout/Wordmark'

type Row = {
  id: SettingsSection
  label: string
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>
}

/** The pages, grouped the way a reader looks for them: what the app is like
 *  to use, what runs inside it, and the app itself. */
const GROUPS: { label: string; rows: Row[] }[] = [
  {
    label: 'Preferences',
    rows: [
      { id: 'general', label: 'General', icon: AdjustmentsHorizontalIcon },
      { id: 'appearance', label: 'Appearance', icon: SwatchIcon },
      { id: 'keymaps', label: 'Keymaps', icon: CommandLineIcon }
    ]
  },
  {
    label: 'Agents',
    rows: [
      { id: 'agents', label: 'Agents', icon: CpuChipIcon },
      { id: 'usage', label: 'Usage', icon: ChartBarIcon }
    ]
  },
  {
    label: 'Clave',
    rows: [
      { id: 'plugins', label: 'Plugins', icon: PuzzlePieceIcon },
      { id: 'updates', label: 'Software Update', icon: ArrowDownTrayIcon }
    ]
  }
]

/** Settings-mode replacement for the sessions sidebar. */
export function SettingsSidebar(): React.JSX.Element {
  const settingsSection = useSessionStore((s) => s.settingsSection)
  const setSettingsSection = useSessionStore((s) => s.setSettingsSection)
  const setActiveView = useSessionStore((s) => s.setActiveView)
  const updatePhase = useUpdaterStore((s) => s.phase)
  // A waiting update earns a dot on its row — the same signal macOS puts on
  // System Settings, and the reason a user thinks to look here at all.
  const updateWaiting = updatePhase === 'available' || updatePhase === 'downloaded'

  return (
    <div className="flex flex-col h-full bg-surface-50">
      {/* The same top band the sessions sidebar opens with — traffic-light
          clearance, the mark, and the offset the panel below starts at. This
          view replaces that sidebar whole, so the band has to come with it or
          the app's only mark disappears the moment you step in here. */}
      <WordmarkStrip />

      {/* Header: back to sessions + title, in the launcher's own panel so the
          settings sidebar opens with the same band the sessions sidebar does. */}
      <div className="px-2 pb-1 flex-shrink-0">
        <div className="launcher-panel">
          <div className="launcher-row">
            <button
              onClick={() => setActiveView('terminals')}
              className="launcher-icon-btn"
              title="Back to sessions"
              aria-label="Back to sessions"
            >
              <ChevronLeftIcon className="w-4 h-4" />
            </button>
            <span className="launcher-sep" />
            <span
              data-testid="settings-nav-title"
              className="px-2 text-control font-medium text-text-primary select-none truncate"
            >
              Settings
            </span>
          </div>
        </div>
      </div>

      <nav className="px-2 overflow-y-auto" data-settings-nav>
        {GROUPS.map((group) => (
          <div key={group.label}>
            <div className="settings-nav-label">{group.label}</div>
            <div className="space-y-0.5">
              {group.rows.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  onClick={() => setSettingsSection(id)}
                  className="sidebar-item"
                  data-selected={settingsSection === id ? 'true' : undefined}
                  data-settings-nav-row={id}
                >
                  <Icon className="w-4 h-4 flex-shrink-0 opacity-60" />
                  <span className="truncate">{label}</span>
                  {id === 'updates' && updateWaiting && (
                    <span className="ml-auto w-2 h-2 rounded-full bg-accent flex-shrink-0" />
                  )}
                </button>
              ))}
            </div>
          </div>
        ))}
      </nav>
    </div>
  )
}
