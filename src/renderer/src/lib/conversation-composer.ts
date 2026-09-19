export interface Submission {
  text: string
  commandId: string
  revision: number
}

interface ComposerState {
  text: string
  revision: number
  sending: boolean
  submission?: Submission
  localOnly?: boolean
}

type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const PREFIX = 'clave-conversation-draft:'
const EMPTY: ComposerState = { text: '', revision: 0, sending: false }
export const MAX_PROMPT_BYTES = 128 * 1024

/** One draft per session, separate from the lifetime of any conversation view. */
export class ConversationComposer {
  private states = new Map<string, ComposerState>()
  private listeners = new Set<() => void>()
  private unsaved = new Set<string>()
  private history = new Map<string, { messages: string[]; index: number; revision: number }>()
  constructor(private storage?: DraftStorage) {}

  read(id: string): ComposerState {
    const existing = this.states.get(id)
    if (existing) return existing
    const state = this.load(id, EMPTY)
    this.states.set(id, state)
    return state
  }

  private load(id: string, fallback: ComposerState): ComposerState {
    if (!this.storage || this.unsaved.has(id)) return fallback
    let state = EMPTY
    try {
      const raw = JSON.parse(this.storage?.getItem(PREFIX + id) ?? 'null')
      if (raw && typeof raw.text === 'string' && raw.text.length <= MAX_PROMPT_BYTES) {
        const revision = Number.isSafeInteger(raw.revision) ? raw.revision : 0
        const pending = raw.submission
        const submission: Submission | undefined =
          pending &&
          typeof pending.text === 'string' &&
          pending.text.length <= MAX_PROMPT_BYTES &&
          typeof pending.commandId === 'string' &&
          pending.commandId.length <= 128
            ? {
                text: pending.text,
                commandId: pending.commandId,
                revision: Number.isSafeInteger(pending.revision) ? pending.revision : revision
              }
            : undefined
        state = { text: raw.text, revision, submission, sending: false }
      }
    } catch {
      /* Invalid/stale browser data is not a send command. */
      return fallback
    }
    return state
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private publish(id: string, state: ComposerState): void {
    let localOnly = !this.storage
    try {
      if (!state.text && !state.submission) this.storage?.removeItem(PREFIX + id)
      else this.storage?.setItem(PREFIX + id, JSON.stringify(state))
      this.unsaved.delete(id)
    } catch {
      /* Keep the in-memory draft if browser storage is unavailable. */
      this.unsaved.add(id)
      localOnly = true
    }
    this.states.set(id, { ...state, localOnly })
    for (const listener of this.listeners) listener()
  }

  edit(id: string, text: string): void {
    this.history.delete(id)
    const state = this.read(id)
    this.publish(id, {
      ...state,
      text,
      revision: state.revision + 1,
      submission: !text && !state.sending ? undefined : state.submission
    })
  }

  /** Recall only accepted transcript messages, never pending submissions or another session. */
  recall(id: string, direction: 'older' | 'newer', messages: string[]): boolean {
    const state = this.read(id)
    if (state.sending || state.submission) return false
    let history = this.history.get(id)
    if (history?.revision !== state.revision) history = undefined
    if (!history) {
      if (state.text !== '' || direction !== 'older' || !messages.length) return false
      history = { messages: [...messages], index: messages.length, revision: state.revision }
    }
    const index = Math.max(
      0,
      Math.min(history.messages.length, history.index + (direction === 'older' ? -1 : 1))
    )
    if (index === history.index) return false
    this.edit(id, history.messages[index] ?? '')
    if (index < history.messages.length)
      this.history.set(id, { ...history, index, revision: this.read(id).revision })
    return true
  }

  begin(id: string): Submission | null {
    const state = this.read(id)
    if (state.sending || !state.text.trim()) return null
    this.history.delete(id)
    const submission: Submission = {
      text: state.text,
      commandId:
        state.submission?.text === state.text ? state.submission.commandId : crypto.randomUUID(),
      revision: state.revision
    }
    this.publish(id, { ...state, submission, sending: true })
    return submission
  }

  accept(id: string, commandId: string): void {
    this.settle(id, commandId, true)
  }

  fail(id: string, commandId: string): void {
    this.settle(id, commandId, false)
  }

  private settle(id: string, commandId: string, accepted: boolean): void {
    const state = this.read(id)
    if (state.submission?.commandId !== commandId) return
    // The tab may have moved while this window waited for its ACK. Read the
    // shared draft before writing; never publish this window's stale copy over
    // a draft or a different submission made by the new home window.
    const latest = this.load(id, state)
    if (latest.submission?.commandId !== commandId) {
      this.states.set(id, latest)
      for (const listener of this.listeners) listener()
      return
    }
    this.publish(id, {
      ...latest,
      text:
        accepted &&
        latest.revision === state.submission.revision &&
        latest.text === state.submission.text
          ? ''
          : latest.text,
      sending: false,
      submission: accepted || !latest.text ? undefined : latest.submission
    })
  }

  clear(id: string): void {
    this.history.delete(id)
    this.publish(id, EMPTY)
  }

  /** A moved tab can pick up the draft written by its previous window. */
  storageChanged(key: string | null): void {
    if (!key?.startsWith(PREFIX)) return
    const id = key.slice(PREFIX.length)
    if (this.states.get(id)?.sending || this.unsaved.has(id)) return
    this.history.delete(id)
    this.states.delete(id)
    for (const listener of this.listeners) listener()
  }
}

export function shouldSendOnEnter(event: {
  key: string
  shiftKey?: boolean
  altKey?: boolean
  isComposing?: boolean
}): boolean {
  return event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.isComposing
}

export function isNearLatest(metrics: {
  scrollHeight: number
  scrollTop: number
  clientHeight: number
}): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= 48
}

let storage: DraftStorage | undefined
try {
  if (typeof window !== 'undefined') storage = window.localStorage
} catch {
  /* Private mode. */
}
export const conversationComposer = new ConversationComposer(storage)
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => conversationComposer.storageChanged(event.key))
}
