import { useEffect, useMemo, useRef, useState } from 'react'
import { ClockIcon, XMarkIcon } from '@heroicons/react/24/outline'
import type { HistoryListEntry } from '../../../src/preload/index.d'

/* The /resume picker: this folder's past Claude conversations, newest first,
   in the dock above the composer where the TUI's own /resume list would be.
   Typing filters by title and last prompt; the arrows walk the list, Enter
   takes the row, Escape closes. The pick itself is the host's to carry out. */

const age = (iso: string | null | undefined, now = Date.now()): string => {
  const at = iso ? Date.parse(iso) : NaN
  if (Number.isNaN(at)) return ''
  const minutes = Math.round((now - at) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(at).toLocaleDateString()
}
const lastAt = (entry: HistoryListEntry): string =>
  entry.lastHumanAt || entry.transcript.modifiedAt || entry.lastSeenAt

export function ResumePicker({
  cwd,
  exclude,
  onPick,
  onClose
}: {
  cwd: string
  /** The conversation this tab already is: never offered to itself. */
  exclude: string | null
  onPick: (entry: HistoryListEntry) => void
  onClose: () => void
}): React.JSX.Element {
  const [entries, setEntries] = useState<HistoryListEntry[] | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let live = true
    Promise.resolve()
      .then(() => window.electronAPI.historyList())
      .then(({ entries }) => {
        if (live) setEntries(entries)
      })
      .catch((error) => {
        if (live) setFailure(String(error))
      })
    return () => {
      live = false
    }
  }, [])
  const here = useMemo(
    () =>
      (entries ?? [])
        .filter(
          (e) =>
            e.provider === 'claude' &&
            e.transcript.exists &&
            e.cwd === cwd &&
            e.claudeSessionId !== exclude
        )
        .sort((a, b) => lastAt(b).localeCompare(lastAt(a))),
    [entries, cwd, exclude]
  )
  const q = query.trim().toLowerCase()
  const shown = q
    ? here.filter((e) =>
        [e.title, e.transcript.lastPrompt ?? ''].some((text) => text.toLowerCase().includes(q))
      )
    : here
  const index = Math.min(active, Math.max(shown.length - 1, 0))
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [index])
  return (
    <section className="chat-prompt" data-kind="resume" aria-label="Resume a conversation">
      <div className="chat-prompt-head">
        <ClockIcon className="chat-tool-status" />
        <span className="chat-prompt-title">Resume a conversation</span>
        <button
          type="button"
          className="chat-turn-copy"
          aria-label="Close"
          title="Close (Esc)"
          onClick={onClose}
        >
          <XMarkIcon />
        </button>
      </div>
      <input
        className="chat-prompt-other chat-resume-search"
        placeholder="Search this folder's conversations"
        aria-label="Search conversations"
        autoFocus
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          setActive(0)
        }}
        onKeyDown={(event) => {
          const count = Math.max(shown.length, 1)
          if (event.key === 'ArrowDown') setActive((i) => (i + 1) % count)
          else if (event.key === 'ArrowUp') setActive((i) => (i - 1 + count) % count)
          else if (event.key === 'Enter' && shown[index]) onPick(shown[index])
          else if (event.key === 'Escape') onClose()
          else return
          event.preventDefault()
          event.stopPropagation()
        }}
      />
      <div ref={list} className="chat-resume-list" role="listbox" aria-label="Conversations">
        {entries === null && !failure && <div className="chat-model-empty">Loading…</div>}
        {failure && <div className="chat-model-empty">Conversations unavailable</div>}
        {entries && here.length === 0 && (
          <div className="chat-model-empty">No past conversation in this folder</div>
        )}
        {here.length > 0 && shown.length === 0 && (
          <div className="chat-model-empty">No conversation matches “{query}”</div>
        )}
        {shown.map((entry, i) => (
          <button
            key={entry.claudeSessionId}
            type="button"
            role="option"
            aria-selected={i === index}
            className="chat-resume-option"
            data-selected={i === index ? 'true' : undefined}
            onMouseEnter={() => setActive(i)}
            onClick={() => onPick(entry)}
          >
            <span className="chat-resume-title">{entry.title}</span>
            <span className="chat-resume-meta">
              {entry.transcript.lastPrompt && (
                <span className="chat-resume-prompt">{entry.transcript.lastPrompt}</span>
              )}
              <span className="chat-resume-age">{age(lastAt(entry))}</span>
            </span>
          </button>
        ))}
      </div>
    </section>
  )
}
