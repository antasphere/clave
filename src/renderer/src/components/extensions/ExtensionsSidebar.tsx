import {
  ChevronLeftIcon,
  BuildingStorefrontIcon,
  ServerStackIcon
} from '@heroicons/react/24/outline'
import { useSessionStore, type ExtensionsSection } from '../../store/session-store'
import { WordmarkStrip } from '../layout/Wordmark'

const SECTIONS: {
  id: ExtensionsSection
  label: string
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>
}[] = [
  { id: 'marketplaces', label: 'Marketplaces', icon: BuildingStorefrontIcon },
  { id: 'mcp', label: 'MCP Servers', icon: ServerStackIcon }
]

/** Extensions-mode replacement for the sessions sidebar. */
export function ExtensionsSidebar() {
  const extensionsSection = useSessionStore((s) => s.extensionsSection)
  const setExtensionsSection = useSessionStore((s) => s.setExtensionsSection)
  const setActiveView = useSessionStore((s) => s.setActiveView)

  return (
    <div className="flex flex-col h-full bg-surface-50">
      {/* The same top band the sessions sidebar opens with — traffic-light
          clearance, the mark, and the offset the panel below starts at. This
          view replaces that sidebar whole, so the band has to come with it or
          the app's only mark disappears the moment you step in here. */}
      <WordmarkStrip />

      {/* Header: back to sessions + title */}
      <div className="px-2 pb-2 flex items-center gap-1.5 flex-shrink-0">
        <button
          onClick={() => setActiveView('terminals')}
          className="btn-icon btn-icon-xs"
          title="Back to sessions"
          aria-label="Back to sessions"
        >
          <ChevronLeftIcon className="w-4 h-4" />
        </button>
        <span className="text-control font-semibold text-text-primary select-none">Extensions</span>
      </div>

      <nav className="px-2 space-y-0.5">
        {SECTIONS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setExtensionsSection(id)}
            className="sidebar-item"
            data-selected={extensionsSection === id ? 'true' : undefined}
          >
            <Icon className="w-4 h-4 flex-shrink-0 opacity-60" />
            <span>{label}</span>
          </button>
        ))}
      </nav>
    </div>
  )
}
