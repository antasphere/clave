import { useState } from 'react'
import { KeyIcon, XMarkIcon, EyeIcon, EyeSlashIcon } from '@heroicons/react/24/outline'
import { Popover, PopoverTrigger, PopoverContent } from '@clave/ui/components'
import { useSecretStore } from '../../store/secret-store'
import { useSessionStore } from '../../store/session-store'
import { cn } from '@clave/ui/components'
import type { SecretRequestView } from '../../../../preload/index.d'

/**
 * Toolbar entry point for agent-initiated secret requests. The agent never
 * sees the value: the user reviews the exact action here, pastes the secret
 * into a masked input, and main executes with the secret scoped to that one
 * subprocess (or .env write). Badge pulses while requests are waiting.
 */
export function ToolbarSecretPopover(): React.JSX.Element | null {
  const requests = useSecretStore((s) => s.requests)
  const [open, setOpen] = useState(false)
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set())

  const visible = requests.filter(
    (r) =>
      !hiddenIds.has(r.id) &&
      (r.status === 'pending' ||
        r.status === 'running' ||
        r.status === 'completed' ||
        r.status === 'failed')
  )
  const pendingCount = visible.filter((r) => r.status === 'pending').length

  if (visible.length === 0) return null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="btn-icon btn-icon-md flex-shrink-0 relative"
          title={pendingCount > 0 ? `${pendingCount} secret request(s) waiting` : 'Secret requests'}
          style={pendingCount > 0 ? { color: 'var(--color-status-waiting)' } : undefined}
        >
          <KeyIcon className="w-4 h-4" />
          {pendingCount > 0 && (
            <span
              className="badge absolute -top-1 -right-1 text-white"
              style={{
                backgroundColor: 'var(--color-status-waiting)',
                animation: 'pulse-dot 1.5s cubic-bezier(0.4, 0, 0.6, 1) infinite'
              }}
            >
              {pendingCount}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        animated
        open={open}
        side="bottom"
        align="end"
        sideOffset={8}
        className="w-[420px]"
      >
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border-subtle">
          <KeyIcon className="w-3.5 h-3.5 text-text-tertiary" />
          <span className="text-xs text-text-secondary flex-1">Secret requests</span>
          <button onClick={() => setOpen(false)} className="btn-icon btn-icon-xs">
            <XMarkIcon className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="max-h-[400px] overflow-y-auto">
          {visible.map((request, i) => (
            <div
              key={request.id}
              className={cn(i > 0 && 'border-t border-border-subtle')}
            >
              <SecretRequestCard
                request={request}
                onHide={() =>
                  setHiddenIds((prev) => {
                    const next = new Set(prev)
                    next.add(request.id)
                    return next
                  })
                }
              />
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function SecretRequestCard({
  request,
  onHide
}: {
  request: SecretRequestView
  onHide: () => void
}): React.JSX.Element {
  const submit = useSecretStore((s) => s.submit)
  const dismiss = useSecretStore((s) => s.dismiss)
  const submitting = useSecretStore((s) => s.submittingIds.has(request.id))
  const callerName = useSessionStore((s) =>
    request.callerSessionId
      ? (s.sessions.find((sess) => sess.id === request.callerSessionId)?.name ?? null)
      : null
  )
  const [secret, setSecret] = useState('')
  const [reveal, setReveal] = useState(false)

  const handleSubmit = async (): Promise<void> => {
    if (!secret || submitting) return
    try {
      await submit(request.id, secret)
    } finally {
      setSecret('')
      setReveal(false)
    }
  }

  const action = request.action
  const terminal = request.status === 'completed' || request.status === 'failed'

  return (
    <div className="px-3 py-2.5 flex flex-col gap-2">
      <div className="flex items-start gap-2">
        <p className="text-xs text-text-primary flex-1 leading-snug">{request.description}</p>
        {callerName && (
          <span className="text-[10px] text-text-tertiary shrink-0 mt-0.5">{callerName}</span>
        )}
      </div>

      {/* Exact action under review — what will run once the secret is supplied.
          Taller cap so an obfuscated exfiltration command can't hide below the
          fold: the user is the security boundary here, so the full command must
          be easy to read before they paste anything. */}
      <div
        className="rounded p-2 max-h-48 overflow-auto select-text font-mono text-[11px] text-text-secondary"
        style={{ backgroundColor: 'var(--surface-0)' }}
      >
        {action.type === 'run' ? (
          <>
            <div className="whitespace-pre-wrap break-all">{action.command}</div>
            <div className="text-text-tertiary mt-1">
              in {action.cwd} — with ${action.envVar} set to your input
            </div>
          </>
        ) : (
          <div className="text-text-tertiary">
            writes <span className="text-text-secondary">{action.key}=…</span> to{' '}
            <span className="text-text-secondary break-all">{action.file}</span>
          </div>
        )}
      </div>

      {request.status === 'pending' && (
        <div className="flex items-center gap-1.5">
          <div className="relative flex-1">
            <input
              type={reveal ? 'text' : 'password'}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleSubmit()
              }}
              placeholder="Paste secret value…"
              className="input-compact input-compact-icon-right w-full"
              autoComplete="off"
              spellCheck={false}
              autoFocus
            />
            <button
              onClick={() => setReveal((r) => !r)}
              className="btn-icon btn-icon-xs absolute right-1 top-1/2 -translate-y-1/2"
              tabIndex={-1}
            >
              {reveal ? <EyeSlashIcon className="w-3.5 h-3.5" /> : <EyeIcon className="w-3.5 h-3.5" />}
            </button>
          </div>
          <button
            onClick={() => void handleSubmit()}
            disabled={!secret || submitting}
            className="btn-primary disabled:opacity-40"
          >
            Run
          </button>
          <button
            onClick={() => void dismiss(request.id)}
            className="btn-secondary text-text-secondary"
          >
            Dismiss
          </button>
        </div>
      )}

      {request.status === 'running' && (
        <div className="flex items-center gap-2 text-xs text-text-tertiary">
          <div
            className="w-1.5 h-1.5 rounded-full bg-status-working"
            style={{ animation: 'pulse-dot 1.5s cubic-bezier(0.4, 0, 0.6, 1) infinite' }}
          />
          Running…
        </div>
      )}

      {terminal && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <span
              className="badge text-white"
              style={{
                backgroundColor:
                  request.status === 'completed'
                    ? 'var(--color-status-ready)'
                    : 'var(--color-status-error, #d45461)'
              }}
            >
              {request.status === 'completed'
                ? request.outcome?.envFile
                  ? `${request.outcome.envFile.created ? 'created' : 'updated'} ${request.outcome.envFile.key}`
                  : `exit ${request.outcome?.exitCode ?? 0}`
                : 'failed'}
            </span>
            <button onClick={onHide} className="btn-secondary text-text-secondary ml-auto">
              Done
            </button>
          </div>
          {(request.outcome?.stdout || request.outcome?.stderr || request.outcome?.error) && (
            <pre
              className="rounded p-2 max-h-32 overflow-auto select-text font-mono text-[10px] text-text-tertiary whitespace-pre-wrap break-all"
              style={{ backgroundColor: 'var(--surface-0)' }}
            >
              {[request.outcome?.error, request.outcome?.stderr, request.outcome?.stdout]
                .filter(Boolean)
                .join('\n')}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
