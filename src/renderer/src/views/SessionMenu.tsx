import { useEffect, useRef, useState } from 'react'
import * as DropdownMenu from '@clave/ui/primitives/dropdown-menu'
import {
  ArrowDownTrayIcon,
  CheckIcon,
  ClipboardDocumentIcon,
  CodeBracketIcon,
  DocumentTextIcon,
  EllipsisHorizontalIcon,
  CommandLineIcon,
  FolderIcon
} from '@heroicons/react/24/outline'
import { isRemoteKey } from '../lib/fleet-identity'
import { useRegistry } from './store'
import { useViewSessionStore } from './session-store'
import type { AvailableView } from './resolution'
import { useTranscriptExport, type TranscriptExporter } from './transcript-export'
import { ViewDrawing } from './ViewDrawing'
import { transcriptFileName } from '../../../../plugins/chat-view/src/export'

/** What a row says on its right while it works or once it has: a copy is
 *  invisible, so the row says it happened before the menu closes. */
type RowNote = { row: string; text: string; tone?: 'done' | 'failed' }

/** How long a row's "Copied" stays in sight before the menu closes itself. */
const DONE_MS = 700

const basename = (path: string): string => path.replace(/\/+$/, '').split('/').pop() || path

/**
 * The pane header's session menu, behind the ⋯ button: how this session reads
 * (its views, as tiles drawn in the app's hand) and what can be taken out of
 * it (the whole conversation copied or saved as Markdown, Claude's raw
 * transcript, the plan, the command that resumes it in a terminal, its
 * folder). It replaced the view picker, a menu with one question in it;
 * search keeps its own button beside the title, since what it searches is
 * this session.
 */
export function SessionMenu({
  sessionId,
  views,
  active
}: {
  sessionId: string
  views: AvailableView[]
  active: string | undefined
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState<RowNote | null>(null)
  const [failure, setFailure] = useState('')
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const exporter: TranscriptExporter | undefined = useTranscriptExport(
    (s) => s.exporters[sessionId]
  )
  const record = useViewSessionStore((s) => s.sessions.find((r) => r.id === sessionId))
  const current = views.find((view) => view.id === active)
  const remote = isRemoteKey(sessionId)

  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current)
    },
    []
  )
  // A note belongs to the opening it was written in.
  const openChange = (next: boolean): void => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    setOpen(next)
    if (!next) setNote(null)
  }

  const choose = async (id: string): Promise<void> => {
    if (id === active) return
    try {
      const updated = await window.electronAPI.sessionsSetView(sessionId, id)
      // The record in main is the truth; reflect it without waiting for a
      // round trip through the plugin-change refresh.
      useRegistry.setState((state) => ({
        sessions: state.sessions.map((s) => (s.id === updated.id ? updated : s))
      }))
      setFailure('')
    } catch (error) {
      setFailure(String(error))
    }
  }

  /** Run a row's work with the menu held open, say how it went on the row,
   *  and close once a success has been seen. A failure stays until the
   *  reader closes the menu. */
  const run = (row: string, busy: string | null, work: () => Promise<string | null>) => {
    return (event: Event): void => {
      event.preventDefault()
      if (closeTimer.current) clearTimeout(closeTimer.current)
      if (busy) setNote({ row, text: busy })
      void work().then(
        (done) => {
          if (done === null) {
            setNote(null)
            return
          }
          setNote({ row, text: done, tone: 'done' })
          closeTimer.current = setTimeout(() => openChange(false), DONE_MS)
        },
        (error: unknown) => {
          console.error(`[session-menu] ${row} failed`, error)
          setNote({ row, text: 'Failed', tone: 'failed' })
        }
      )
    }
  }
  const copy = async (text: string): Promise<string> => {
    await navigator.clipboard.writeText(text)
    return 'Copied'
  }

  const title = record?.name ?? 'Session'
  const claudeId = record?.claudeSessionId ?? null
  const extras = { sessionType: record?.sessionType, locationId: record?.locationId ?? null }

  const rowNote = (row: string): React.JSX.Element | null =>
    note?.row === row ? (
      <span className="menu-hint session-menu-note" data-tone={note.tone}>
        {note.tone === 'done' && <CheckIcon className="w-3 h-3" />}
        {note.text}
      </span>
    ) : null

  return (
    <DropdownMenu.Root modal={false} open={open} onOpenChange={openChange}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="panel-icon-btn"
          aria-label="Session menu"
          title={failure || 'View and transcript'}
          // The view on screen, for the specs and assistive tech: the menu's
          // own tiles say it to the eye.
          data-view-title={current?.title ?? ''}
          data-failed={failure ? 'true' : undefined}
          data-active={open ? 'true' : undefined}
        >
          <EllipsisHorizontalIcon className="w-4 h-4" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="bottom"
          align="end"
          sideOffset={6}
          className="menu-surface menu-pop session-menu z-50 p-1"
          aria-label="Session menu"
        >
          {views.length > 1 && (
            <>
              <DropdownMenu.Label className="menu-label">View as</DropdownMenu.Label>
              <DropdownMenu.RadioGroup
                value={active ?? ''}
                onValueChange={(id) => void choose(id)}
                className="view-tiles"
                aria-label="Views"
                style={{ '--view-tiles': Math.min(views.length, 3) } as React.CSSProperties}
              >
                {views.map((view) => (
                  <DropdownMenu.RadioItem
                    key={view.id}
                    value={view.id}
                    className="view-tile"
                    data-selected={view.id === active ? 'true' : undefined}
                  >
                    <span className="view-tile-art">
                      <ViewDrawing viewId={view.id} active={view.id === active} />
                    </span>
                    <span className="view-tile-name">{view.title}</span>
                  </DropdownMenu.RadioItem>
                ))}
              </DropdownMenu.RadioGroup>
              {failure && (
                <p className="session-menu-failure" role="alert">
                  {failure}
                </p>
              )}
            </>
          )}

          {exporter && (
            <>
              {views.length > 1 && <DropdownMenu.Separator className="menu-sep" />}
              <DropdownMenu.Label className="menu-label">Transcript</DropdownMenu.Label>
              <DropdownMenu.Item
                className="menu-item"
                onSelect={run('copy-transcript', 'Reading…', async () => copy(await exporter()))}
              >
                <ClipboardDocumentIcon className="menu-glyph" />
                <span className="flex-1 truncate">Copy as Markdown</span>
                {rowNote('copy-transcript')}
              </DropdownMenu.Item>
              <DropdownMenu.Item
                className="menu-item"
                onSelect={run('save-transcript', 'Reading…', async () => {
                  const markdown = await exporter()
                  const saved = await window.electronAPI.saveTranscript(
                    markdown,
                    transcriptFileName(title, new Date())
                  )
                  if (saved.error === 'cancelled') return null
                  if (!saved.success) throw new Error(saved.error ?? 'not saved')
                  return 'Saved'
                })}
              >
                <ArrowDownTrayIcon className="menu-glyph" />
                <span className="flex-1 truncate">Save as Markdown…</span>
                {rowNote('save-transcript')}
              </DropdownMenu.Item>
              {!remote && claudeId && record && (
                <DropdownMenu.Item
                  className="menu-item"
                  onSelect={run('save-raw', null, async () => {
                    const saved = await window.electronAPI.saveDiscussion(
                      record.cwd,
                      claudeId,
                      title,
                      extras
                    )
                    if (saved.error === 'cancelled' || !saved.success) return null
                    return 'Saved'
                  })}
                >
                  <CodeBracketIcon className="menu-glyph" />
                  <span className="flex-1 truncate">Save raw transcript…</span>
                  {rowNote('save-raw') ?? <span className="menu-hint">.jsonl</span>}
                </DropdownMenu.Item>
              )}
              {!remote && claudeId && record?.planFilePath && (
                <DropdownMenu.Item
                  className="menu-item"
                  onSelect={run('save-plan', null, async () => {
                    const saved = await window.electronAPI.savePlan(
                      record.cwd,
                      claudeId,
                      title,
                      extras
                    )
                    if (saved.error === 'cancelled' || !saved.success) return null
                    return 'Saved'
                  })}
                >
                  <DocumentTextIcon className="menu-glyph" />
                  <span className="flex-1 truncate">Save plan…</span>
                  {rowNote('save-plan')}
                </DropdownMenu.Item>
              )}
            </>
          )}

          {record && (
            <>
              {(views.length > 1 || exporter !== undefined) && (
                <DropdownMenu.Separator className="menu-sep" />
              )}
              <DropdownMenu.Label className="menu-label">Session</DropdownMenu.Label>
              {claudeId && (
                <DropdownMenu.Item
                  className="menu-item"
                  onSelect={run('copy-resume', null, () => copy(`claude --resume ${claudeId}`))}
                >
                  <CommandLineIcon className="menu-glyph" />
                  <span className="flex-1 truncate">Copy resume command</span>
                  {rowNote('copy-resume') ?? (
                    <span className="menu-hint font-mono">{claudeId.slice(0, 8)}</span>
                  )}
                </DropdownMenu.Item>
              )}
              <DropdownMenu.Item
                className="menu-item"
                onSelect={run('copy-folder', null, () => copy(record.cwd))}
              >
                <FolderIcon className="menu-glyph" />
                <span className="flex-1 truncate">Copy folder path</span>
                {rowNote('copy-folder') ?? (
                  <span className="menu-hint truncate">{basename(record.cwd)}</span>
                )}
              </DropdownMenu.Item>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
