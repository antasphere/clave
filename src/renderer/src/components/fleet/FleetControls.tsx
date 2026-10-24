import { useState } from 'react'
import { questionKey } from '../../lib/question-identity'
import * as Dialog from '@radix-ui/react-dialog'
import { ServerIcon, ArrowPathIcon } from '@heroicons/react/24/outline'
import { ModalScrim, ModalPositioner } from '@clave/ui/components'
import { useFleetStore, reportFleetError } from '../../store/fleet-store'
import { useSessionStore } from '../../store/session-store'
import { ownerOf, isRemoteKey } from '../../lib/fleet-identity'
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

export function FleetRequestHost(): React.JSX.Element | null {
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
