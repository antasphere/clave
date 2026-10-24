import { useState } from 'react'
import { ComputerDesktopIcon, PlusIcon, ServerIcon, TrashIcon } from '@heroicons/react/24/outline'
import { useWorkspaceStore } from '../../store/workspace-store'
import { useFleetStore } from '../../store/fleet-store'
import { pickServerFolder } from '../../store/server-folder-store'
import {
  addServerWorkspace,
  removeServerWorkspace,
  serverWorkspaceError,
  setActiveWorkspace
} from '../../lib/workspace-actions'
import { SettingsCallout } from './primitives'

/**
 * Settings → General → Workspaces, the server half (#241): the workspaces
 * each connected server keeps in its own registry, labelled with the
 * server's name and shown offline while it is down, and the Add that asks
 * for the machine first. A server workspace has no rename, profile or trust
 * here: those are this Mac's own settings of a Mac workspace.
 */

function useServers(): {
  connected: Array<{ id: string; name: string }>
  nameOf: (id: string) => string
  isOnline: (id: string) => boolean
} {
  const connections = useFleetStore((s) => s.connections)
  const statuses = useFleetStore((s) => s.statuses)
  const isOnline = (id: string): boolean => statuses[id]?.state === 'connected'
  return {
    connected: connections.filter((c) => isOnline(c.id)),
    nameOf: (id) => connections.find((c) => c.id === id)?.name ?? 'Clave server',
    isOnline
  }
}

/** One row per server workspace, below the Mac's own, with its removal. */
export function ServerWorkspaceRows(): React.JSX.Element | null {
  const serverWorkspaces = useWorkspaceStore((s) => s.serverWorkspaces)
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const { nameOf, isOnline } = useServers()
  const [confirmRemove, setConfirmRemove] = useState<{
    id: string
    name: string
    server: string
  } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const rows = Object.entries(serverWorkspaces).flatMap(([serverId, list]) =>
    list.map((ws) => ({ ws, serverId }))
  )
  if (rows.length === 0 && !error) return null

  const remove = async (target: { id: string; server: string }): Promise<void> => {
    setConfirmRemove(null)
    try {
      await removeServerWorkspace(target.id)
    } catch (err) {
      setError(serverWorkspaceError(err, target.server, 'remove'))
    }
  }

  return (
    <>
      {rows.map(({ ws, serverId }) => {
        const isActive = ws.id === activeWorkspaceId
        const offline = !isOnline(serverId)
        return (
          <div
            key={ws.id}
            className="settings-row"
            data-workspace-row={ws.id}
            data-offline={offline || undefined}
          >
            <div
              className="flex items-center gap-3 flex-1 min-w-0 cursor-pointer"
              onClick={() => {
                if (!isActive) void setActiveWorkspace(ws.id)
              }}
              title={isActive ? 'Active workspace' : 'Switch to this workspace'}
            >
              <ServerIcon className="w-4 h-4 flex-shrink-0 text-text-tertiary" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <p className="settings-row-title truncate">{ws.name}</p>
                  {isActive && <span className="badge badge-muted">Active</span>}
                  {offline && <span className="badge badge-muted">Offline</span>}
                </div>
                <p
                  className="settings-row-description truncate"
                  title={`${nameOf(serverId)} · ${ws.rootDir}`}
                >
                  {nameOf(serverId)} · {ws.rootDir}
                </p>
              </div>
            </div>
            <div className="settings-row-controls">
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setError(null)
                  setConfirmRemove({ id: ws.id, name: ws.name, server: nameOf(serverId) })
                }}
                disabled={offline}
                className="btn-icon btn-icon-sm btn-icon--danger"
                title={offline ? 'The server is offline' : 'Remove workspace'}
                aria-label="Remove workspace"
              >
                <TrashIcon className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )
      })}
      {confirmRemove && (
        <SettingsCallout
          tone="danger"
          title={
            <>
              Remove workspace “{confirmRemove.name}” from {confirmRemove.server}?
            </>
          }
          text="It goes from the server's list, for every Mac connected to it. The folder and the sessions running on the server stay."
          actions={
            <>
              <button onClick={() => setConfirmRemove(null)} className="btn-secondary">
                Cancel
              </button>
              <button onClick={() => void remove(confirmRemove)} className="btn-primary">
                Remove
              </button>
            </>
          }
        />
      )}
      {error && <SettingsCallout tone="danger" text={error} role="alert" />}
    </>
  )
}

/** Add workspace: straight to this Mac's folder picker when no server is
 *  connected; otherwise the machine first, then a folder on it. */
export function AddWorkspaceAction({
  onThisMac
}: {
  onThisMac: () => void | Promise<void>
}): React.JSX.Element {
  const { connected, nameOf } = useServers()
  const [choosing, setChoosing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const addOnServer = async (serverId: string): Promise<void> => {
    setChoosing(false)
    const folder = await pickServerFolder({ serverId, serverName: nameOf(serverId) })
    if (!folder) return
    try {
      await addServerWorkspace(serverId, folder)
    } catch (err) {
      setError(serverWorkspaceError(err, nameOf(serverId), 'add'))
    }
  }

  if (choosing)
    return (
      <div data-testid="add-workspace-machine">
        <p className="settings-row-description px-3 pt-2">Add a workspace on</p>
        <button
          onClick={() => {
            setChoosing(false)
            void onThisMac()
          }}
          className="settings-row-action"
        >
          <ComputerDesktopIcon className="w-4 h-4" />
          This Mac
        </button>
        {connected.map((c) => (
          <button key={c.id} onClick={() => void addOnServer(c.id)} className="settings-row-action">
            <ServerIcon className="w-4 h-4" />
            {c.name}
          </button>
        ))}
        <button onClick={() => setChoosing(false)} className="settings-row-action">
          Cancel
        </button>
      </div>
    )

  return (
    <>
      <button
        onClick={() => {
          setError(null)
          if (connected.length === 0) void onThisMac()
          else setChoosing(true)
        }}
        className="settings-row-action"
      >
        <PlusIcon className="w-4 h-4" />
        Add workspace
      </button>
      {error && <SettingsCallout tone="danger" text={error} role="alert" />}
    </>
  )
}
