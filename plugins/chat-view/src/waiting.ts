import { useEffect, useRef, type SetStateAction } from 'react'
import type { Attachment } from '../../../src/shared/attachments'
import type { SessionEvent, WaitingMessage } from '../../../src/shared/session-model'
import { useDraftStore } from '../../../src/renderer/src/views/draft-store'
import type { Entry } from './reducer'

/* The messages that wait for the agent (PRDCT-4566): written while it works,
   not yet taken. An OpenCode chat takes one once the running turn has ended,
   a Pi chat at its next step; until then a message waits in the stack above
   the composer (WaitingStack.tsx), outside the conversation, so each answer
   is drawn under the message it answers. */

export type WaitingTakes = Extract<SessionEvent, { type: 'waiting_messages' }>['takes']
export type WaitingReturn = NonNullable<
  Extract<SessionEvent, { type: 'waiting_messages' }>['returned']
>

/** The texts of messages that come back, as the composer takes them: in the
 *  order written, a blank line between them. */
export const returnedText = (messages: readonly WaitingMessage[]): string =>
  messages
    .map((m) => m.text.replace(/\s+$/, ''))
    .filter((text) => text.trim() !== '')
    .join('\n\n')

/** What the composer holds once messages come back to it. One the person
 *  withdrew comes back only into an empty composer, and is dropped otherwise
 *  (the take-back's own rule, ChatView `takeBack`). The ones a stop, an end
 *  or a refusal hands back always come back, after what the composer holds,
 *  so none of them is lost; never twice, since every view of the session
 *  writes the one draft. */
export function draftWithReturned(current: string, returned: WaitingReturn): string {
  const back = returnedText(returned.messages)
  if (!back) return current
  if (!current.trim()) return back
  if (returned.why === 'withdrawn' || current.includes(back)) return current
  return `${current.replace(/\s+$/, '')}\n\n${back}`
}

/** The files the composer takes back with the texts: a withdrawn message's
 *  only when its text is now the composer's whole draft and the composer
 *  holds no file (it came back into an empty composer), the others' always,
 *  each once. */
export function filesWithReturned(
  files: readonly Attachment[],
  draft: string,
  returned: WaitingReturn
): Attachment[] | null {
  const back = returned.messages.flatMap((m) => m.attachments ?? [])
  if (!back.length) return null
  if (returned.why === 'withdrawn')
    return draft === returnedText(returned.messages) && !files.length ? back : null
  const held = new Set(files.map((file) => file.id))
  const added = back.filter((file) => !held.has(file.id))
  return added.length ? [...files, ...added] : null
}

/** The message the running turn started on, the last one in the
 *  conversation: what Escape hands back before any answer, when messages
 *  wait behind it (the last one sent waits in the stack, and comes back with
 *  the others). */
export function startedTurn(entries: readonly Entry[]): {
  text: string
  attachments: Attachment[]
} | null {
  const last = entries.findLast((e) => e.kind === 'user')
  return last?.kind === 'user' ? { text: last.text, attachments: last.attachments ?? [] } : null
}

/** When a waiting message goes, in a few words. */
export function takesLine(takes: WaitingTakes | null, agent: string): string {
  return takes === 'step' ? `${agent} takes it at its next step` : 'Sent when this turn ends'
}

/** Messages handed back go into the composer, once per return: a view's own
 *  reducer holds the latest return as a new value each time. */
export function useWaitingReturns(
  sessionId: string,
  returned: WaitingReturn | null,
  setDraft: (value: SetStateAction<string>) => void,
  attachments: Attachment[],
  restore: (files: Attachment[]) => void
): void {
  // The composer's files as this render holds them, for the return below
  // (declared first, so it runs first in the same commit).
  const files = useRef(attachments)
  useEffect(() => {
    files.current = attachments
  })
  useEffect(() => {
    if (!returned) return
    setDraft((current) => draftWithReturned(current, returned))
    const draft = useDraftStore.getState().drafts[sessionId] ?? ''
    const next = filesWithReturned(files.current, draft, returned)
    if (next) restore(next)
  }, [returned, sessionId, setDraft, restore])
}
