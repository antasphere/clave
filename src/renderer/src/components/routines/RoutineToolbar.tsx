import { useState } from 'react'
import { ClockIcon } from '@heroicons/react/24/outline'
import { Popover, PopoverContent, PopoverTrigger } from '@clave/ui/components'
import type { RoutineView } from '@clave/contract/routines/model'
import { useRoutinesStore } from '../../store/routines-store'
import { useWorkspaceStore } from '../../store/workspace-store'
import { getTerminalIconComponent } from '../ui/terminal-icons'
import { resolveColorHex, type GroupTerminalIcon } from '../../store/session-types'
import { RoutinePanel } from './RoutinePanel'
import { RunGlyph } from '../../../../../plugins/routine-report/src/RunGlyph'
import { routineBadge, routineInk } from './routine-badge'
import { routineTitle } from './routine-title'

/**
 * The routines of the active workspace in the toolbar (ADR 0004): one button
 * per routine, its icon in its colour, grouped by the group that declares
 * them, with the one signal `routineBadge` decides, drawn on the icon's
 * corner with the sidebar's own glyphs (`RunGlyph`): its spinner while a run
 * is in flight, its check, warning, question or cross while the last run is
 * unseen; and the floating panel on a click.
 */
export function RoutineToolbar(): React.JSX.Element | null {
  const routines = useRoutinesStore((s) => s.routines)
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const [openKey, setOpenKey] = useState<string | null>(null)
  const shown = routines.filter(
    (v) => !activeWorkspaceId || v.routine.workspaceId === activeWorkspaceId
  )
  if (shown.length === 0) return null
  const groups = new Map<string, RoutineView[]>()
  for (const v of shown) {
    const key = `${v.routine.file}::${v.routine.group}`
    groups.set(key, [...(groups.get(key) ?? []), v])
  }
  return (
    <>
      {[...groups.entries()].map(([groupKey, views], index) => (
        <div
          key={groupKey}
          className="flex items-center gap-0.5 flex-shrink-0"
          data-testid="routine-group"
        >
          {index > 0 && <div className="w-px h-3.5 bg-border-subtle mx-0.5" />}
          {views.map((view) => {
            const badge = routineBadge(view)
            const Icon = view.routine.icon
              ? getTerminalIconComponent(view.routine.icon as GroupTerminalIcon)
              : ClockIcon
            const color = routineInk(resolveColorHex(view.routine.color ?? undefined))
            const open = openKey === view.routine.key
            return (
              <Popover
                key={view.routine.key}
                open={open}
                onOpenChange={(o) => setOpenKey(o ? view.routine.key : null)}
              >
                <PopoverTrigger asChild>
                  <button
                    className="btn-icon btn-icon-md relative routine-button"
                    style={{ color }}
                    title={routineTitle(view)}
                    data-testid="routine-button"
                    data-routine={view.routine.name}
                    data-state={badge.state}
                  >
                    <Icon className="w-4 h-4" />
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
                    view={view}
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
