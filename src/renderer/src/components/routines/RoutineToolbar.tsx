import { useMemo, useState, type ComponentType } from 'react'
import { ClockIcon, PlusIcon } from '@heroicons/react/24/outline'
import { IconButton, Popover, PopoverContent, PopoverTrigger } from '@clave/ui/components'
import { LOCAL_SERVER_ID, resourceKey } from '@clave/contract/fleet'
import { useRoutineSurfaces, useRoutinesStore } from '../../store/routines-store'
import { usePairingStore } from '../../store/pairing-store'
import { useWorkspaceStore } from '../../store/workspace-store'
import { getTerminalIconComponent } from '../ui/terminal-icons'
import { resolveColorHex, type GroupTerminalIcon } from '../../store/session-types'
import { RoutinePanel } from './RoutinePanel'
import { RoutineCreateForm } from './RoutineCreateForm'
import { valuesOf } from './routine-form-values'
import { RunGlyph } from '../../../../../plugins/routine-report/src/RunGlyph'
import { whenLabel } from '../../../../../plugins/routine-report/src/run-labels'
import { routineBadge, routineInk } from './routine-badge'
import { routineTitle } from './routine-title'
import { aggregateBadge, sectionsOf, type RoutineSection } from './routine-sections'
import type { RoutineSurface } from './routine-servers'
import { describeCron } from '../../../../main/routines/cron'

/**
 * The routines of the active workspace in the toolbar (ADR 0004,
 * PRDCT-4244): ONE button, its badge the strongest signal across every
 * routine (`aggregateBadge`), and a popover that lists the routines in
 * sections, one per machine (`sectionsOf`): this Mac, each connected server
 * by its own name, then a section per machine a routine is placed on that
 * this Mac cannot reach, marked away or unknown. A routine on every machine
 * appears under each, the same name twice, which is the rule made visible.
 * A row opens the routine's panel in the same popover, a chevron brings the
 * list back; a section's “+” opens the form that creates a routine on that
 * machine, in this workspace.
 */
type Page =
  | { kind: 'list' }
  | { kind: 'routine'; id: string }
  | { kind: 'new'; section: RoutineSection }
  | { kind: 'edit'; id: string }

const surfaceId = (s: RoutineSurface): string => `${s.serverId}::${s.view.routine.key}`
type IconOf = (s: RoutineSurface) => {
  Icon: ComponentType<{ className?: string }>
  color: string | undefined
}

export function RoutineToolbar(): React.JSX.Element | null {
  const surfaces = useRoutineSurfaces()
  const local = useRoutinesStore((s) => s.local)
  const create = useRoutinesStore((s) => s.create)
  const update = useRoutinesStore((s) => s.update)
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const serverWorkspaces = useWorkspaceStore((s) => s.serverWorkspaces)
  const pairings = usePairingStore((s) => s.servers)
  const [open, setOpen] = useState(false)
  const [page, setPage] = useState<Page>({ kind: 'list' })
  const shown = useMemo(
    () => surfaces.filter((s) => !activeWorkspaceId || s.workspaceId === activeWorkspaceId),
    [surfaces, activeWorkspaceId]
  )
  const localName = local?.server?.name
  const localTitle = localName ? `This Mac · ${localName}` : 'This Mac'
  const sections = useMemo(() => sectionsOf(shown, localTitle), [shown, localTitle])
  const badge = useMemo(() => aggregateBadge(shown), [shown])
  const canCreateHere = !!activeWorkspaceId
  // The popover opens on the list every time.
  const onOpenChange = (next: boolean): void => {
    setOpen(next)
    if (!next) setPage({ kind: 'list' })
  }
  if (shown.length === 0 && !canCreateHere) return null

  const workspaceName = workspaces.find((w) => w.id === activeWorkspaceId)?.name ?? 'this workspace'
  const workspaceRoot = workspaces.find((w) => w.id === activeWorkspaceId)?.rootDir

  /** The workspace a create on a section's machine lands in: this Mac's
   *  active workspace, or on a server the raw workspace this one pairs with
   *  (the pairing's map, else a routine of the section already there). */
  const workspaceOn = (
    section: RoutineSection
  ): { id: string; name: string; rootDir?: string } | null => {
    if (!activeWorkspaceId) return null
    if (section.serverId === LOCAL_SERVER_ID)
      return {
        id: activeWorkspaceId,
        name: workspaceName,
        ...(workspaceRoot ? { rootDir: workspaceRoot } : {})
      }
    const pairing = pairings[section.serverId]
    const raw =
      Object.entries(pairing?.pairs ?? {}).find(([, mac]) => mac === activeWorkspaceId)?.[0] ??
      section.surfaces.find((s) => s.workspaceId === activeWorkspaceId)?.view.routine.workspaceId ??
      // The active workspace may itself be the server's (its remote key).
      (serverWorkspaces[section.serverId] ?? []).find(
        (w) => resourceKey('workspace', section.serverId, w.id) === activeWorkspaceId
      )?.id
    if (!raw) return null
    const remote = (serverWorkspaces[section.serverId] ?? []).find((w) => w.id === raw)
    return {
      id: raw,
      name: remote?.name ?? workspaceName,
      ...(remote?.rootDir ? { rootDir: remote.rootDir } : {})
    }
  }

  // A routine the list no longer holds (deleted, its machine gone) shows the list again.
  const current =
    page.kind === 'routine' || page.kind === 'edit'
      ? shown.find((s) => surfaceId(s) === page.id)
      : undefined
  const iconOf: IconOf = (s) => ({
    Icon: s.view.routine.icon
      ? getTerminalIconComponent(s.view.routine.icon as GroupTerminalIcon)
      : ClockIcon,
    color: routineInk(resolveColorHex(s.view.routine.color ?? undefined))
  })

  return (
    <>
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <button
            className="btn-icon btn-icon-md relative routine-button"
            title={shown.length ? `Routines · ${shown.length}` : 'Routines'}
            data-testid="routines-button"
            data-state={badge.state}
            data-count={shown.length}
          >
            <ClockIcon className="w-4 h-4" />
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
          onOpenAutoFocus={(e) => {
            e.preventDefault()
            ;(e.currentTarget as HTMLElement | null)
              ?.querySelector<HTMLElement>(
                '[data-testid="routine-panel"], [data-testid="routines-list"]'
              )
              ?.focus()
          }}
        >
          {current && page.kind === 'routine' ? (
            <RoutinePanel
              surface={current}
              icon={(() => {
                const { Icon } = iconOf(current)
                return <Icon />
              })()}
              color={iconOf(current).color}
              onClose={() => setOpen(false)}
              onBack={() => setPage({ kind: 'list' })}
              onEdit={
                current.view.routine.origin === 'created'
                  ? () => setPage({ kind: 'edit', id: page.id })
                  : undefined
              }
            />
          ) : current && page.kind === 'edit' ? (
            <RoutineCreateForm
              machine={current.serverName}
              workspace={{
                id: current.view.routine.workspaceId,
                name: current.view.routine.workspaceName
              }}
              initial={valuesOf(current.view)}
              onSubmit={(patch) => update(current, current.view.routine.key, patch)}
              onBack={() => setPage({ kind: 'routine', id: page.id })}
            />
          ) : page.kind === 'new' ? (
            (() => {
              const workspace = workspaceOn(page.section)
              return workspace ? (
                <RoutineCreateForm
                  machine={page.section.title}
                  workspace={workspace}
                  onSubmit={(input) =>
                    create(
                      { serverId: page.section.serverId },
                      input as Parameters<typeof create>[1]
                    )
                  }
                  onBack={() => setPage({ kind: 'list' })}
                />
              ) : null
            })()
          ) : (
            <RoutineList
              sections={sections}
              workspaceName={workspaceName}
              localSection={
                sections.some((s) => s.kind === 'here')
                  ? null
                  : {
                      id: LOCAL_SERVER_ID,
                      kind: 'here',
                      title: localTitle,
                      note: null,
                      serverId: LOCAL_SERVER_ID,
                      canCreate: true,
                      surfaces: []
                    }
              }
              canCreateOn={(section) => section.canCreate && workspaceOn(section) !== null}
              onOpen={(s) => setPage({ kind: 'routine', id: surfaceId(s) })}
              onNew={(section) => setPage({ kind: 'new', section })}
              iconOf={iconOf}
            />
          )}
        </PopoverContent>
      </Popover>
      <div className="w-px h-3.5 bg-border-subtle mx-0.5 flex-shrink-0" />
    </>
  )
}

/** The list: the sections in order, one row per routine. */
function RoutineList({
  sections,
  localSection,
  workspaceName,
  canCreateOn,
  onOpen,
  onNew,
  iconOf
}: {
  sections: RoutineSection[]
  /** This Mac's section when no routine runs here yet: shown empty, so a routine can be made. */
  localSection: RoutineSection | null
  workspaceName: string
  canCreateOn: (section: RoutineSection) => boolean
  onOpen: (surface: RoutineSurface) => void
  onNew: (section: RoutineSection) => void
  iconOf: IconOf
}): React.JSX.Element {
  const all = localSection ? [localSection, ...sections] : sections
  return (
    <div className="routines-list" data-testid="routines-list" tabIndex={-1}>
      <div className="routines-list-head">
        <span className="routine-head-title">Routines</span>
        <span className="routine-head-sub">{workspaceName}</span>
      </div>
      {all.map((section) => (
        <section
          key={section.id}
          className="routines-section"
          data-testid="routines-section"
          data-kind={section.kind}
          data-machine={section.title}
          data-server={section.serverId !== LOCAL_SERVER_ID ? section.serverId : undefined}
        >
          <header className="routines-section-head">
            <span className="routines-section-title" title={section.title}>
              {section.title}
            </span>
            {section.note && (
              <span className="routines-section-note" data-testid="routines-section-note">
                {section.note}
              </span>
            )}
            {canCreateOn(section) && (
              <IconButton
                className="panel-icon-btn routines-section-add"
                data-testid="routines-section-add"
                aria-label={`New routine on ${section.title}`}
                tooltip={`New routine on ${section.title}`}
                onClick={() => onNew(section)}
              >
                <PlusIcon className="w-3.5 h-3.5" />
              </IconButton>
            )}
          </header>
          {section.surfaces.length === 0 ? (
            <div className="routines-empty" data-testid="routines-empty">
              No routine runs here for {workspaceName}.
            </div>
          ) : (
            <ul className="routines-rows">
              {section.surfaces.map((s) => {
                const view = s.view
                const badge = routineBadge(view, s)
                const { Icon, color } = iconOf(s)
                const last = view.runs[0]
                const sub = view.routine.invalid
                  ? 'Cannot run'
                  : view.routine.paused
                    ? 'Paused'
                    : view.nextRunAt
                      ? `next ${whenLabel(view.nextRunAt)}`
                      : describeCron(view.routine.schedule)
                return (
                  <li key={surfaceId(s)}>
                    <button
                      className="menu-item routine-row"
                      data-testid="routine-row"
                      data-routine={view.routine.name}
                      data-server={s.serverId !== LOCAL_SERVER_ID ? s.serverId : undefined}
                      data-state={badge.state}
                      data-origin={view.routine.origin ?? 'file'}
                      title={routineTitle(view, s)}
                      onClick={() => onOpen(s)}
                    >
                      <span className="routine-row-icon" style={{ color }} aria-hidden="true">
                        <Icon />
                      </span>
                      <span className="routine-row-text">
                        <span className="routine-row-name">{view.routine.name}</span>
                        <span className="routine-row-sub">
                          {sub}
                          {last?.headline ? ` · ${last.headline}` : ''}
                        </span>
                      </span>
                      {badge.working ? (
                        <RunGlyph tone="running" testId="routine-row-working" />
                      ) : badge.dot ? (
                        <RunGlyph tone={badge.dot} testId="routine-row-dot" />
                      ) : null}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      ))}
    </div>
  )
}
