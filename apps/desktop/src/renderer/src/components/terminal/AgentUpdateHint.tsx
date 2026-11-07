import { useState } from 'react'
import { ArrowPathIcon, XMarkIcon } from '@heroicons/react/24/outline'
import { useSessionStore } from '../../store/session-store'
import { useAgentUpdatesStore } from '../../store/agent-updates-store'
import { staleAgentRelease } from '../../lib/agent-update-hint'
import { restartSessionProcess } from '../../lib/switch-account'

/**
 * In the pane's header, beside the account proposal: this tab runs an agent
 * release older than the one Clave just installed. For Claude and Codex one
 * click restarts it on the new release with the conversation resumed; Pi and
 * Antigravity cannot resume, so the hint only says a new tab gets it. Never
 * automatic: an upgrade never interrupts a tab.
 */
export function AgentUpdateHint({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const session = useSessionStore((s) => s.sessions.find((x) => x.id === sessionId))
  const agents = useAgentUpdatesStore((s) => s.agents)
  const dismissedAt = useAgentUpdatesStore((s) => s.dismissedHints[sessionId])
  const dismissHint = useAgentUpdatesStore((s) => s.dismissHint)
  const [error, setError] = useState<string | null>(null)
  if (!session || session.restarting) return null
  const stale = staleAgentRelease(session, agents, dismissedAt)
  if (!stale) return null
  const { agent, from, to, resumable } = stale
  const restart = async (): Promise<void> => {
    setError(null)
    const result = await restartSessionProcess(sessionId)
    if (!result.ok) setError(result.error ?? 'The restart did not go through')
  }
  return (
    <span
      className="badge flex items-center gap-1 flex-shrink-0 bg-surface-100"
      data-agent-update-hint={agent.id}
      title={
        error
          ? error
          : resumable
            ? `This tab runs ${agent.name} ${from}; ${to} is installed. Restarting resumes the conversation on ${to}.`
            : `This tab runs ${agent.name} ${from}; ${to} is installed. A new ${agent.name} tab starts on it.`
      }
    >
      <span className="text-text-secondary">
        {agent.name} {to}
      </span>
      {resumable ? (
        <button
          className="flex items-center gap-1 text-text-primary hover:underline"
          onClick={() => void restart()}
          data-agent-update-restart
        >
          <ArrowPathIcon className="w-3 h-3" />
          {error ? 'Retry restart' : 'Restart'}
        </button>
      ) : (
        <span className="text-text-tertiary">in new tabs</span>
      )}
      <button
        className="text-text-tertiary hover:text-text-primary"
        onClick={() => agent.lastUpdatedAt && dismissHint(sessionId, agent.lastUpdatedAt)}
        aria-label="Dismiss"
        data-agent-update-dismiss
      >
        <XMarkIcon className="w-3 h-3" />
      </button>
    </span>
  )
}
