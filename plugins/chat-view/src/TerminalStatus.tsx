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

/** The subagents running now, stacked under the status line: what each is,
 *  what it was asked, what it did last, and for how long it has run. */
export function SubAgentStack({ agents }: { agents: SubAgent[] }): React.JSX.Element | null {
  const [now, setNow] = useState(() => Date.now())
  const running = agents.length > 0
  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running])
  if (!running) return null
  return (
    <ul className="term-agents" aria-label="Subagents">
      {agents.map((agent) => (
        <li key={agent.id} className="term-agent" data-background={agent.background || undefined}>
          <span className="term-agent-dot" aria-hidden="true" />
          <span className="term-agent-type">{agent.type}</span>
          <span className="term-agent-description">{agent.description}</span>
          {agent.lastAction && <span className="term-agent-action">{agent.lastAction}</span>}
          <span className="term-agent-meta">
            {agent.toolCount > 0 && `${agent.toolCount} tool${agent.toolCount === 1 ? '' : 's'} · `}
            {elapsed(agent.startedAt, now)}
            {agent.background && ' · background'}
          </span>
        </li>
      ))}
    </ul>
  )
}
