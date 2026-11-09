import { useState } from 'react'
import { questionKey } from '../../lib/question-identity'
import * as Dialog from '@radix-ui/react-dialog'
import { ServerIcon, ArrowPathIcon } from '@heroicons/react/24/outline'
import { ModalScrim, ModalPositioner } from '@clave/ui/components'
import { useFleetStore, reportFleetError } from '../../store/fleet-store'
import { useSessionStore } from '../../store/session-store'
import { useWorkspaceStore } from '../../store/workspace-store'
import { usePairingStore } from '../../store/pairing-store'
import { ownerOf, isRemoteKey } from '../../lib/fleet-identity'
import { useDockPaneIds } from '../../views/pane-kind'
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
            <div className="modal-card modal-pop w-full max-h-[80vh] overflow-auto overscroll-contain p-5 flex flex-col gap-3">
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

/** A request an agent raised through its provider (a tool to allow, questions
 *  to answer) is answered in its own session's pane, in the dock a local
 *  session uses, whenever that pane is a view that has the dock. One whose
 *  pane has none (the chat view disabled, a surface view) still waits here,
 *  with what an agent asked through Clave's own tools. */
const answeredInPane = (request: PendingRequest, docked: ReadonlySet<string>): boolean =>
  request.providerRequestId !== undefined && docked.has(request.sessionId)

export function FleetRequestHost(): React.JSX.Element | null {
  const requests = useFleetStore((s) => s.requests)
  const docked = useDockPaneIds()
  const pending = Object.values(requests)
    .flat()
    .filter((request) => !answeredInPane(request, docked))
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
/** Which machine a row runs on, when it is not this Mac. In a server's own
 *  workspace every tab is the server's, so the icon alone says it. In a Mac
 *  workspace a server tab is there because its workspace is paired with this
 *  one (PRDCT-4151), and the badge says where it runs: the server's name, in
 *  the colour that server wears on this Mac. */
function MachineBadge({
  ownerKey,
  kind
}: {
  ownerKey: string
  kind: 'session' | 'group'
}): React.JSX.Element | null {
  const owner = ownerOf(ownerKey)
  const connection = useFleetStore((s) => s.connections.find((c) => c.id === owner))
  const status = useFleetStore((s) => s.statuses[owner]?.state)
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const color = usePairingStore((s) => s.servers[owner]?.color)
  if (!isRemoteKey(ownerKey)) return null
  const name = connection?.name ?? 'Server'
  const label = `${name}${status && status !== 'connected' ? ` (${status})` : ''}`
  const named = activeWorkspaceId !== null && !isRemoteKey(activeWorkspaceId)
  if (named)
    return (
      <span
        className="badge flex-shrink-0 max-w-[110px]"
        style={color ? { backgroundColor: `${color}26`, color } : undefined}
        title={`Runs on ${label}`}
        aria-label={`Runs on ${label}`}
        data-fleet-owner={owner}
        data-fleet-state={status}
        data-fleet-badge={kind}
      >
        <ServerIcon className="w-3 h-3 flex-shrink-0" />
        <span className="truncate">{name}</span>
      </span>
    )
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
export function FleetBadge({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  return <MachineBadge ownerKey={sessionId} kind="session" />
}
/** A server group's header, in a Mac workspace it is paired into: the same
 *  badge as its tabs, so the group reads as the server's at a glance. */
export function FleetGroupBadge({ groupId }: { groupId: string }): React.JSX.Element | null {
  return <MachineBadge ownerKey={groupId} kind="group" />
}
/** The side panel's machine, when the folder it shows is a server's: the
 *  server's name in its colour, before the path. Nothing for this Mac. */
export function MachineChip({ serverId }: { serverId: string }): React.JSX.Element | null {
  const connection = useFleetStore((s) => s.connections.find((c) => c.id === serverId))
  const color = usePairingStore((s) => s.servers[serverId]?.color)
  if (serverId === 'local') return null
  const name = connection?.name ?? 'Server'
  return (
    <span
      className="badge flex-shrink-0 max-w-[120px] mr-1"
      style={color ? { backgroundColor: `${color}26`, color } : undefined}
      title={`Files and git of ${name}`}
      data-panel-machine={serverId}
    >
      <ServerIcon className="w-3 h-3 flex-shrink-0" />
      <span className="truncate">{name}</span>
    </span>
  )
}
export function FleetResume({
  sessionId,
  drawnInPane = false
}: {
  sessionId: string
  /** The pane's view draws the ended state with Resume in it: the header
   *  shows none WHILE that drawing is up (not while the pane says the tab is
   *  moving to another account, or out of credits, which draw no Resume). */
  drawnInPane?: boolean
}): React.JSX.Element | null {
  const alive = useSessionStore((s) => s.sessions.find((v) => v.id === sessionId)?.alive)
  const drawing = useSessionStore((s) => {
    const session = s.sessions.find((v) => v.id === sessionId)
    return session?.restarting !== true && !session?.limitReported
  })
  const status = useFleetStore((s) => s.statuses[ownerOf(sessionId)]?.state)
  const [busy, setBusy] = useState(false)
  // Why the last Resume failed, said in the tab (PRDCT-4191): until now the
  // failure went to one generic line that only Settings → Servers showed,
  // and the tab kept its "restarting" mark with nothing to click.
  const [failure, setFailure] = useState<string | null>(null)
  // A tab back alive has nothing left to explain: the last failure goes with
  // it, so it never shows again at a later stop (round 1, N3). Derived during
  // the render, the way React asks for state that follows a prop.
  const [wasAlive, setWasAlive] = useState(alive)
  if (alive !== wasAlive) {
    setWasAlive(alive)
    if (alive && failure !== null) setFailure(null)
  }
  // A tab of a connected server waits for its connection; a tab of this Mac
  // (the app's own server, a daemon it is attached to) needs none: every
  // stopped tab offers Resume (PRDCT-4236), since a restart brings back a
  // tab the restore placed stopped as it brings back a tab whose process
  // ended on its own.
  const remote = isRemoteKey(sessionId)
  if (remote && status !== 'connected')
    return <span className="text-xs text-text-secondary">{status ?? 'Connecting'}</span>
  if (alive !== false) return null
  // The connection's word stays in the header; the button is the pane's,
  // while the pane draws it (round 5). Only a server tab's pane draws one.
  if (remote && drawnInPane && drawing) return null
  return (
    <>
      {failure ? (
        <span
          className="text-xs text-text-secondary truncate max-w-[16rem]"
          data-fleet-resume-error
          role="alert"
          title={failure}
        >
          {failure}
        </span>
      ) : null}
      <button
        className="btn-secondary"
        disabled={busy}
        onClick={() => {
          setBusy(true)
          setFailure(null)
          void window.electronAPI
            .restartSession(sessionId, { onlyIfStopped: true })
            .then(async (result) => {
              if ('error' in result) throw new Error(result.error)
              if (remote) await window.electronAPI.fleetSnapshot(ownerOf(sessionId))
            })
            .catch((error: unknown) => {
              // The server said no (or did not answer): the tab is not
              // restarting any more, and the reason is this tab's to show.
              useSessionStore.getState().setSessionRestarting(sessionId, false)
              setFailure(`Resume failed: ${error instanceof Error ? error.message : String(error)}`)
              reportFleetError(error)
            })
            .finally(() => setBusy(false))
        }}
      >
        <ArrowPathIcon className="w-3.5 h-3.5" />
        Resume
      </button>
    </>
  )
}
