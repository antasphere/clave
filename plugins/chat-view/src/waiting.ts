import { useEffect, useRef, type SetStateAction } from 'react'
import type { Attachment } from '../../../src/shared/attachments'
import type { SessionEvent, WaitingMessage } from '../../../src/shared/session-model'
import { parseDelivery } from '../../../src/shared/exchange-provenance'
import { useDraftStore } from '../../../src/renderer/src/views/draft-store'
import { answeredSince, type Entry } from './reducer'

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
 *  order written, a blank line between them. Another tab's message is never
 *  the person's to edit: the adapter drops it with a line naming its tab, and
 *  the composer would not take one anyway. */
export const returnedText = (messages: readonly WaitingMessage[]): string =>
  messages
    .filter((m) => !parseDelivery(m.text))
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

/** A message the person sent, as the composer takes it back. */
export interface SentMessage {
  text: string
  attachments: Attachment[]
}

/** The message the running turn started on, the last one in the
 *  conversation: what Escape hands back before any answer, when messages
 *  wait behind it (the last one sent waits in the stack, and comes back with
 *  the others). Null when it is another tab's: never the person's to take
 *  back. */
export function startedTurn(entries: readonly Entry[]): SentMessage | null {
  const last = entries.findLast((e) => e.kind === 'user')
  if (last?.kind !== 'user' || parseDelivery(last.text)) return null
  return { text: last.text, attachments: last.attachments ?? [] }
}

/** What Escape takes back while the agent works (every view's `takeBack`):
 *  nothing once an answer has begun; before it, the turn's message leaves
 *  the conversation (`withdraw`) and `message` goes back into the composer.
 *  With messages waiting (PRDCT-4566) that is the message the turn started
 *  on, never the last one sent, which waits and comes back with the others,
 *  so no text comes back twice; and another tab's message stays where it is,
 *  never taken back. With none waiting, the view's last message sent, as
 *  before. */
export function takenBack(
  entries: Entry[],
  waiting: boolean,
  lastSent: SentMessage | null
): { withdraw: boolean; message: SentMessage | null } {
  if (answeredSince(entries)) return { withdraw: false, message: null }
  if (!waiting) return { withdraw: true, message: lastSent }
  const message = startedTurn(entries)
  return { withdraw: !!message, message }
}

/** Whether a draft goes with the send button while the agent works, as with
 *  Enter (every view's `showInterrupt`): a Codex chat steers it into the
 *  running turn, an OpenCode or a Pi chat holds it in the stack until the
 *  agent takes it (PRDCT-4566). With an empty composer the button stays the
 *  stop, and Escape stops in any chat. */
export const sendsWhileWorking = (provider: string): boolean =>
  provider === 'codex' || provider === 'opencode' || provider === 'pi'

/** The stack's count line: how many messages wait. */
export const waitingCount = (n: number): string =>
  `${n} ${n === 1 ? 'message' : 'messages'} waiting`

/** When a waiting message goes, in a few words. */
export function takesLine(takes: WaitingTakes | null, agent: string): string {
  return takes === 'step' ? `${agent} takes it at its next step` : 'Sent when this turn ends'
}

/** Messages handed back go into the composer, once per return: a view's own
 *  reducer holds the latest return as a new value each time. The words go
 *  into the session's one draft, which every view of it writes the same way.
 *  The files go to the view on screen alone (`visible`): each view keeps its
 *  own, and a hidden one would show them again later, after the person had
 *  dealt with them where they were. */
export function useWaitingReturns(
  sessionId: string,
  returned: WaitingReturn | null,
  setDraft: (value: SetStateAction<string>) => void,
  attachments: Attachment[],
  restore: (files: Attachment[]) => void,
  visible: boolean
): void {
  // The composer's files and whether the view is on screen, as this render
  // holds them, for the return below (declared first, so it runs first in
  // the same commit).
  const files = useRef(attachments)
  const shown = useRef(visible)
  useEffect(() => {
    files.current = attachments
    shown.current = visible
  })
  useEffect(() => {
    if (!returned) return
    setDraft((current) => draftWithReturned(current, returned))
    if (!shown.current) return
    const draft = useDraftStore.getState().drafts[sessionId] ?? ''
    const next = filesWithReturned(files.current, draft, returned)
    if (next) restore(next)
  }, [returned, sessionId, setDraft, restore])
}
