import { useEffect, useRef, useState } from 'react'
import { ArrowPathIcon } from '@heroicons/react/24/outline'
import type { SavedServerConnection, ServerConnectionStatus } from '@clave/contract/fleet'
import type { FleetDesktopAPI } from '../../../../preload/fleet-types'
import type { Workspace } from '../../../../shared/workspace-types'
import type {
  ServerInstallPhase,
  ServerInstallResult,
  ServerInstallStatus,
  TailnetScan
} from '../../../../shared/server-setup-types'
import {
  describeAddError,
  describeInstallFailure,
  describeServerState,
  describeServerVersion,
  INSTALL_PHASE_WORDS,
  INSTALL_WARNING,
  SCAN_UNAVAILABLE,
  UPGRADE_NOW_WARNING
} from '../../lib/server-connection-text'
import { reportFleetError, useFleetStore } from '../../store/fleet-store'
import { ServerCombineRow } from '../fleet/ServerCombineRow'
import { useSessionStore, type SettingsSection as Section } from '../../store/session-store'
import { useSettingsMachineStore } from '../../store/settings-machine-store'
import { savedServerOf } from '../../lib/tailnet-match'
import { useWorkspaceStore } from '../../store/workspace-store'
import {
  SettingsPage,
  SettingsSection,
  SettingsCard,
  SettingsRow,
  SettingsCallout
} from './primitives'

type ServerSettingsRead = Awaited<ReturnType<FleetDesktopAPI['fleetLaunchSettings']>>

/** One stable empty list: a selector answering a fresh array for a server
 *  whose workspace list has not arrived yet would re-render without end. */
const NO_WORKSPACES: Workspace[] = []

/** Opens one of the Agents pages with this server picked in the machine
 *  picker, so a line of the overview leads to its full page. */
function openServerPage(serverId: string, section: Section): void {
  useSettingsMachineStore.getState().setMachine(serverId)
  useSessionStore.getState().setSettingsSection(section)
}

/**
 * What a connected server is about, in a few lines under its connection
 * (PRDCT-4152): its workspaces, the accounts its agents run on, its launch
 * profiles, its usage and its activity, each leading to the full page with
 * this server picked. The accounts and profiles are read once per
 * connection; the workspaces come from the server's own registry, already
 * followed by the workspace store.
 */
function ServerOverview({
  id,
  connected
}: {
  id: string
  connected: boolean
}): React.JSX.Element | null {
  const [read, setRead] = useState<ServerSettingsRead | null>(null)
  const [failed, setFailed] = useState(false)
  const workspaces = useWorkspaceStore((s) => s.serverWorkspaces[id] ?? NO_WORKSPACES)
  const setSettingsSection = useSessionStore((s) => s.setSettingsSection)

  // Read at the connection, and again at every account list the server
  // pushes, so the badges follow an account added on the server.
  useEffect(() => {
    let current = true
    if (!connected) return
    const read = (): void => {
      void window.electronAPI.fleetLaunchSettings(id).then(
        (value) => {
          if (current) setRead(value)
        },
        () => {
          if (current) setFailed(true)
        }
      )
    }
    read()
    const off = window.electronAPI.onFleetSettingsEvent((event) => {
      if (event.serverId !== id) return
      if (event.kind === 'claude-accounts' || event.kind === 'codex-accounts') read()
    })
    return () => {
      current = false
      off()
    }
  }, [id, connected])

  if (!connected) return null
  const notice = failed ? "Could not read this server's settings." : read ? '' : 'Reading…'
  const customProfiles = read?.profiles.customProfiles.length ?? 0
  const open = (section: Section): React.JSX.Element => (
    <button
      className="btn-secondary"
      onClick={() => openServerPage(id, section)}
      data-server-overview-link={section}
    >
      Open
    </button>
  )
  return (
    <div className="settings-card-group" data-server-overview>
      <SettingsRow
        label="Workspaces"
        description={
          workspaces.length
            ? workspaces.map((ws) => ws.name).join(' · ')
            : 'No workspace on this server yet. Add one under General → Workspaces.'
        }
      >
        <button
          className="btn-secondary"
          onClick={() => setSettingsSection('general')}
          data-server-overview-link="general"
        >
          Open
        </button>
      </SettingsRow>
      <SettingsRow
        label="Accounts"
        description={`The Claude and Codex accounts signed in on the server. Sessions started there use them.${notice ? ` ${notice}` : ''}`}
        tags={
          read && (
            <>
              <span className="badge badge-muted">Claude</span>
              {read.claudeAccounts.map((account) => (
                <span className="badge badge-muted" key={account.id} data-server-login={account.id}>
                  {account.label}
                </span>
              ))}
              <span className="badge badge-muted">Codex</span>
              {read.codexAccounts.map((account) => (
                <span className="badge badge-muted" key={account.id} data-server-login={account.id}>
                  {account.label}
                </span>
              ))}
            </>
          )
        }
      >
        {open('accounts')}
      </SettingsRow>
      <SettingsRow
        label="Agents"
        description={
          read
            ? customProfiles
              ? `${customProfiles} custom launch profile${customProfiles === 1 ? '' : 's'} beside the built-in ones.`
              : 'The built-in launch profiles, no custom one yet.'
            : 'The launch profiles its agents start with.'
        }
      >
        {open('agents')}
      </SettingsRow>
      <SettingsRow
        label="Usage"
        description="How much of each account's limits is used, read on the server every five minutes."
      >
        {open('usage')}
      </SettingsRow>
      <SettingsRow
        label="Activity"
        description="Not recorded on a server yet: a Clave server running on its own keeps no activity record."
      >
        {open('activity')}
      </SettingsRow>
      {/* Lane A mounts its per-server pairing switch here, as one line. */}
    </div>
  )
}

/** The server's version against this app's (issue #266): the state in plain
 *  words, the command an older server needs, and "Upgrade now" behind a
 *  confirmation of what it ends. */
function ServerVersion({ id }: { id: string }): React.JSX.Element | null {
  const status = useFleetStore((s) => s.versions[id])
  const text = describeServerVersion(status)
  const [confirming, setConfirming] = useState(false)
  const [copied, setCopied] = useState(false)
  const resetCopied = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (resetCopied.current) clearTimeout(resetCopied.current)
    },
    []
  )
  if (!status || !text) return null
  const copy = async (command: string): Promise<void> => {
    await navigator.clipboard.writeText(command)
    setCopied(true)
    if (resetCopied.current) clearTimeout(resetCopied.current)
    resetCopied.current = setTimeout(() => setCopied(false), 1500)
  }
  const upgrade = (): void => {
    setConfirming(false)
    void window.electronAPI.fleetUpgradeServer(id).catch(reportFleetError)
  }
  return (
    <div data-server-version={status.kind}>
      <div className="flex items-center justify-between gap-4">
        <p className="settings-row-description">
          {text.version && <span data-server-version-number>{text.version} · </span>}
          <span data-server-version-state data-status={text.tone} className="whitespace-pre-line">
            {text.state}
          </span>
        </p>
        {text.upgradeNow && !confirming && (
          <div className="settings-row-controls">
            <button className="btn-secondary" onClick={() => setConfirming(true)}>
              Upgrade now
            </button>
          </div>
        )}
      </div>
      {text.command && (
        <div className="flex items-center justify-between gap-4">
          <code className="settings-row-value font-mono select-text" data-server-version-command>
            {text.command}
          </code>
          <div className="settings-row-controls">
            <button className="btn-secondary" onClick={() => void copy(text.command!)}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      )}
      {confirming && (
        <SettingsCallout
          tone="danger"
          inset
          text={UPGRADE_NOW_WARNING}
          actions={
            <>
              <button className="btn-secondary" onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button className="btn-primary" onClick={upgrade}>
                Upgrade now
              </button>
            </>
          }
        />
      )}
    </div>
  )
}

function ServerRow({
  connection,
  status
}: {
  connection: SavedServerConnection
  status: ServerConnectionStatus | undefined
}): React.JSX.Element {
  const { label, error, tone } = describeServerState(status, connection.enabled)
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
            <span className="status-text" data-status={tone}>
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
        {connection.enabled && <ServerVersion id={connection.id} />}
        <ServerOverview
          key={`${connection.id}:${connected}`}
          id={connection.id}
          connected={connected}
        />
        <ServerCombineRow id={connection.id} />
      </div>
    </div>
  )
}

// ── This Mac as a server (PRDCT-4153) ───────────────────────────────────────

type InstallStep =
  | { kind: 'idle' }
  | { kind: 'confirming' }
  | { kind: 'running'; phase: ServerInstallPhase }
  | { kind: 'failed'; result: Extract<ServerInstallResult, { ok: false }> }

const SERVICE_WORDS = { running: 'Running', stopped: 'Stopped', 'not-installed': 'Not installed' }

/**
 * "Run Clave as a server on this Mac": the standalone service installed by
 * the repository's install script, the Tailscale address picked for it,
 * the server added to this Mac's own list, the token offered to copy and
 * never shown, and the service's state afterwards. The script runs in main;
 * this page sees its phases and its outcome, never its output.
 */
function ThisMacServer(): React.JSX.Element {
  const [status, setStatus] = useState<ServerInstallStatus | null>(null)
  const [step, setStep] = useState<InstallStep>({ kind: 'idle' })
  const [copied, setCopied] = useState<'no' | 'yes' | 'failed'>('no')
  const version = useFleetStore((s) => (status?.serverId ? s.versions[status.serverId] : undefined))
  const resetCopied = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = (): void => {
    void window.electronAPI.serverSetupInstallStatus().then(setStatus, () => undefined)
  }
  useEffect(() => {
    refresh()
    // The phases reach every window; a run started elsewhere (another
    // window) settles here too, its outcome shown where it was started.
    const off = window.electronAPI.onServerSetupProgress(({ phase }) => {
      if (phase === 'done' || phase === 'failed') {
        setStep((step) => (step.kind === 'running' ? { kind: 'idle' } : step))
        refresh()
        return
      }
      setStep({ kind: 'running', phase })
    })
    return () => {
      off()
      if (resetCopied.current) clearTimeout(resetCopied.current)
    }
  }, [])

  const install = async (): Promise<void> => {
    setStep({ kind: 'running', phase: 'starting' })
    try {
      const result = await window.electronAPI.serverSetupInstall()
      if (result.ok) {
        setStep({ kind: 'idle' })
        // The version sync reads the new server on its own clock; ask now so
        // the service line has it when the page reads it again.
        void window.electronAPI.fleetServerVersions(true).catch(() => undefined)
      } else setStep({ kind: 'failed', result })
    } catch {
      setStep({
        kind: 'failed',
        result: { ok: false, code: 'launch-failed', logPath: '' }
      })
    }
    refresh()
  }

  const copyToken = async (): Promise<void> => {
    try {
      await window.electronAPI.serverSetupCopyToken()
      setCopied('yes')
    } catch {
      setCopied('failed')
    }
    if (resetCopied.current) clearTimeout(resetCopied.current)
    resetCopied.current = setTimeout(() => setCopied('no'), 1500)
  }

  const installed = status?.installed ?? false
  const running = step.kind === 'running'
  const listen = status?.tailscaleIp
    ? `It listens on this Mac's Tailscale address, ${status.tailscaleIp}, so your other Macs reach it over your tailnet.`
    : 'Tailscale is not running on this Mac, so it listens on this Mac only (127.0.0.1): another Mac reaches it through an SSH tunnel.'
  const versionText = describeServerVersion(version)

  return (
    <SettingsSection
      title="This Mac as a server"
      description="A Clave server that outlives the app: its sessions keep running after you quit, and your other Macs work in them."
    >
      <SettingsCard data-this-mac-server data-install-state={status?.state ?? 'unknown'}>
        <SettingsRow
          label="Run Clave as a server on this Mac"
          description={
            installed
              ? 'Installed. Running the install again updates it to the latest release and keeps the address it was given.'
              : `Installs the standalone server as a background service of your user, built from the latest release. ${listen}`
          }
        >
          {!running && step.kind !== 'confirming' && (
            <button
              className="btn-primary"
              onClick={() => setStep({ kind: 'confirming' })}
              data-install-server
            >
              {installed ? 'Install again' : 'Run Clave as a server on this Mac'}
            </button>
          )}
          {running && (
            <span className="status-text" data-status="connecting" data-install-phase={step.phase}>
              <ArrowPathIcon className="w-3.5 h-3.5 animate-spin inline-block mr-1 align-[-2px]" />
              {INSTALL_PHASE_WORDS[step.phase]}…
            </span>
          )}
        </SettingsRow>
        {step.kind === 'confirming' && (
          <SettingsCallout
            tone="accent"
            inset
            text={INSTALL_WARNING}
            actions={
              <>
                <button className="btn-secondary" onClick={() => setStep({ kind: 'idle' })}>
                  Cancel
                </button>
                <button className="btn-primary" onClick={() => void install()} data-install-confirm>
                  Install the server
                </button>
              </>
            }
          />
        )}
        {step.kind === 'failed' && (
          <SettingsCallout
            tone="danger"
            inset
            role="alert"
            title="The install failed"
            text={
              <span className="whitespace-pre-line">{describeInstallFailure(step.result)}</span>
            }
            actions={
              <button className="btn-secondary" onClick={() => setStep({ kind: 'idle' })}>
                Dismiss
              </button>
            }
          />
        )}
        {installed && status?.url && (
          <>
            <SettingsRow label="Address" description="What another Mac adds under Add a server.">
              <code className="settings-row-value font-mono select-text" data-install-url>
                {status.url}
              </code>
            </SettingsRow>
            <SettingsRow
              label="Token"
              description="The bearer token another Mac pastes with the address. Copied, never shown."
            >
              <button
                className="btn-secondary"
                onClick={() => void copyToken()}
                data-install-copy-token
              >
                {copied === 'yes'
                  ? 'Copied'
                  : copied === 'failed'
                    ? 'Could not copy'
                    : 'Copy token'}
              </button>
            </SettingsRow>
            <SettingsRow
              label="Service"
              description={
                versionText?.version
                  ? `${versionText.version} · ${versionText.state}`
                  : 'The background service on this Mac.'
              }
            >
              <span
                className="status-text"
                data-status={status.state === 'running' ? 'connected' : 'idle'}
                data-install-service={status.state}
              >
                {SERVICE_WORDS[status.state]}
              </span>
              <button
                className="btn-icon btn-icon-sm"
                onClick={refresh}
                title="Read the state again"
                aria-label="Read the service state again"
              >
                <ArrowPathIcon className="w-3.5 h-3.5" />
              </button>
            </SettingsRow>
          </>
        )}
      </SettingsCard>
    </SettingsSection>
  )
}

// ── The tailnet scan (PRDCT-4153) ───────────────────────────────────────────

/**
 * The machines of this Mac's tailnet, from Tailscale's own status, the ones
 * answering as a Clave server on the default port marked; a pick fills the
 * address and the name, the token stays pasted by hand. A machine that is
 * already one of the saved servers (same host, same port; PRDCT-4163) shows
 * that server's name and its connection state instead of Use: there is
 * nothing to add, and Use would have saved it twice.
 */
function TailnetScan({
  onPick
}: {
  onPick: (machine: { name: string; url: string }) => void
}): React.JSX.Element {
  const [scan, setScan] = useState<TailnetScan | null>(null)
  const [busy, setBusy] = useState(false)
  const connections = useFleetStore((s) => s.connections)
  const statuses = useFleetStore((s) => s.statuses)
  const run = async (): Promise<void> => {
    setBusy(true)
    try {
      setScan(await window.electronAPI.serverSetupScan())
    } catch {
      setScan({ available: false, reason: 'failed' })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div data-tailnet-scan>
      <SettingsRow
        label="Your Tailscale machines"
        description="The machines of your tailnet, with the ones running a Clave server marked. Pick one to fill the address."
      >
        <button
          className="btn-secondary"
          onClick={() => void run()}
          disabled={busy}
          data-tailnet-scan-button
        >
          <ArrowPathIcon className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} />
          {scan ? 'Scan again' : 'Scan Tailscale'}
        </button>
      </SettingsRow>
      {scan && !scan.available && (
        <div className="settings-row" data-tailnet-unavailable={scan.reason}>
          <p className="settings-row-description">{SCAN_UNAVAILABLE[scan.reason]}</p>
        </div>
      )}
      {scan?.available && scan.machines.length === 0 && (
        <div className="settings-row">
          <p className="settings-row-description">No other machine on your tailnet.</p>
        </div>
      )}
      {scan?.available &&
        scan.machines.map((machine) => {
          const saved = savedServerOf(machine, connections)
          const state = saved ? describeServerState(statuses[saved.id], saved.enabled) : null
          return (
            <div
              className="settings-row"
              key={machine.dnsName || machine.ip || machine.name}
              data-tailnet-machine={machine.ip || machine.name}
              data-clave-server={machine.claveServer ? 'true' : undefined}
              data-online={machine.online ? 'true' : undefined}
              data-saved-server={saved?.id}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <p className="settings-row-title truncate">{machine.name}</p>
                  {saved ? (
                    <span className="badge badge-muted truncate">Saved as {saved.name}</span>
                  ) : (
                    machine.claveServer && <span className="badge badge-muted">Clave server</span>
                  )}
                  {!machine.online && <span className="badge badge-muted">Offline</span>}
                </div>
                <p className="settings-row-description truncate">
                  {machine.ip || 'No IPv4 address'}
                  {machine.os ? ` · ${machine.os}` : ''}
                </p>
              </div>
              <div className="settings-row-controls">
                {saved && state ? (
                  <span className="status-text" data-status={state.tone}>
                    {state.label}
                  </span>
                ) : (
                  <button
                    className="btn-secondary"
                    onClick={() => onPick({ name: machine.name, url: machine.url })}
                    disabled={!machine.online || !machine.url}
                    data-tailnet-use
                  >
                    Use
                  </button>
                )}
              </div>
            </div>
          )
        })}
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
    // ── Issue #266: read every server's version again when the page opens ──
    void window.electronAPI.fleetServerVersions(true).catch(() => undefined)
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

      <ThisMacServer />

      <SettingsSection title="Add a server">
        <SettingsCard>
          <TailnetScan
            onPick={(machine) => {
              setName(machine.name)
              setUrl(machine.url)
            }}
          />
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
