import { useEffect, useState } from 'react'
import type React from 'react'
import {
  ArrowUturnLeftIcon,
  EllipsisHorizontalIcon,
  StopCircleIcon,
  PencilSquareIcon,
  ArrowRightIcon
} from '@heroicons/react/24/outline'
import { cn } from '@clave/ui/components'
import { useSessionStore } from '../../store/session-store'
import { useWorkspaceStore, getWorkspaceById } from '../../store/workspace-store'
import { ContextMenu, type ContextMenuItem } from '../ui/ContextMenu'
import { useNow } from '../../lib/use-now'
import { conversationConfigDir, relativeTime, type OngoingStatus } from '../../lib/ongoing'
import {
  endOngoing,
  entriesElsewhere,
  openOngoing,
  refusalNotice,
  returnToSidebar,
  setOngoingNote
} from '../../lib/ongoing-actions'
import { useOngoingStore } from '../../store/ongoing-store'
import { OngoingDrawing } from './OngoingDrawing'
import { useOngoingRows, type OngoingRow } from './use-ongoing'
import './ongoing.css'

/**
 * The ongoing conversations of the workspace (PRDCT-4190), a page of the
 * content column like Settings: one card per conversation, what asks for the
 * person first. A card opens its conversation where it was left (resumed
 * from its transcript when no tab runs it); its menu puts it back in the
 * sidebar or ends it. Opened from the sidebar's foot.
 */

const STATUS_LABEL: Record<OngoingStatus, string> = {
  waiting: 'Waiting for you',
  unread: 'New reply',
  working: 'Working',
  open: 'Open',
  elsewhere: 'In another window',
  resting: 'Resting'
}

const STATUS_HINT: Record<OngoingStatus, string> = {
  waiting: 'The agent is asking you something',
  unread: 'Something came in since you last looked',
  working: 'The agent is in a turn',
  open: 'Its tab is running',
  elsewhere: 'Its tab runs in another window; opening it brings the tab here',
  resting: 'No tab runs it now; opening it picks the conversation up where it was'
}

interface LastTurn {
  you: string
  reply: string | null
  at: number | null
}

/** The conversation's last exchange, read from its transcript: what was said
 *  last and the first line of what came back. Read once per card and again
 *  when the tab's state moves. */
function useLastTurn(row: OngoingRow): LastTurn | null | undefined {
  const [turn, setTurn] = useState<LastTurn | null | undefined>(undefined)
  const { cwd, conversationId, provider } = row.entry
  const configDir = conversationConfigDir(row.entry, row.session)
  const pulse = `${row.status}:${row.session?.agentState ?? ''}`
  const read = window.electronAPI?.historyConversation
  useEffect(() => {
    if (!read) return
    let live = true
    read(cwd, conversationId, provider, configDir)
      .then((res) => {
        if (!live) return
        const last = res.exists ? res.turns[res.turns.length - 1] : undefined
        setTurn(
          last
            ? {
                you: last.userText,
                reply: last.replyHead,
                at: last.ts ? Date.parse(last.ts) || null : null
              }
            : null
        )
      })
      .catch(() => {
        if (live) setTurn(null)
      })
    return () => {
      live = false
    }
  }, [read, cwd, conversationId, provider, configDir, pulse])
  return turn
}

function firstLine(text: string, max = 220): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** The note while it is being written: mounted for the edit, so it starts
 *  from the note as it is each time. */
function NoteInput({
  entryId,
  note,
  done
}: {
  entryId: string
  note: string
  done: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(note)
  const commit = (): void => {
    if (draft.trim() !== note) setOngoingNote(entryId, draft)
    done()
  }
  return (
    <input
      autoFocus
      className="ongoing-note-input"
      value={draft}
      maxLength={240}
      placeholder="What this conversation is about"
      aria-label="Note"
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setDraft(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') done()
      }}
      onBlur={commit}
    />
  )
}

function NoteField({
  entryId,
  note,
  editing,
  setEditing
}: {
  entryId: string
  note: string
  editing: boolean
  setEditing: (v: boolean) => void
}): React.JSX.Element {
  if (editing) return <NoteInput entryId={entryId} note={note} done={() => setEditing(false)} />
  return (
    <button
      type="button"
      className={cn('ongoing-note', !note && 'is-empty')}
      onClick={(e) => {
        e.stopPropagation()
        setEditing(true)
      }}
      title="Edit the note"
    >
      {note || 'Add a note'}
    </button>
  )
}

function OngoingCard({
  row,
  now,
  opening,
  onOpen,
  onRefused
}: {
  row: OngoingRow
  now: number
  opening: boolean
  onOpen: () => void
  /** End or Back could not run: the page says why. */
  onRefused: (err: unknown) => void
}): React.JSX.Element {
  const { entry, status, session } = row
  const turn = useLastTurn(row)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [editingNote, setEditingNote] = useState(false)
  const name = session?.name || entry.name

  const items: ContextMenuItem[] = [
    {
      label: entry.note ? 'Edit the note' : 'Add a note',
      icon: <PencilSquareIcon className="w-3.5 h-3.5" />,
      onClick: () => setEditingNote(true)
    },
    {
      label: 'Back to the sidebar',
      icon: <ArrowUturnLeftIcon className="w-3.5 h-3.5" />,
      onClick: () => void returnToSidebar(entry.id).catch(onRefused)
    },
    {
      label: 'End conversation',
      icon: <StopCircleIcon className="w-3.5 h-3.5" />,
      danger: true,
      onClick: () => void endOngoing(entry.id).catch(onRefused)
    }
  ]

  const lastAt = turn?.at ?? null
  return (
    <>
      <article
        className="ongoing-card"
        data-ongoing-card={entry.id}
        data-ongoing-status={status}
        data-menu-open={menu ? 'true' : undefined}
        data-session-id={session?.id}
        role="button"
        tabIndex={0}
        aria-busy={opening || undefined}
        aria-label={`Continue ${name}`}
        onClick={(e) => {
          // The card's menu is drawn in a portal, and React still bubbles its
          // clicks here: an item chosen in it must never also open the card.
          if (!e.currentTarget.contains(e.target as Node)) return
          onOpen()
        }}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onOpen()
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          if (!e.currentTarget.contains(e.target as Node)) return
          setMenu({ x: e.clientX, y: e.clientY })
        }}
      >
        <header className="ongoing-card-head">
          <span className="ongoing-status" data-status={status} title={STATUS_HINT[status]}>
            <span className="ongoing-status-dot" />
            {STATUS_LABEL[status]}
          </span>
          <span className="ongoing-card-when" title={new Date(entry.addedAt).toLocaleString()}>
            {lastAt ? relativeTime(lastAt, now) : `kept ${relativeTime(entry.addedAt, now)}`}
          </span>
          <button
            type="button"
            className="btn-icon btn-icon-sm ongoing-card-more"
            aria-label="More"
            title="More"
            onClick={(e) => {
              e.stopPropagation()
              const r = e.currentTarget.getBoundingClientRect()
              // Under the button, from its left edge: the menu hangs off it.
              setMenu({ x: r.left, y: r.bottom + 4 })
            }}
          >
            <EllipsisHorizontalIcon className="w-4 h-4" />
          </button>
        </header>

        <h3 className="ongoing-card-title">{name}</h3>
        <NoteField
          entryId={entry.id}
          note={entry.note}
          editing={editingNote}
          setEditing={setEditingNote}
        />

        <div className="ongoing-exchange">
          {turn === undefined ? (
            <>
              <span className="ongoing-skeleton" />
              <span className="ongoing-skeleton is-short" />
            </>
          ) : turn ? (
            <>
              <p className="ongoing-exchange-you">
                <span className="ongoing-exchange-who">You</span>
                {firstLine(turn.you, 160)}
              </p>
              {turn.reply && <p className="ongoing-exchange-reply">{firstLine(turn.reply)}</p>}
            </>
          ) : (
            <p className="ongoing-exchange-none">Nothing said yet</p>
          )}
        </div>

        <footer className="ongoing-card-foot">
          <span className="ongoing-card-from" title={entry.cwd}>
            {entry.originGroup ? entry.originGroup.name : entry.cwd.split('/').pop() || entry.cwd}
          </span>
          <span className="ongoing-card-continue">
            {opening ? 'Opening…' : status === 'resting' ? 'Pick up' : 'Continue'}
            <ArrowRightIcon className="w-3.5 h-3.5" />
          </span>
        </footer>
      </article>
      {/* Outside the card: its hover lift is a transform, and a transformed
        ancestor moves the menu's fixed anchor away from the button. */}
      {menu && <ContextMenu items={items} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}
    </>
  )
}

/** Which conversations run in another window, read while the page is open. */
function useElsewhere(active: boolean): ReadonlySet<string> | undefined {
  const entries = useOngoingStore((s) => s.entries)
  const [ids, setIds] = useState<ReadonlySet<string> | undefined>(undefined)
  useEffect(() => {
    if (!active) return
    let live = true
    const read = (): void => {
      void entriesElsewhere(entries).then((next) => {
        if (live) setIds(next)
      })
    }
    read()
    const timer = setInterval(read, 4000)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [active, entries])
  return ids
}

export function OngoingPage(): React.JSX.Element {
  const activeView = useSessionStore((s) => s.activeView)
  const rows = useOngoingRows(useElsewhere(activeView === 'ongoing'))
  const [notice, setNotice] = useState<string | null>(null)
  const now = useNow(30_000)
  const workspaceName = useWorkspaceStore(
    (s) => getWorkspaceById(s.activeWorkspaceId)?.name ?? null
  )
  const [opening, setOpening] = useState<string | null>(null)

  // Escape leaves the page for the tabs, as it leaves Settings.
  useEffect(() => {
    if (activeView !== 'ongoing') return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const target = e.target as HTMLElement | null
      if (target?.closest('input, textarea, [contenteditable="true"], [role="menu"]')) return
      useSessionStore.getState().setActiveView('terminals')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeView])

  const open = (entryId: string): void => {
    if (opening) return
    setOpening(entryId)
    setNotice(null)
    void openOngoing(entryId)
      .catch((err: unknown) => {
        setNotice(refusalNotice(err, 'This conversation could not be opened.'))
      })
      .finally(() => setOpening(null))
  }

  const refused = (err: unknown): void =>
    setNotice(refusalNotice(err, 'This conversation could not be changed.'))

  const waiting = rows.filter((r) => r.status === 'waiting').length

  return (
    <div className="ongoing-page" data-ongoing-page>
      <div className="ongoing-page-inner">
        <header className="ongoing-page-head">
          <div className="ongoing-page-head-text">
            {workspaceName && <p className="ongoing-eyebrow">{workspaceName}</p>}
            <h1 className="ongoing-page-title">Ongoing</h1>
            <p className="ongoing-page-lede">
              Conversations that stay open beside your work. They keep out of the sidebar and wait
              here until you end them.
            </p>
            {rows.length > 0 && (
              <p className="ongoing-page-count">
                {rows.length} conversation{rows.length === 1 ? '' : 's'}
                {waiting > 0 && <span className="is-accent"> · {waiting} waiting for you</span>}
              </p>
            )}
          </div>
          {rows.length > 0 && <OngoingDrawing className="ongoing-head-drawing" />}
        </header>

        {notice && (
          <p className="ongoing-notice" role="status">
            {notice}
          </p>
        )}
        {rows.length === 0 ? (
          <div className="ongoing-empty" data-ongoing-empty>
            <OngoingDrawing />
            <strong>Nothing ongoing</strong>
            <span>
              A conversation you want to keep, without it sitting among your work, goes here:
              right-click its tab and choose Move to Ongoing.
            </span>
          </div>
        ) : (
          <div className="ongoing-grid">
            {rows.map((row) => (
              <OngoingCard
                key={row.entry.id}
                row={row}
                now={now}
                opening={opening === row.entry.id}
                onOpen={() => open(row.entry.id)}
                onRefused={refused}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
