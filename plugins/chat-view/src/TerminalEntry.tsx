/* The Terminal view's rows, one module so the view of a subagent
   (`SubAgentPeek`) renders what the agent says and does exactly as the
   transcript would: the same markdown, the same tool runs, the same copy
   under a turn. Moved out of TerminalView.tsx on 6 November 2026; nothing
   here changed in the move. */
import { memo, useMemo, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import { CheckIcon, ClipboardDocumentIcon } from '@heroicons/react/24/outline'
import { createEntryMarkdownPlugins } from './markdown-append'
import type { Entry } from './reducer'
import { SenderChip } from './Delivery'
import { parseDelivery } from '../../../src/shared/exchange-provenance'
import type { ToolGroup as ToolRun } from './tools'
import { TerminalTools } from './TerminalTools'
import { InlineQuestion, PermissionRow } from './PromptDock'
import { ModeLine } from './PermissionReading'
import { isQuestion } from './approvals'
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
          <TermQuestion
            text={text.replace(/\s+$/, '')}
            sender={delivery ? <SenderChip sender={delivery.sender} /> : null}
            fromTab={!!delivery}
            interrupted={!!entry.interrupted}
          />
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
  if (entry.kind === 'permission')
    return isQuestion(entry.request) && !entry.answer && !entry.answeredElsewhere ? (
      <InlineQuestion entry={entry} />
    ) : (
      <PermissionRow entry={entry} />
    )
  if (entry.kind === 'error')
    return (
      <div className="chat-notice" data-tone="error" role="alert">
        {entry.message}
      </div>
    )
  if (entry.kind === 'mode')
    return <ModeLine label={entry.label} fromLabel={entry.fromLabel} by={entry.by} />
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

/** The reader's message, always whole in the flow. A short one stays pinned
 *  over its answer as it is. A long one (question-height.ts marks its row
 *  `data-tall`) is pinned only once it has been read past, and then as its
 *  first lines, fading out: the preview below, drawn from `data-text` by
 *  the stylesheet so its words are not in the document twice (find in page,
 *  copy). A click on the preview glides back up to the whole message; a click
 *  on the whole message glides down to where it pins. A click that ends a
 *  text selection is a selection, not a jump. */
function TermQuestion({
  text,
  sender,
  fromTab,
  interrupted
}: {
  text: string
  sender: ReactNode
  fromTab: boolean
  interrupted: boolean
}): React.JSX.Element {
  return (
    <>
      <div
        className="term-question"
        onClick={(event) => {
          const row = tallRow(event.currentTarget)
          if (!row) return
          // Down to where the preview takes over: the row's sticky offset.
          glide(row, row.getBoundingClientRect().top - parseFloat(getComputedStyle(row).top))
        }}
      >
        <article
          className="chat-turn"
          data-role="user"
          data-from={fromTab ? 'tab' : undefined}
          data-interrupted={interrupted ? 'true' : undefined}
        >
          {sender}
          {text}
        </article>
      </div>
      <div
        className="term-question-pin"
        data-from={fromTab ? 'tab' : undefined}
        data-text={text}
        aria-hidden="true"
        onClick={(event) => {
          const row = tallRow(event.currentTarget)
          const section = row?.parentElement
          if (!row || !section) return
          // Up to the message's own place, the pin gap under the top edge.
          glide(row, section.getBoundingClientRect().top - pinGap(row))
        }}
      />
    </>
  )
}

/** The long message's row a click landed in, unless the click made a
 *  selection or the message is not a long one. */
function tallRow(target: HTMLElement): HTMLElement | null {
  if (window.getSelection()?.toString()) return null
  const row = target.closest<HTMLElement>('.chat-turn-wrap')
  return row?.hasAttribute('data-tall') ? row : null
}

/** The pin gap, resolved: the row's sticky top plus the offset that lifts a
 *  long message's top above the edge (question-height.ts). */
function pinGap(row: HTMLElement): number {
  const top = parseFloat(getComputedStyle(row).top) || 0
  return top + (parseFloat(row.style.getPropertyValue('--question-pin-offset')) || 0)
}

/** Scroll the transcript so a point now `to` px below the top of the viewport
 *  (in the document's frame) lands at its top, smoothly. */
function glide(row: HTMLElement, to: number): void {
  const scroller = row.closest<HTMLElement>('.chat-scroll')
  if (!scroller) return
  scroller.scrollBy({ top: to - scroller.getBoundingClientRect().top, behavior: 'smooth' })
}
