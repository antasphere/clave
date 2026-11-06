import { compactTokens } from './terminal-status'

/** How full the context is: a bar and "(used/window)". Before a turn has named
 *  the window the bar stays empty and only the count shows. The chat variant
 *  wears the chat view's material and drops the parentheses. */
export function ContextMeter({
  used,
  window,
  variant = 'term'
}: {
  used: number | null
  window: number | null
  variant?: 'term' | 'chat'
}): React.JSX.Element {
  const ratio = used !== null && window ? Math.min(1, used / window) : 0
  const count =
    used === null
      ? window
        ? `0/${compactTokens(window)}`
        : '—'
      : window
        ? `${compactTokens(used)}/${compactTokens(window)}`
        : compactTokens(used)
  const label = variant === 'chat' ? count : `(${count})`
  const chat = variant === 'chat'
  return (
    <span
      className={chat ? 'chat-context' : 'term-context'}
      title={
        used !== null && window
          ? `Context: ${Math.round(ratio * 100)}% used`
          : 'Context: known after the first answer'
      }
    >
      <span
        className={chat ? 'chat-context-bar' : 'term-context-bar'}
        role="meter"
        aria-label="Context used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(ratio * 100)}
        data-level={ratio >= 0.9 ? 'high' : ratio >= 0.7 ? 'mid' : undefined}
      >
        <span
          className={chat ? 'chat-context-fill' : 'term-context-fill'}
          data-some={used ? 'true' : undefined}
          style={{ inlineSize: `${ratio * 100}%` }}
        />
      </span>
      <span className={chat ? 'chat-context-count' : 'term-dim'}>{label}</span>
    </span>
  )
}
