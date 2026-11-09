import { useState } from 'react'
import { ClockIcon } from '@heroicons/react/24/outline'
import { Popover, PopoverContent, PopoverTrigger } from '@clave/ui/components'
import { LOCAL_SERVER_ID } from '@clave/contract/fleet'
import { useRoutineSurfaces } from '../../store/routines-store'
import { usePairingStore } from '../../store/pairing-store'
import { useWorkspaceStore } from '../../store/workspace-store'
import { getTerminalIconComponent } from '../ui/terminal-icons'
import { resolveColorHex, type GroupTerminalIcon } from '../../store/session-types'
import { RoutinePanel } from './RoutinePanel'
import { RunGlyph } from '../../../../../plugins/routine-report/src/RunGlyph'
import { routineBadge, routineInk } from './routine-badge'
import { routineTitle } from './routine-title'
import type { RoutineSurface } from './routine-servers'

/**
 * The routines of the active workspace in the toolbar (ADR 0004): one button
 * per routine, its icon in its colour, grouped by the group that declares
 * them, with the one signal `routineBadge` decides, drawn on the icon's
 * corner with the sidebar's own glyphs (`RunGlyph`): its spinner while a run
 * is in flight, its check, warning, question or cross while the last run is
 * unseen; and the floating panel on a click. A routine a connected server
 * runs (PRDCT-4149) shows here too, its view that server's, with a small mark
 * in the server's colour on the icon's other corner.
 */
export function RoutineToolbar(): React.JSX.Element | null {
  const surfaces = useRoutineSurfaces()
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const serverColors = usePairingStore((s) => s.servers)
  const [openKey, setOpenKey] = useState<string | null>(null)
  const shown = surfaces.filter((s) => !activeWorkspaceId || s.workspaceId === activeWorkspaceId)
  if (shown.length === 0) return null
  const groups = new Map<string, RoutineSurface[]>()
  for (const s of shown) {
    const key = `${s.serverId}::${s.view.routine.file}::${s.view.routine.group}`
    groups.set(key, [...(groups.get(key) ?? []), s])
  }
  return (
    <>
      {[...groups.entries()].map(([groupKey, members], index) => (
        <div
          key={groupKey}
          className="flex items-center gap-0.5 flex-shrink-0"
          data-testid="routine-group"
        >
          {index > 0 && <div className="w-px h-3.5 bg-border-subtle mx-0.5" />}
          {members.map((surface) => {
            const view = surface.view
            const badge = routineBadge(view, surface)
            const Icon = view.routine.icon
              ? getTerminalIconComponent(view.routine.icon as GroupTerminalIcon)
              : ClockIcon
            const color = routineInk(resolveColorHex(view.routine.color ?? undefined))
            // A server's routine and this Mac's may share a key (the same
            // file path on both): the server id keeps them apart.
            const id = `${surface.serverId}::${view.routine.key}`
            const open = openKey === id
            const remote = surface.serverId !== LOCAL_SERVER_ID
            const serverColor = remote ? serverColors[surface.serverId]?.color : undefined
            return (
              <Popover key={id} open={open} onOpenChange={(o) => setOpenKey(o ? id : null)}>
                <PopoverTrigger asChild>
                  <button
                    className="btn-icon btn-icon-md relative routine-button"
                    style={{ color }}
                    title={routineTitle(view, surface)}
                    data-testid="routine-button"
                    data-routine={view.routine.name}
                    data-server={remote ? surface.serverId : undefined}
                    data-state={badge.state}
                  >
                    <Icon className="w-4 h-4" />
                    {remote && (
                      <span
                        data-testid="routine-server-mark"
                        title={surface.serverName}
                        aria-hidden="true"
                        className="absolute rounded-full pointer-events-none"
                        style={{
                          left: 3,
                          bottom: 3,
                          width: 6,
                          height: 6,
                          background: serverColor ?? 'currentColor',
                          opacity: serverColor ? 1 : 0.6
                        }}
                      />
                    )}
                    {badge.working ? (
                      <RunGlyph tone="running" size="badge" testId="routine-working" />
                    ) : badge.dot ? (
                      <RunGlyph tone={badge.dot} size="badge" testId="routine-dot" />
                    ) : null}
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  animated
                  motion="rise"
                  open={open}
                  side="bottom"
                  align="end"
                  sideOffset={8}
                  className="p-0 overflow-hidden"
                  onFocusOutside={(e) => e.preventDefault()}
                  // Focus stays on the panel, not on its first tab: a ring on
                  // Report the moment the panel opens read as a selection
                  // border. The keyboard still tabs in from the panel.
                  onOpenAutoFocus={(e) => {
                    e.preventDefault()
                    ;(e.currentTarget as HTMLElement | null)
                      ?.querySelector<HTMLElement>('[data-testid="routine-panel"]')
                      ?.focus()
                  }}
                >
                  <RoutinePanel
                    surface={surface}
                    icon={<Icon />}
                    color={color}
                    onClose={() => setOpenKey(null)}
                  />
                </PopoverContent>
              </Popover>
            )
          })}
        </div>
      ))}
      <div className="w-px h-3.5 bg-border-subtle mx-0.5 flex-shrink-0" />
    </>
  )
}
