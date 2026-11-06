/* The Terminal view's rows, one module so the view of a subagent
   (`SubAgentPeek`) renders what the agent says and does exactly as the
   transcript would: the same markdown, the same tool runs, the same copy
   under a turn. Moved out of TerminalView.tsx on 6 November 2026; nothing
   here changed in the move. */
import { memo, useMemo, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import { CheckIcon, ClipboardDocumentIcon } from '@heroicons/react/24/outline'
import { createEntryMarkdownPlugins } from './markdown-append'
import type { Entry } from './reducer'
import { SenderChip } from './Delivery'
import { parseDelivery } from '../../../src/shared/exchange-provenance'
import type { ToolGroup as ToolRun } from './tools'
import { TerminalTools } from './TerminalTools'
import { PermissionRow } from './PromptDock'
import { ChatCode } from './code'
import { Attachments } from './Attachments'
import { openLink, wantsExternal } from '../../../src/renderer/src/lib/open-link'

/** When a turn happened, the way a reader wants it: relative while fresh,
 *  clock time today, the date once it is older. */
function whenLabel(at: number, now = Date.now()): string {
  const seconds = Math.round((now - at) / 1000)
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const then = new Date(at)
  const time = then.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const today = new Date(now)
  if (then.toDateString() === today.toDateString()) return time
  const yesterday = new Date(now - 86_400_000)
  if (then.toDateString() === yesterday.toDateString()) return `yesterday ${time}`
  return `${then.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`
}
/** The line under a turn that appears on approach: when it was said, and a copy of it. */
export function TurnMeta({ at, text }: { at: number; text: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <div className="chat-turn-meta">
      <span title={new Date(at).toLocaleString()}>{whenLabel(at)}</span>
      <button
        type="button"
        className="chat-turn-copy"
        data-copied={copied ? 'true' : undefined}
        aria-label="Copy message"
        title="Copy message"
        onClick={() => {
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
        }}
      >
        {copied ? <CheckIcon /> : <ClipboardDocumentIcon />}
      </button>
    </div>
  )
}
/** One turn of the transcript. Memoised on the entry itself, which the
 *  reducer replaces only when that entry changes: a streamed delta re-renders
 *  the answer it grows and nothing above it, and a keystroke in the composer
 *  re-renders no turn at all. A long conversation used to re-parse the
 *  markdown of every answer it held on each of those. */
export const EntryRow = memo(function EntryRow({
  entry,
  onError
}: {
  entry: Entry
  onError: (error: unknown) => void
}): React.JSX.Element | null {
  const streaming = entry.kind === 'assistant' && !entry.final
  const remarkPlugins = useMemo(() => createEntryMarkdownPlugins(streaming), [streaming])
  // Stable component types retain existing links/tables while text grows.
  const markdownComponents = useMemo<Components>(
    () => ({
      code: ChatCode,
      table: ({ children }) => (
        <div className="chat-table-scroll">
          <table>{children}</table>
        </div>
      ),
      a: ({ href, children }) =>
        href && /^(https?:|mailto:)/i.test(href) ? (
          <a
            href={href}
            onClick={(event) => {
              event.preventDefault()
              void openLink(href, { external: wantsExternal(event) }).catch(onError)
            }}
          >
            {children}
          </a>
        ) : (
          <span>{children}</span>
        )
    }),
    [onError]
  )
  if (entry.kind === 'user') {
    // A message another tab sent: its sender in a chip, its words without
    // the bracketed header, in the delivery's own tint.
    const delivery = parseDelivery(entry.text)
    const text = delivery ? delivery.body : entry.text
    return (
      <div
        className="chat-turn-wrap"
        data-side="end"
        data-interrupted={entry.interrupted ? 'true' : undefined}
      >
        <Attachments files={entry.attachments ?? []} />
        {text.trim() !== '' && (
          // The message stands whole; one too tall to pin scrolls away with
          // its exchange instead (question-height.ts).
          <div className="term-question">
            <article
              className="chat-turn"
              data-role="user"
              data-from={delivery ? 'tab' : undefined}
              data-interrupted={entry.interrupted ? 'true' : undefined}
            >
              {delivery && <SenderChip sender={delivery.sender} />}
              {text.replace(/\s+$/, '')}
            </article>
          </div>
        )}
        {entry.interrupted && <span className="chat-turn-note">Interrupted</span>}
        <TurnMeta at={entry.at} text={text} />
      </div>
    )
  }
  if (entry.kind === 'assistant')
    return (
      <div className="chat-turn-wrap" data-side="start">
        <article className="chat-turn chat-prose" data-role="assistant">
          <ReactMarkdown remarkPlugins={remarkPlugins} components={markdownComponents}>
            {entry.text}
          </ReactMarkdown>
        </article>
        <TurnMeta at={entry.at} text={entry.text} />
      </div>
    )
  if (entry.kind === 'permission') return <PermissionRow entry={entry} />
  if (entry.kind === 'error')
    return (
      <div className="chat-notice" data-tone="error" role="alert">
        {entry.message}
      </div>
    )
  return null
})
/** A run of tools, re-rendered only when one of its calls changed or it
 *  stops or starts being the run in flight: the run is rebuilt by
 *  `groupEntries` on every render, its calls are not. */
export const ToolRow = memo(
  TerminalTools,
  (a: { group: ToolRun; live: boolean }, b: { group: ToolRun; live: boolean }) =>
    a.live === b.live &&
    a.group.id === b.group.id &&
    a.group.tools.length === b.group.tools.length &&
    a.group.tools.every((tool, i) => tool === b.group.tools[i])
)
