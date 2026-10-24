import { useEffect, useState } from 'react'
import type { SavedServerConnection, ServerConnectionStatus } from '@clave/contract/fleet'
import type { FleetDesktopAPI } from '../../../../preload/fleet-types'
import { describeAddError, describeServerState } from '../../lib/server-connection-text'
import { reportFleetError, useFleetStore } from '../../store/fleet-store'
import {
  SettingsPage,
  SettingsSection,
  SettingsCard,
  SettingsRow,
  SettingsCallout
} from './primitives'

type ServerLogins = Pick<
  Awaited<ReturnType<FleetDesktopAPI['fleetLaunchSettings']>>,
  'claudeAccounts' | 'codexAccounts'
>

function ServerLogins({
  id,
  connected
}: {
  id: string
  connected: boolean
}): React.JSX.Element | null {
  const [logins, setLogins] = useState<ServerLogins | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let current = true
    if (connected) {
      void window.electronAPI.fleetLaunchSettings(id).then(
        ({ claudeAccounts, codexAccounts }) => {
          if (current) setLogins({ claudeAccounts, codexAccounts })
        },
        () => {
          if (current) setFailed(true)
        }
      )
    }
    return () => {
      current = false
    }
  }, [id, connected])

  if (!connected) return null
  const notice = failed ? "Could not read this server's logins." : logins ? '' : 'Reading…'
  return (
    <SettingsRow
      label="Logins on this server"
      description={`The Claude and Codex accounts signed in on the server. Sessions started there use them; manage them on the server.${notice ? ` ${notice}` : ''}`}
      tags={
        logins && (
          <>
            <span className="badge badge-muted">Claude</span>
            {logins.claudeAccounts.map((account) => (
              <span className="badge badge-muted" key={account.id} data-server-login={account.id}>
                {account.label}
              </span>
            ))}
            <span className="badge badge-muted">Codex</span>
            {logins.codexAccounts.map((account) => (
              <span className="badge badge-muted" key={account.id} data-server-login={account.id}>
                {account.label}
              </span>
            ))}
          </>
        )
      }
    />
  )
}

function ServerRow({
  connection,
  status
}: {
  connection: SavedServerConnection
  status: ServerConnectionStatus | undefined
}): React.JSX.Element {
  const { label, error } = describeServerState(status, connection.enabled)
  const connected = connection.enabled && status?.state === 'connected'
  return (
    <div className="settings-row" data-server-id={connection.id}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="settings-row-title">{connection.name}</p>
            <p className="settings-row-description">{connection.url}</p>
          </div>
          <div className="settings-row-controls">
            <span
              className="status-text"
              data-status={connection.enabled ? (status?.state ?? 'connecting') : 'disconnected'}
            >
              {label}
            </span>
            <button
              className="btn-secondary"
              onClick={() =>
                void (
                  connection.enabled
                    ? window.electronAPI.fleetDisconnect(connection.id)
                    : window.electronAPI.fleetConnect(connection.id)
                ).catch(reportFleetError)
              }
            >
              {connection.enabled ? 'Disconnect' : 'Connect'}
            </button>
            <button
              className="btn-secondary"
              onClick={() =>
                void window.electronAPI.fleetRemove(connection.id).catch(reportFleetError)
              }
            >
              Remove
            </button>
          </div>
        </div>
        {error && <SettingsCallout tone="danger" inset role="alert" text={error} />}
        <ServerLogins
          key={`${connection.id}:${connected}`}
          id={connection.id}
          connected={connected}
        />
      </div>
    </div>
  )
}

export function ServersSettings(): React.JSX.Element {
  const connections = useFleetStore((s) => s.connections)
  const statuses = useFleetStore((s) => s.statuses)
  const error = useFleetStore((s) => s.error)
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  useEffect(() => {
    useFleetStore.setState({ error: null })
  }, [])

  const add = async (): Promise<void> => {
    const value = token
    setToken('')
    setBusy(true)
    try {
      await window.electronAPI.fleetSave({ name, url, token: value })
      setName('')
      setUrl('')
      setAddError(null)
    } catch (error) {
      setAddError(describeAddError(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsPage
      title="Servers"
      description="The Clave servers this Mac reaches over your private network. Disconnect keeps the agents running on the server; Remove forgets this device's connection."
    >
      <SettingsSection title="Saved servers">
        <SettingsCard>
          {connections.length ? (
            connections.map((connection) => (
              <ServerRow
                key={connection.id}
                connection={connection}
                status={statuses[connection.id]}
              />
            ))
          ) : (
            <div className="settings-row">
              <p className="settings-row-description">
                No server yet. Add one below with the token the install script printed.
              </p>
            </div>
          )}
        </SettingsCard>
        {error && <SettingsCallout tone="danger" role="alert" text={error} />}
      </SettingsSection>

      <SettingsSection title="Add a server">
        <SettingsCard>
          <div className="settings-row">
            <div className="min-w-0 flex-1">
              <label className="field-label">
                Server name
                <input
                  className="input-field w-full"
                  aria-label="Server name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <label className="field-label">
                Server address
                <input
                  className="input-field w-full"
                  aria-label="Server address"
                  placeholder="http://100.x.y.z:43127"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                />
              </label>
              <label className="field-label">
                Bearer token
                <input
                  className="input-field w-full"
                  aria-label="Server bearer token"
                  type="password"
                  autoComplete="off"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                />
              </label>
              <div className="flex justify-end">
                <button
                  className="btn-primary"
                  disabled={busy || !name.trim() || !url.trim() || !token.trim()}
                  onClick={() => void add()}
                >
                  Add server
                </button>
              </div>
            </div>
          </div>
        </SettingsCard>
        {addError && (
          <div data-testid="servers-add-error">
            <SettingsCallout tone="danger" role="alert" text={addError} />
          </div>
        )}
      </SettingsSection>
    </SettingsPage>
  )
}
