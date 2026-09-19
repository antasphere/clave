import { useState, useEffect, useRef, useCallback } from 'react'
import { Popover, PopoverTrigger, PopoverAnchor, PopoverContent } from '@clave/ui/components'
import { XMarkIcon, ArrowTopRightOnSquareIcon } from '@heroicons/react/24/outline'
import { useToolbarTerminal, type ToolbarTerminalStatus } from '../../hooks/use-toolbar-terminal'
import { useServerButton, type ServerButtonApi } from '../../hooks/use-server-button'
import {
  adoptPersistentToolbarSession,
  getPersistentToolbarSession,
  takeToolbarSurvivor
} from '../../lib/toolbar-terminal-registry'
import { cn } from '@clave/ui/components'
import { safePort } from '../../lib/utils'

interface ToolbarTerminalPopoverProps {
  cwd: string
  command: string
  persistent?: boolean
  /** Stable identity of this toolbar terminal (`${pinId}:${terminalIndex}`) in
   *  the persistent-session registry. Required so a running dev server
   *  survives its button unmounting (workspace switch) and is reattached —
   *  never duplicated — when the button comes back. */
  registryKey: string
  /** Declared dev-server URL — turns this popover's button into a server button
   *  (probe-first "ensure running, then open"; see use-server-button.ts). */
  serverUrl?: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Plain trigger node, or (for server buttons) a render prop receiving the
   *  server-button API so the toolbar button can carry the status dot. */
  children: React.ReactNode | ((api: ServerButtonApi) => React.ReactNode)
  header: React.ReactNode
}

function TerminalBody({
  sessionId,
  persistent,
  onStatusChange
}: {
  sessionId: string
  persistent?: boolean
  onStatusChange: (status: ToolbarTerminalStatus) => void
}): React.JSX.Element {
  const { containerRef, status } = useToolbarTerminal({ sessionId, persistent })

  useEffect(() => {
    onStatusChange(status)
  }, [status, onStatusChange])

  return <div ref={containerRef} className="w-full h-full" style={{ minHeight: 0 }} />
}

export function ToolbarTerminalPopover({
  cwd,
  command,
  persistent,
  registryKey,
  serverUrl,
  open,
  onOpenChange,
  children,
  header
}: ToolbarTerminalPopoverProps): React.JSX.Element {
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [status, setStatus] = useState<ToolbarTerminalStatus>('running')
  const [respawnNonce, setRespawnNonce] = useState(0)
  const sessionIdRef = useRef<string | null>(null)

  useEffect(() => {
    sessionIdRef.current = sessionId
  }, [sessionId])

  // Spawn PTY when popover opens (or when a respawn is explicitly requested
  // while already open — a server-button restart after the session died).
  // Persistent sessions live in the module-level registry, NOT component
  // state: workspace switching unmounts this button, and the running dev
  // server must be reattachable — never duplicated — when it comes back.
  useEffect(() => {
    if (!open) return

    // Reattach to the registry's live session, if any
    const existing = persistent ? getPersistentToolbarSession(registryKey) : null
    if (existing) {
      setStatus('running')
      setSessionId(existing)
      return
    }

    let cancelled = false
    let spawnedId: string | null = null
    let exitCleanup: (() => void) | null = null

    // A survivor of the last run reattaches instead of spawning a second
    // server on the same port (PRDCT-1756): the boot restore parks its record
    // here rather than adopting it as a sidebar tab. Reattaching keeps the id,
    // so the record stays one record.
    const survivor = takeToolbarSurvivor(registryKey)
    window.electronAPI
      .spawnSession(survivor?.cwd ?? cwd, {
        claudeMode: false,
        // Reattaching runs nothing: the command is already running in there.
        initialCommand: survivor ? undefined : command || undefined,
        autoExecute: !survivor,
        ...(survivor
          ? {
              tmuxMode: true,
              adoptTmuxName: survivor.tmuxName,
              adoptSessionId: survivor.id,
              workspaceId: survivor.workspaceId
            }
          : {}),
        link: { kind: 'toolbar', key: registryKey }
      })
      .then((info) => {
        if (cancelled) {
          window.electronAPI.killSession(info.id)
          return
        }
        spawnedId = info.id

        // Listen for exit immediately so we don't miss fast-exiting commands.
        // Persistent sessions register their lifetime listener in the registry;
        // the component-scoped one below only drives the visible status dot.
        if (persistent) {
          adoptPersistentToolbarSession(registryKey, info.id)
        }
        exitCleanup = window.electronAPI.onSessionExit(info.id, () => {
          setStatus('exited')
        })

        setStatus('running')
        setSessionId(info.id)
      })
      .catch((err) => {
        console.error('[toolbar-popover] spawn failed:', err)
      })

    return () => {
      cancelled = true
      exitCleanup?.()
      if (spawnedId && !persistent) {
        window.electronAPI.killSession(spawnedId)
      }
    }
  }, [open, cwd, command, persistent, registryKey, respawnNonce])

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen && !persistent) {
        setSessionId(null)
        setStatus('running')
      }
      onOpenChange(nextOpen)
    },
    [onOpenChange, persistent]
  )

  const handleStatusChange = useCallback((s: ToolbarTerminalStatus) => {
    // Registry cleanup on exit is handled by its own module-level listener.
    setStatus(s)
  }, [])

  // ── Server button wiring ──
  const openTerminal = useCallback(() => {
    // Already open with a dead session → the open-effect won't re-run on its
    // own; bump the nonce to force a respawn.
    if (open && !getPersistentToolbarSession(registryKey)) {
      setRespawnNonce((n) => n + 1)
    }
    onOpenChange(true)
  }, [open, onOpenChange, registryKey])

  const serverButton = useServerButton({
    serverUrl,
    command,
    sessionId,
    getLiveSessionId: () => getPersistentToolbarSession(registryKey),
    openTerminal
  })

  const statusColor = status === 'running' ? 'bg-green-500' : 'bg-red-400'
  const serverState = serverButton.state
  const serverPort = serverButton.liveUrl ? safePort(serverButton.liveUrl) : null

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      {serverUrl ? (
        // Server buttons drive open/close themselves (probe-first click), so
        // they anchor the popover instead of using Radix's toggling trigger.
        <PopoverAnchor asChild>
          {typeof children === 'function' ? children(serverButton) : children}
        </PopoverAnchor>
      ) : (
        <PopoverTrigger asChild>
          {typeof children === 'function' ? children(serverButton) : children}
        </PopoverTrigger>
      )}
      <PopoverContent
        animated
        open={open}
        side="bottom"
        align="start"
        sideOffset={8}
        className="w-[500px]"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border-subtle">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            {header}
            <span className="text-xs text-text-secondary truncate flex-1">{command}</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {serverUrl && (
              // Server-state chip: deliberately separate from the session dot —
              // the session (shell) surviving its server is the whole reason
              // server buttons probe instead of trusting session liveness.
              <button
                onClick={serverButton.openBrowser}
                disabled={serverState !== 'up'}
                className={cn(
                  'flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium transition-colors',
                  serverState === 'up' &&
                    'bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20',
                  serverState === 'starting' && 'bg-amber-400/10 text-amber-400 cursor-wait',
                  (serverState === 'down' || serverState === 'unknown') &&
                    'bg-surface-200 text-text-secondary'
                )}
                title={
                  serverState === 'up'
                    ? `Open ${serverButton.liveUrl}`
                    : serverState === 'starting'
                      ? 'Server starting…'
                      : 'Server not running'
                }
              >
                <span
                  className={cn(
                    'w-1 h-1 rounded-full',
                    serverState === 'up' && 'bg-emerald-500',
                    serverState === 'starting' && 'bg-amber-400 animate-pulse',
                    (serverState === 'down' || serverState === 'unknown') && 'bg-text-tertiary'
                  )}
                />
                <span>{serverPort !== null ? `:${serverPort}` : 'server'}</span>
                {serverState === 'up' && <ArrowTopRightOnSquareIcon className="w-2.5 h-2.5" />}
              </button>
            )}
            <div className={`w-1.5 h-1.5 rounded-full ${statusColor}`} />
            <button onClick={() => handleOpenChange(false)} className="btn-icon btn-icon-xs">
              <XMarkIcon className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Terminal */}
        <div className="h-[300px] overflow-hidden" style={{ backgroundColor: 'var(--surface-0)' }}>
          {sessionId && (
            <TerminalBody
              sessionId={sessionId}
              persistent={persistent}
              onStatusChange={handleStatusChange}
            />
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
