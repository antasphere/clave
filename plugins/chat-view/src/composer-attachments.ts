import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
  type SetStateAction
} from 'react'
import {
  attachmentKind,
  insertMarker,
  markerOf,
  MAX_ATTACHMENTS,
  MAX_IMAGE_BYTES,
  nextLabel,
  reconcileAttachments,
  removeMarker,
  type Attachment,
  type AttachmentSource,
  type SessionAttachment
} from '../../../src/shared/attachments'
import { onSessionsDrag } from '../../../src/renderer/src/lib/session-drag'
import { failureText, pathForMessage } from '../../../src/renderer/src/lib/dropped-paths'
import { useViewSessionStore } from '../../../src/renderer/src/views/session-store'
import type { Session } from '../../../src/renderer/src/store/session-types'

/* The composer's attachments, shared by the chat and terminal views: the
   records, the files still being prepared, and the two things that keep the
   message text and the chips one thing. Each record is labelled as it
   arrives (`Image #1`, `File #2`, `Session #1`) and written into the text as
   a marker at the caret; a chip removed takes its marker out of the text, and
   a marker edited out of the text takes its chip with it. */

/** A file on its way into the composer: named at once, a chip once main has
 *  prepared it, an error in its place when main refused it. */
export interface Preparation {
  id: string
  name: string
  error?: string
}

/** Where typing continues after `marker` in `text`: past it and past the one
 *  space that follows it; the end of the text when it is not there. */
function caretAfter(text: string, marker: string): number {
  const index = text.indexOf(marker)
  if (index === -1) return text.length
  const end = index + marker.length
  return text[end] === ' ' ? end + 1 : end
}

/** The agent in a tab, in the reader's words, for the record the agent reads. */
export function agentLabel(session: Session): string {
  if (session.sessionType === 'agent') return 'Remote agent'
  if (session.antigravityMode) return 'Antigravity'
  if (session.codexMode) return 'Codex'
  if (session.piMode) return 'Pi'
  if (session.claudeMode || session.claudeAgentsMode) return 'Claude Code'
  return 'Terminal'
}

export function useComposerAttachments(opts: {
  sessionId: string
  closed: boolean
  setDraft: (value: SetStateAction<string>) => void
  textarea: RefObject<HTMLTextAreaElement | null>
  /** The pane's root: where a sidebar tab is dropped. */
  pane: RefObject<HTMLElement | null>
  report: (error: unknown) => void
}): {
  attachments: Attachment[]
  preparations: Preparation[]
  /** A sidebar drag hovering the pane, for the overlay. */
  sessionsOver: boolean
  /** Files from a drop, a paste or the picker. */
  addFiles: (sources: (File | string)[]) => Promise<void>
  /** Text into the draft at the caret, the caret moved past it: a folder's
   *  path, the paths a panel drags as text. */
  insertAtCaret: (insert: string) => void
  /** Sidebar tabs dropped on the pane. */
  addSessions: (sessionIds: string[]) => void
  /** A preparation the reader removed before main answered. */
  withdraw: (key: string) => void
  /** The chips' change: a removed record takes its marker out of the text. */
  changeAttachments: (next: Attachment[]) => void
  /** The text as typed: a marker gone from it takes its record with it. */
  onDraftChange: (text: string) => void
  /** The composer sent `files`: they leave, unless the reader changed them since. */
  clearSent: (files: Attachment[]) => void
  /** A message taken back: its records return with its text. */
  restore: (files: Attachment[]) => void
} {
  const { sessionId, closed, setDraft, textarea, pane, report } = opts
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [preparations, setPreparations] = useState<Preparation[]>([])
  const [sessionsOver, setSessionsOver] = useState(false)
  // The records as of the last change, readable between renders: labels are
  // numbered from it, so two files prepared in the same tick get two numbers.
  const latest = useRef<Attachment[]>([])
  const commit = useCallback((next: Attachment[]): void => {
    latest.current = next
    setAttachments(next)
  }, [])
  // Preparations the reader removed before main answered; their file is dropped on arrival.
  const withdrawn = useRef(new Set<string>())
  // The marker last inserted, while it may not have reached the textarea
  // yet (several files of one pick land in one tick): the next one goes right
  // after it, never on top of it. Typing clears it: the caret rules again.
  const pendingMarker = useRef<string | null>(null)

  /** Label a record, add it, and write its marker into the text at the caret. */
  const attach = useCallback(
    (record: Attachment): void => {
      const label = nextLabel(attachmentKind(record), latest.current)
      const labelled = { ...record, label }
      commit([...latest.current, labelled])
      const marker = markerOf(labelled)!
      const previous = pendingMarker.current
      const el = textarea.current
      const focusedAt = el && document.activeElement === el ? el.selectionStart : null
      // Pure in the text it is given, so React may run it twice.
      setDraft((current) => {
        const at =
          previous && current.includes(previous)
            ? caretAfter(current, previous)
            : (focusedAt ?? current.length)
        return insertMarker(current, marker, at).text
      })
      pendingMarker.current = marker
      requestAnimationFrame(() => {
        if (!el) return
        el.focus({ preventScroll: true })
        const caret = caretAfter(el.value, marker)
        el.setSelectionRange(caret, caret)
        if (pendingMarker.current === marker) pendingMarker.current = null
      })
    },
    [commit, setDraft, textarea]
  )

  /** Text into the draft at the caret, the caret moved past it. Pure in the
   *  text it is given, like the marker insertion, so React may run it twice. */
  const insertAtCaret = useCallback(
    (insert: string): void => {
      const el = textarea.current
      const start = el?.selectionStart ?? Number.MAX_SAFE_INTEGER
      const end = el?.selectionEnd ?? start
      setDraft((current) => {
        const from = Math.min(start, current.length)
        const to = Math.min(Math.max(end, from), current.length)
        return current.slice(0, from) + insert + current.slice(to)
      })
      requestAnimationFrame(() => {
        if (!el) return
        el.focus({ preventScroll: true })
        const caret = Math.min(start, el.value.length - insert.length) + insert.length
        el.setSelectionRange(caret, caret)
      })
    },
    [setDraft, textarea]
  )

  /* Files into the composer, from a drop, a paste or the picker. Each is
     named at once as a chip in preparation, then handed to main to validate,
     copy out of a temp folder if it lives in one, and type; the record main
     returns becomes the attachment. A file the renderer holds only as bytes
     (a pasted screenshot has no path) is sent as bytes and written by main.
     What main refuses that arrived as a path — a folder from an app that
     names no entry, a socket, a file it cannot read — lands in the text as
     that path, the reason reported beside it: a drop never fails, it has a
     worst case. Bytes with no path keep the error on their chip. */
  const addFiles = async (sources: (File | string)[]): Promise<void> => {
    if (closed) return
    const queued: { source: File | string; key: string; name: string; path: string }[] = []
    let room = MAX_ATTACHMENTS - latest.current.length - preparations.length
    for (const source of sources) {
      if (room-- <= 0) {
        report(`Attach up to ${MAX_ATTACHMENTS} files per message.`)
        break
      }
      const path = typeof source === 'string' ? source : window.electronAPI.getPathForFile(source)
      const name =
        (typeof source === 'string' ? source.split(/[\\/]/).pop() : source.name) || 'Pasted image'
      queued.push({ source, key: crypto.randomUUID(), name, path })
      setPreparations((current) => [...current, { id: queued.at(-1)!.key, name }])
    }
    for (const { source, key, name, path } of queued) {
      if (withdrawn.current.has(key)) continue
      try {
        let value: AttachmentSource
        if (typeof source === 'string') value = { path: source }
        else if (path) value = { path }
        else {
          if (source.size > MAX_IMAGE_BYTES)
            throw new Error('Pasted images must be 5 MiB or smaller.')
          value = {
            name: source.name || 'Pasted image.png',
            bytes: new Uint8Array(await source.arrayBuffer())
          }
        }
        const file = await window.electronAPI.sessionsFiles.prepare(sessionId, value)
        if (withdrawn.current.has(key)) continue
        if (!latest.current.some((f) => f.delivery !== 'session' && f.path === file.path))
          attach(file)
        setPreparations((current) => current.filter((p) => p.id !== key))
      } catch (failure) {
        if (withdrawn.current.has(key)) continue
        if (path) {
          setPreparations((current) => current.filter((p) => p.id !== key))
          insertAtCaret(pathForMessage(path) + ' ')
          report(`${failureText(failure)} ${name} is in the message as a path.`)
        } else
          setPreparations((current) =>
            current.map((p) => (p.id === key ? { ...p, error: failureText(failure) } : p))
          )
      }
    }
    for (const { key } of queued) withdrawn.current.delete(key)
    textarea.current?.focus({ preventScroll: true })
  }

  /* Sidebar tabs dropped on the pane: each becomes a session record the agent
     can act on, named as the sidebar names it. A tab already attached is not
     attached twice; the cap counts sessions and files together. */
  const addSessions = useCallback(
    (sessionIds: string[]): void => {
      if (closed) return
      const sessions = useViewSessionStore.getState().sessions
      for (const id of sessionIds) {
        if (latest.current.some((f) => f.delivery === 'session' && f.sessionId === id)) continue
        const session = sessions.find((s) => s.id === id)
        if (!session) continue
        if (latest.current.length + preparations.length >= MAX_ATTACHMENTS) {
          report(`Attach up to ${MAX_ATTACHMENTS} files per message.`)
          break
        }
        const record: SessionAttachment = {
          id: crypto.randomUUID(),
          delivery: 'session',
          sessionId: id,
          name: session.name || session.folderName || id,
          agent: agentLabel(session),
          cwd: session.cwd
        }
        attach(record)
      }
    },
    [attach, closed, preparations.length, report]
  )

  const withdraw = (key: string): void => {
    withdrawn.current.add(key)
    setPreparations((current) => current.filter((p) => p.id !== key))
  }

  const changeAttachments = (next: Attachment[]): void => {
    const kept = new Set(next.map((f) => f.id))
    const removed = latest.current.filter((f) => !kept.has(f.id))
    commit(next)
    if (!removed.length) return
    setDraft((current) =>
      removed.reduce((text, file) => {
        const marker = markerOf(file)
        return marker ? removeMarker(text, marker) : text
      }, current)
    )
  }

  const onDraftChange = (text: string): void => {
    pendingMarker.current = null
    setDraft(text)
    const kept = reconcileAttachments(text, latest.current)
    if (kept.length !== latest.current.length) commit(kept)
  }

  const clearSent = (files: Attachment[]): void => {
    if (latest.current === files) commit([])
  }

  // The pane takes sidebar tabs for as long as it is mounted.
  useEffect(() => {
    const root = pane.current
    if (!root) return
    return onSessionsDrag(root, { onHover: setSessionsOver, onDrop: addSessions })
  }, [pane, addSessions])

  return {
    attachments,
    preparations,
    sessionsOver,
    addFiles,
    insertAtCaret,
    addSessions,
    withdraw,
    changeAttachments,
    onDraftChange,
    clearSent,
    restore: commit
  }
}
