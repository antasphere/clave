import { useMemo, useState } from 'react'
import {
  ChevronDownIcon,
  PlusIcon,
  CheckIcon,
  Cog6ToothIcon,
  FolderOpenIcon,
  ArrowTopRightOnSquareIcon
} from '@heroicons/react/24/outline'
import { Popover, PopoverTrigger, PopoverContent } from '@clave/ui/components'
import { useWorkspaceStore } from '../../store/workspace-store'
import { useSessionStore } from '../../store/session-store'
import { setActiveWorkspace, addWorkspace } from '../../lib/workspace-actions'
import { shortenPath } from '../../lib/utils'

/** A folder picked for registration that holds several `.clave` profiles — one
 *  has to be chosen before the workspace exists. */
interface PendingAdd {
  rootDir: string
  candidates: { name: string; path: string }[]
  selected: string
}

/**
 * The toolbar's workspace control: the active workspace's name, and — when
 * there is a registry to speak of — a popover listing every workspace on this
 * machine with the switch one click away, plus an Add that goes straight to
 * the folder picker.
 *
 * This is the workspace switcher; the sidebar no longer carries one. In
 * no-workspace mode it stays a plain label: with zero workspaces the app runs
 * unscoped and the concept should not be visible at all (same rule the sidebar
 * pill row followed).
 */
export function ToolbarWorkspacePopover(): React.JSX.Element {
  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const sessions = useSessionStore((s) => s.sessions)
  const openSettings = useSessionStore((s) => s.openSettings)

  const [open, setOpen] = useState(false)
  const [pendingAdd, setPendingAdd] = useState<PendingAdd | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const active = workspaces.find((w) => w.id === activeWorkspaceId)
  const name = active?.name ?? 'Clave'

  // Activity dots: a hidden workspace with a session waiting on the user
  // (unseen activity or a pending permission prompt) is marked, so switching
  // away never means missing an agent that needs attention.
  const attention = useMemo(() => {
    const ids = new Set<string>()
    for (const session of sessions) {
      if (!session.hasUnseenActivity && !session.promptWaiting) continue
      if (session.workspaceId && session.workspaceId !== activeWorkspaceId) {
        ids.add(session.workspaceId)
      }
    }
    return ids
  }, [sessions, activeWorkspaceId])

  const needsAttention = useMemo(
    () => workspaces.some((w) => attention.has(w.id)),
    [workspaces, attention]
  )

  const reset = (): void => {
    setPendingAdd(null)
    setError(null)
    setBusy(false)
  }

  const handleOpenChange = (next: boolean): void => {
    setOpen(next)
    if (!next) reset()
  }

  const register = async (rootDir: string, profileFile: string | null): Promise<void> => {
    const added = await addWorkspace(rootDir, profileFile)
    if (!added) {
      setError('That folder overlaps a workspace you already have.')
      setPendingAdd(null)
      return
    }
    handleOpenChange(false)
  }

  /** Straight to the folder picker — no detour through Settings. A folder with
   *  several `.clave` profiles comes back here for the one pick it needs. */
  const handleAdd = async (): Promise<void> => {
    setError(null)
    setPendingAdd(null)
    setBusy(true)
    try {
      const folder = await window.electronAPI?.openFolderDialog()
      if (!folder) return
      const files = (await window.electronAPI?.discoverClaveFiles(folder)) ?? []
      if (files.length <= 1) {
        // Zero candidates → a bare workspace (sessions scope to it, no pins).
        await register(folder, files[0]?.path ?? null)
        return
      }
      setPendingAdd({
        rootDir: folder,
        candidates: files.map((f) => ({ name: f.name, path: f.path })),
        selected: files.find((f) => f.name === 'default')?.path ?? files[0].path
      })
    } finally {
      setBusy(false)
    }
  }

  const label = (
    <>
      <span className="truncate">{name}</span>
      {needsAttention && <span className="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0" />}
      {/* Optically nudged down a half pixel: flex centring lines the icon box up
          with the text's line box, which sits above the text's visual centre at
          this size. */}
      <ChevronDownIcon className="w-3 h-3 flex-shrink-0 opacity-60 translate-y-[0.5px]" />
    </>
  )

  // No-workspace mode: a label, not a menu.
  if (workspaces.length === 0) {
    return (
      <span className="text-[11px] font-medium text-text-tertiary tracking-wide select-none flex-shrink-0 whitespace-nowrap">
        {name}
      </span>
    )
  }

  return (
    <div
      className="min-w-0 flex-shrink"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <button
            aria-label="Switch workspace"
            className="flex items-center gap-1 max-w-[220px] px-1.5 py-0.5 rounded text-[11px] font-medium text-text-tertiary hover:text-text-secondary hover:bg-surface-100 tracking-wide transition-colors"
            title={active ? shortenPath(active.rootDir) : 'Workspaces'}
          >
            {label}
          </button>
        </PopoverTrigger>
        <PopoverContent
          animated
          open={open}
          side="bottom"
          align="center"
          sideOffset={8}
          className="w-[300px] p-1"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          {pendingAdd ? (
            <ProfilePicker
              pending={pendingAdd}
              onSelect={(path) => setPendingAdd({ ...pendingAdd, selected: path })}
              onConfirm={() => void register(pendingAdd.rootDir, pendingAdd.selected)}
              onCancel={() => setPendingAdd(null)}
            />
          ) : (
            <>
              <div className="menu-label">Workspaces</div>
              <div className="max-h-[320px] overflow-y-auto">
                {workspaces.map((ws) => {
                  const isActive = ws.id === activeWorkspaceId
                  return (
                    <button
                      key={ws.id}
                      className="menu-item group"
                      data-selected={isActive}
                      onClick={() => {
                        if (!isActive) void setActiveWorkspace(ws.id)
                        handleOpenChange(false)
                      }}
                      title={shortenPath(ws.rootDir)}
                    >
                      <span className="flex-1 min-w-0 py-0.5">
                        <span className="block text-[13px] leading-tight text-text-primary truncate">
                          {ws.name}
                        </span>
                        <span className="block text-[11px] leading-tight text-text-tertiary truncate mt-0.5">
                          {shortenPath(ws.rootDir)}
                        </span>
                      </span>
                      {attention.has(ws.id) && (
                        <span className="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0" />
                      )}
                      {isActive && <CheckIcon className="w-3.5 h-3.5 text-accent flex-shrink-0" />}
                      <span
                        role="button"
                        title="Open in new window"
                        className="btn-icon flex-shrink-0 opacity-0 group-hover:opacity-100"
                        onClick={(e) => {
                          e.stopPropagation()
                          void window.electronAPI?.windowOpen?.(ws.id)
                          handleOpenChange(false)
                        }}
                      >
                        <ArrowTopRightOnSquareIcon className="w-3.5 h-3.5" />
                      </span>
                    </button>
                  )
                })}
              </div>
              {error && <div className="px-2 py-1.5 text-[11px] text-red-400">{error}</div>}
              <div className="menu-sep" />
              <button
                className="menu-item menu-item--muted"
                onClick={() => void handleAdd()}
                disabled={busy}
              >
                <PlusIcon className="w-3.5 h-3.5 flex-shrink-0" />
                Add workspace…
              </button>
              <button
                className="menu-item menu-item--muted"
                onClick={() => {
                  handleOpenChange(false)
                  openSettings('general')
                }}
              >
                <Cog6ToothIcon className="w-3.5 h-3.5 flex-shrink-0" />
                Manage workspaces…
              </button>
            </>
          )}
        </PopoverContent>
      </Popover>
    </div>
  )
}

/** Second step of Add, for a folder holding several `.clave` profiles: exactly
 *  one becomes the workspace's profile. */
function ProfilePicker({
  pending,
  onSelect,
  onConfirm,
  onCancel
}: {
  pending: PendingAdd
  onSelect: (path: string) => void
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  return (
    <>
      <div className="menu-label flex items-center gap-1.5">
        <FolderOpenIcon className="w-3 h-3 flex-shrink-0" />
        <span className="truncate">Pick a profile — {shortenPath(pending.rootDir)}</span>
      </div>
      <div className="max-h-[240px] overflow-y-auto">
        {pending.candidates.map((c) => (
          <button
            key={c.path}
            className="menu-item"
            data-selected={c.path === pending.selected}
            onClick={() => onSelect(c.path)}
          >
            <span className="flex-1 min-w-0 truncate">{c.name}</span>
            {c.path === pending.selected && (
              <CheckIcon className="w-3.5 h-3.5 text-accent flex-shrink-0" />
            )}
          </button>
        ))}
      </div>
      <div className="menu-sep" />
      <div className="flex items-center gap-1.5 px-1 py-1">
        <button className="btn-primary btn-compact flex-1" onClick={onConfirm}>
          Add workspace
        </button>
        <button className="btn-secondary btn-compact" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </>
  )
}
