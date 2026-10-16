import { useEffect, useState } from 'react'
import { questionKey } from '../../lib/question-identity'
import * as Dialog from '@radix-ui/react-dialog'
import { ServerIcon, ArrowPathIcon } from '@heroicons/react/24/outline'
import { ModalScrim, ModalPositioner } from '@clave/ui/components'
import { SettingsSelect } from '../settings/primitives'
import { useFleetStore, reportFleetError } from '../../store/fleet-store'
import { useSessionStore } from '../../store/session-store'
import {
  useFleetLaunchStore,
  requestFleetLaunch,
  finishFleetLaunch,
  type FleetLaunchRequest
} from '../../store/fleet-launch-store'
import { agentSetupToModes, type AgentKind } from '../../store/launch-prefs'
import { ownerOf, isRemoteKey } from '../../lib/fleet-identity'
import { resourceKey } from '@clave/contract/fleet'
import type { FleetDesktopAPI } from '../../../../preload/fleet-types'
import type {
  FleetPendingRequest as PendingRequest,
  FleetRequestResponse as RequestResponse
} from '../../../../preload/fleet-types'

function FleetDialog({
  title,
  close,
  children
}: {
  title: string
  close: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay asChild>
          <ModalScrim />
        </Dialog.Overlay>
        <Dialog.Content asChild onCloseAutoFocus={(event) => event.preventDefault()}>
          <ModalPositioner className="w-[min(92vw,40rem)]">
            <div className="modal-card modal-pop w-full max-h-[80vh] overflow-auto p-5 flex flex-col gap-3">
              <Dialog.Title className="text-base text-text-primary">{title}</Dialog.Title>
              <Dialog.Description className="text-xs text-text-secondary">
                Use the selected Clave server over your private network.
              </Dialog.Description>
              {children}
            </div>
          </ModalPositioner>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export function FleetControls(): React.JSX.Element {
  const connections = useFleetStore((s) => s.connections)
  const statuses = useFleetStore((s) => s.statuses)
  const error = useFleetStore((s) => s.error)
  const [manage, setManage] = useState(false)
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const add = async (): Promise<void> => {
    setBusy(true)
    const value = token
    setToken('')
    try {
      await window.electronAPI.fleetSave({ name, url, token: value })
      setName('')
      setUrl('')
      useFleetStore.setState({ error: null })
    } catch (error) {
      reportFleetError(error)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <button
        className="sidebar-item w-full flex items-center gap-2"
        onClick={() => setManage(true)}
        aria-label="Manage Clave servers"
      >
        <ServerIcon className="w-4 h-4" />
        <span className="flex-1 text-left">Servers</span>
        <span>{connections.length}</span>
      </button>
      {manage && (
        <FleetDialog
          title="Clave servers"
          close={() => {
            setManage(false)
            setToken('')
          }}
        >
          <p className="text-xs text-text-secondary">
            Disconnect keeps agents running. Remove forgets this device&apos;s connection.
          </p>
          {connections.map((connection) => (
            <div
              key={connection.id}
              className="flex items-center gap-2"
              data-server-id={connection.id}
            >
              <div className="min-w-0 flex-1">
                <div className="text-sm truncate">{connection.name}</div>
                <div className="text-xs text-text-secondary">
                  {statuses[connection.id]?.state ?? 'connecting'}
                </div>
              </div>
              <button
                className="btn-secondary"
                disabled={statuses[connection.id]?.state !== 'connected'}
                onClick={() => {
                  setManage(false)
                  void requestFleetLaunch({ serverId: connection.id, setup: null })
                }}
              >
                New session
              </button>
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
          ))}
          <label className="field-label">
            Server name
            <input
              className="input-field w-full"
              aria-label="Server name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="field-label">
            Tailscale address
            <input
              className="input-field w-full"
              aria-label="Server address"
              placeholder="http://100.x.y.z:port"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
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
              onChange={(e) => setToken(e.target.value)}
            />
          </label>
          {error && (
            <p role="alert" className="text-xs text-text-secondary">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button
              className="btn-dialog"
              onClick={() => {
                setManage(false)
                setToken('')
              }}
            >
              Close
            </button>
            <button
              className="btn-primary"
              disabled={busy || !name.trim() || !url.trim() || !token.trim()}
              onClick={() => void add()}
            >
              Add server
            </button>
          </div>
        </FleetDialog>
      )}
      <FleetLaunchHost />
      <FleetRequestHost />
    </>
  )
}
function FleetLaunchHost(): React.JSX.Element | null {
  const request = useFleetLaunchStore((s) => s.request)
  return request ? (
    <FleetLaunchForm key={`${request.serverId}:${request.groupId ?? ''}`} request={request} />
  ) : null
}
function FleetLaunchForm({ request }: { request: FleetLaunchRequest }): React.JSX.Element {
  const connections = useFleetStore((s) => s.connections)
  const [serverId, setServerId] = useState(request.serverId)
  const [cwd, setCwd] = useState(
    request.cwd ??
      useSessionStore
        .getState()
        .sessions.find(
          (s) => ownerOf(s.id) === serverId && s.id === useSessionStore.getState().focusedSessionId
        )?.cwd ??
      '/'
  )
  const [kind, setKind] = useState<AgentKind | 'terminal'>(request.setup?.kind ?? 'terminal')
  const [profileId, setProfileId] = useState('')
  const [accountId, setAccountId] = useState('')
  const [settings, setSettings] = useState<Awaited<
    ReturnType<FleetDesktopAPI['fleetLaunchSettings']>
  > | null>(null)
  const [directories, setDirectories] = useState<Array<{ name: string; path: string }>>([])
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let current = true
    setSettings(null)
    setProfileId('')
    setAccountId('')
    void window.electronAPI.fleetLaunchSettings(serverId).then(
      (value) => {
        if (current) setSettings(value)
      },
      () => {
        if (current) setNotice('Could not read this server’s launch settings.')
      }
    )
    return () => {
      current = false
    }
  }, [serverId])
  const browse = async (): Promise<void> => {
    try {
      const entries = await window.electronAPI.readDir(resourceKey('file', serverId, '/'), cwd)
      setDirectories(entries.filter((e) => e.type === 'directory'))
      setNotice('')
    } catch {
      setNotice('Could not browse that folder on this server.')
    }
  }
  const launch = async (): Promise<void> => {
    setBusy(true)
    setNotice('')
    try {
      // An explicit stat on the selected endpoint, never a Mac existence check.
      const stat = await window.electronAPI.statFile(resourceKey('file', serverId, '/'), cwd)
      if (stat.type !== 'directory') throw new Error('not a directory')
      const modes =
        kind === 'terminal'
          ? { claudeMode: false }
          : agentSetupToModes({ kind, dangerousMode: request.setup?.dangerousMode ?? false })
      const session = await window.electronAPI.fleetStart(serverId, cwd, {
        ...modes,
        dangerousMode: request.setup?.dangerousMode ?? false,
        ...(profileId ? { launchProfileId: profileId } : {}),
        ...(accountId && (kind === 'claude' || kind === 'claude-agents')
          ? { claudeProfileId: accountId }
          : {}),
        ...(accountId && kind === 'codex' ? { codexAccountId: accountId } : {}),
        ...(request.initialPrompt && kind !== 'terminal' && kind !== 'claude-agents'
          ? { initialPrompt: request.initialPrompt }
          : {})
      })
      await window.electronAPI.fleetSnapshot(serverId)
      const store = useSessionStore.getState()
      if (request.groupId && ownerOf(request.groupId) === serverId)
        store.moveItems([session.id], request.groupId, 'inside')
      useSessionStore.setState({
        selectedSessionIds: [session.id],
        focusedSessionId: session.id,
        activeView: 'terminals'
      })
      finishFleetLaunch(session.id)
    } catch {
      setNotice('Could not start the session on this server. Check the folder and launch settings.')
    } finally {
      setBusy(false)
    }
  }
  const family = kind === 'claude-agents' ? 'claude' : kind
  const accounts =
    family === 'codex'
      ? settings?.codexAccounts
      : family === 'claude'
        ? settings?.claudeAccounts
        : []
  return (
    <FleetDialog title="New server session" close={() => finishFleetLaunch(null)}>
      <SettingsSelect
        value={serverId}
        options={connections.map((c) => ({ value: c.id, label: c.name }))}
        onChange={(id) => {
          setServerId(id)
          setCwd('/')
          setDirectories([])
        }}
        ariaLabel="Session server"
      />
      <SettingsSelect
        value={kind}
        options={['terminal', 'claude', 'codex', 'antigravity', 'pi', 'claude-agents'].map(
          (value) => ({
            value: value as AgentKind | 'terminal',
            label: value === 'terminal' ? 'Terminal' : value
          })
        )}
        onChange={(value) => {
          setKind(value)
          setProfileId('')
          setAccountId('')
        }}
        ariaLabel="Session provider"
      />
      <label className="field-label">
        Server folder
        <input
          className="input-field w-full"
          aria-label="Server folder"
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
        />
      </label>
      <button className="btn-secondary" onClick={() => void browse()}>
        Browse server folders
      </button>
      {directories.length > 0 && (
        <div className="max-h-36 overflow-auto">
          {directories.map((d) => (
            <button
              key={d.path}
              className="menu-item w-full"
              onClick={() => {
                setCwd(d.path)
                setDirectories([])
              }}
            >
              {d.name}
            </button>
          ))}
        </div>
      )}
      {kind !== 'terminal' && (
        <SettingsSelect
          value={profileId || 'default'}
          options={[
            { value: 'default', label: 'Server default profile' },
            ...(settings?.profiles.customProfiles
              .filter((p) => p.family === family)
              .map((p) => ({ value: p.id, label: p.name })) ?? [])
          ]}
          onChange={(id) => setProfileId(id === 'default' ? '' : id)}
          ariaLabel="Server launch profile"
        />
      )}
      {!!accounts?.length && (
        <SettingsSelect
          value={accountId || 'default'}
          options={[
            { value: 'default', label: 'Server default account' },
            ...accounts.map((a) => ({ value: a.id, label: a.label }))
          ]}
          onChange={(id) => setAccountId(id === 'default' ? '' : id)}
          ariaLabel="Server account"
        />
      )}
      {notice && (
        <p role="alert" className="text-xs text-text-secondary">
          {notice}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button className="btn-dialog" onClick={() => finishFleetLaunch(null)}>
          Cancel
        </button>
        <button
          className="btn-primary"
          disabled={busy || !settings || !cwd.startsWith('/')}
          onClick={() => void launch()}
        >
          Start session
        </button>
      </div>
    </FleetDialog>
  )
}

function FleetRequestHost(): React.JSX.Element | null {
  const requests = useFleetStore((s) => s.requests)
  const pending = Object.values(requests)
    .flat()
    .sort((a, b) => a.createdAt - b.createdAt)
  const [hiddenId, setHiddenId] = useState<string | null>(null)
  const request = pending[0]
  if (!request) return null
  return (
    <>
      <button className="sidebar-item w-full text-left" onClick={() => setHiddenId(null)}>
        Requests waiting ({pending.length})
      </button>
      {hiddenId !== request.id && (
        <FleetRequestForm
          key={request.id}
          request={request}
          close={() => setHiddenId(request.id)}
        />
      )}
    </>
  )
}
function FleetRequestForm({
  request,
  close
}: {
  request: PendingRequest
  close: () => void
}): React.JSX.Element {
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const name = useFleetStore(
    (s) => s.connections.find((c) => c.id === ownerOf(request.id))?.name ?? 'Server'
  )
  const sessionName = useSessionStore(
    (s) => s.sessions.find((session) => session.id === request.sessionId)?.name ?? 'Session'
  )
  const resolve = async (response: RequestResponse): Promise<void> => {
    setBusy(true)
    setValue('')
    setAnswers({})
    try {
      await window.electronAPI.fleetResolve(request.id, response)
      close()
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <FleetDialog title={`${name} · ${sessionName}: ${request.kind}`} close={close}>
      <p>{request.description}</p>
      {request.detail && (
        <pre className="text-xs whitespace-pre-wrap max-h-40 overflow-auto">{request.detail}</pre>
      )}
      {request.action && (
        <pre className="text-xs whitespace-pre-wrap">{JSON.stringify(request.action, null, 2)}</pre>
      )}
      {request.kind === 'secret' && (
        <input
          className="input-field"
          type="password"
          autoComplete="off"
          aria-label="Secret value"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      )}
      {request.questions?.map((q) => (
        <label key={questionKey(q)} className="field-label">
          {q.question}
          {q.header && <span className="text-xs text-text-secondary">{q.header}</span>}
          {q.options.length > 0 && (
            <p className="text-xs text-text-secondary">
              {q.options.map((o) => o.label).join(', ')}
            </p>
          )}
          <input
            className="input-field w-full"
            type={request.secretQuestions?.includes(questionKey(q)) ? 'password' : 'text'}
            autoComplete="off"
            aria-label={q.header ?? q.question}
            value={Object.hasOwn(answers, questionKey(q)) ? answers[questionKey(q)] : ''}
            onChange={(e) => setAnswers({ ...answers, [questionKey(q)]: e.target.value })}
          />
        </label>
      ))}
      {failed && (
        <p role="alert" className="text-xs text-text-secondary">
          The response was not accepted. Refresh the connection and try again.
        </p>
      )}
      <div className="flex justify-end gap-2 flex-wrap">
        <button
          className="btn-dialog"
          disabled={busy}
          onClick={() => void resolve({ type: 'dismiss' })}
        >
          Dismiss
        </button>
        {request.kind === 'secret' ? (
          <button
            className="btn-primary"
            disabled={busy || !value}
            onClick={() => void resolve({ type: 'secret', value })}
          >
            Submit secret
          </button>
        ) : request.kind === 'clarification' && !request.providerRequestId ? (
          <button
            className="btn-primary"
            disabled={busy}
            onClick={() => void resolve({ type: 'clarification', answers })}
          >
            Answer
          </button>
        ) : (
          request.options?.map((option) => (
            <button
              className="btn-primary"
              key={option.id}
              disabled={busy}
              onClick={() =>
                void resolve({
                  type: 'permission',
                  optionId: option.id,
                  ...(request.questions?.length && option.id === 'answer' ? { answers } : {})
                })
              }
            >
              {option.label}
            </button>
          ))
        )}
      </div>
    </FleetDialog>
  )
}
export function FleetBadge({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const owner = ownerOf(sessionId)
  const connection = useFleetStore((s) => s.connections.find((c) => c.id === owner))
  const status = useFleetStore((s) => s.statuses[owner]?.state)
  if (!isRemoteKey(sessionId)) return null
  const label = `${connection?.name ?? 'Server'}${status && status !== 'connected' ? ` (${status})` : ''}`
  return (
    <span
      className="flex-shrink-0 text-text-tertiary"
      title={label}
      aria-label={label}
      data-fleet-owner={owner}
      data-fleet-state={status}
    >
      <ServerIcon className="w-3.5 h-3.5" />
    </span>
  )
}
export function FleetResume({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const alive = useSessionStore((s) => s.sessions.find((v) => v.id === sessionId)?.alive)
  const status = useFleetStore((s) => s.statuses[ownerOf(sessionId)]?.state)
  const [busy, setBusy] = useState(false)
  if (!isRemoteKey(sessionId)) return null
  if (status !== 'connected')
    return <span className="text-xs text-text-secondary">{status ?? 'Connecting'}</span>
  if (alive) return null
  return (
    <button
      className="btn-secondary"
      disabled={busy}
      onClick={() => {
        setBusy(true)
        void window.electronAPI
          .restartSession(sessionId, {})
          .then(async (result) => {
            if ('error' in result) throw new Error(result.error)
            await window.electronAPI.fleetSnapshot(ownerOf(sessionId))
          })
          .catch(reportFleetError)
          .finally(() => setBusy(false))
      }}
    >
      <ArrowPathIcon className="w-3.5 h-3.5" />
      Resume
    </button>
  )
}
