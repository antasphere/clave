import { useEffect, useState } from 'react'
import { compactTokens, type SubAgent } from './terminal-status'

/** How full the context is: a bar and "(used/window)". Before a turn has named
 *  the window the bar stays empty and only the count shows. */
export function ContextMeter({
  used,
  window
}: {
  used: number | null
  window: number | null
}): React.JSX.Element {
  const ratio = used !== null && window ? Math.min(1, used / window) : 0
  const label =
    used === null
      ? window
        ? `(0/${compactTokens(window)})`
        : '(—)'
      : window
        ? `(${compactTokens(used)}/${compactTokens(window)})`
        : `(${compactTokens(used)})`
  return (
    <span
      className="term-context"
      title={
        used !== null && window
          ? `Context: ${Math.round(ratio * 100)}% used`
          : 'Context: known after the first answer'
      }
    >
      <span
        className="term-context-bar"
        role="meter"
        aria-label="Context used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(ratio * 100)}
        data-level={ratio >= 0.9 ? 'high' : ratio >= 0.7 ? 'mid' : undefined}
      >
        <span className="term-context-fill" style={{ inlineSize: `${ratio * 100}%` }} />
      </span>
      <span className="term-dim">{label}</span>
    </span>
  )
}

function elapsed(since: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - since) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60
    ? `${minutes}m ${seconds % 60}s`
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** How long a leaving row takes to fold away; the stylesheet's transition
 *  is twice the default duration, and this waits a little past it. */
const LEAVE_MS = 340

/** The subagents running now, stacked under the status line: what each is,
 *  what it was asked, what it did last, how full its own context is and how
 *  long it has run. A row folds open as its agent starts and folds shut as it
 *  ends, so the stack is held for the length of the fold after an agent has
 *  gone; the stack itself folds away with its last row. */
export function SubAgentStack({ agents }: { agents: SubAgent[] }): React.JSX.Element | null {
  const [now, setNow] = useState(() => Date.now())
  const [leaving, setLeaving] = useState<SubAgent[]>([])
  const [previous, setPrevious] = useState(agents)
  // An agent the props no longer list is kept, marked leaving, for the fold.
  if (previous !== agents) {
    const ids = new Set(agents.map((agent) => agent.id))
    const gone = previous.filter((agent) => !ids.has(agent.id))
    setPrevious(agents)
    setLeaving((current) => [
      ...current.filter((agent) => !ids.has(agent.id)),
      ...gone.filter((agent) => !current.some((c) => c.id === agent.id))
    ])
  }
  useEffect(() => {
    if (!leaving.length) return
    const timer = window.setTimeout(() => setLeaving([]), LEAVE_MS)
    return () => window.clearTimeout(timer)
  }, [leaving])
  const running = agents.length > 0
  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running])
  if (!running && !leaving.length) return null
  const rows = [
    ...agents.map((agent) => ({ agent, gone: false })),
    ...leaving.map((agent) => ({ agent, gone: true }))
  ]
  return (
    <div className="term-agents" data-empty={running ? undefined : 'true'}>
      <ul className="term-agents-list" aria-label="Subagents">
        {rows.map(({ agent, gone }) => (
          <li
            key={agent.id}
            className="term-agent"
            data-background={agent.background || undefined}
            data-leaving={gone || undefined}
          >
            <div className="term-agent-row">
              <span className="term-agent-dot" aria-hidden="true" />
              <span className="term-agent-type">{agent.type}</span>
              <span className="term-agent-description">{agent.description}</span>
              {agent.lastAction && <span className="term-agent-action">{agent.lastAction}</span>}
              <span className="term-agent-meta">
                {agent.toolCount > 0 &&
                  `${agent.toolCount} tool${agent.toolCount === 1 ? '' : 's'} · `}
                {agent.contextUsed !== null && (
                  <span title="Tokens in this agent's own context">
                    {compactTokens(agent.contextUsed)} ctx ·{' '}
                  </span>
                )}
                {elapsed(agent.startedAt, now)}
                {agent.background && ' · background'}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
