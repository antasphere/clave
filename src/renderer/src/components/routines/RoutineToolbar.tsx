import { useState } from 'react'
import { ClockIcon } from '@heroicons/react/24/outline'
import { Popover, PopoverContent, PopoverTrigger, cn } from '@clave/ui/components'
import type { RoutineView } from '@clave/contract/routines/model'
import { useRoutinesStore, latestRun } from '../../store/routines-store'
import { useWorkspaceStore } from '../../store/workspace-store'
import { getTerminalIconComponent } from '../ui/terminal-icons'
import { resolveColorHex, type GroupTerminalIcon } from '../../store/session-types'
import { TONE_CLASS, runTone } from '../../../../../plugins/routine-report/src/run-labels'
import { RoutinePanel } from './RoutinePanel'
import { routineTitle } from './routine-title'

/**
 * The routines of the active workspace in the toolbar (ADR 0004): one button
 * per routine, its icon in its colour, grouped by the group that declares
 * them, with a dot for the unseen last run (green ok, amber attention, red
 * failed; the accent pulsing while a run is in flight, amber pulsing while a
 * run waits on the person) and the floating panel on a click.
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
  const darken = (hex: string | undefined): string | undefined => {
    if (!hex) return undefined
    const r = parseInt(hex.slice(1, 3), 16)
    const g = parseInt(hex.slice(3, 5), 16)
    const b = parseInt(hex.slice(5, 7), 16)
    return `rgb(${Math.round(r * 0.7)}, ${Math.round(g * 0.7)}, ${Math.round(b * 0.7)})`
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
            const last = latestRun(view)
            const tone = runTone(last)
            const unseen = last && !last.seen
            const dot = view.routine.invalid
              ? 'bg-red-500'
              : tone === 'running' || tone === 'waiting'
                ? TONE_CLASS[tone]
                : unseen
                  ? TONE_CLASS[tone]
                  : null
            const Icon = view.routine.icon
              ? getTerminalIconComponent(view.routine.icon as GroupTerminalIcon)
              : ClockIcon
            const color = darken(resolveColorHex(view.routine.color ?? undefined))
            const open = openKey === view.routine.key
            return (
              <Popover
                key={view.routine.key}
                open={open}
                onOpenChange={(o) => setOpenKey(o ? view.routine.key : null)}
              >
                <PopoverTrigger asChild>
                  <button
                    className="btn-icon btn-icon-md relative"
                    style={{ color }}
                    title={routineTitle(view)}
                    data-testid="routine-button"
                    data-routine={view.routine.name}
                    data-state={
                      view.routine.invalid
                        ? 'invalid'
                        : last
                          ? unseen
                            ? last.state
                            : 'seen'
                          : 'never'
                    }
                  >
                    <Icon className="w-4 h-4" />
                    {dot && (
                      <span
                        className={cn(
                          'absolute right-0.5 bottom-0.5 w-1.5 h-1.5 rounded-full',
                          dot
                        )}
                        data-testid="routine-dot"
                      />
                    )}
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  animated
                  open={open}
                  side="bottom"
                  align="end"
                  sideOffset={8}
                  className="p-0 overflow-hidden"
                  onFocusOutside={(e) => e.preventDefault()}
                >
                  <RoutinePanel view={view} onClose={() => setOpenKey(null)} />
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
