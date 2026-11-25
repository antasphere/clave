import { readStatusCard, statusCardLines, statusNeedsYou } from './status-card'

/** The events the lines are drawn from, as either copy of the session model
 *  spells them (the renderer's zod one, the wire's Effect one): a loose
 *  shape, read field by field, so a page from a server and a page from this
 *  Mac are both taken. */
export interface ReadableEvent {
  readonly type: string
  readonly text?: string
  readonly delta?: string
  readonly final?: boolean
  readonly name?: string
  readonly message?: string
  /** A notice that reports no failure (PRDCT-4566). */
  readonly quiet?: boolean
  readonly description?: string
  readonly parent?: string
  readonly attachments?: ReadonlyArray<unknown>
}

/** The status a chat's agent ended its last turn on (PRDCT-5166), as
 *  `clave_read_session` gives it beside the lines: the card's fields, whether
 *  it asks something of the person, and whether the person has written since,
 *  which makes it history. */
export interface HistoryStatus {
  doing: string | null
  where: string | null
  decide: string[]
  next: string | null
  /** Whether it asks something of the person: `statusNeedsYou`. */
  needsYou: boolean
  /** Whether the person has written since: the status is then history. */
  answered: boolean
}

/** A chat's history read once: its lines, and the status of its last agent
 *  message of the main thread, null when that message ended on none. */
export interface HistoryReading {
  lines: string[]
  status: HistoryStatus | null
}

/**
 * A chat's recent history as lines an agent can read (PRDCT-4199): what
 * `clave_read_session` answers for a tab that has no terminal screen, on the
 * desktop and on the daemon alike. One line per thing said or done, the
 * reader's messages marked `You:`, the agent's answers `Agent:` (one line
 * per turn, the deltas joined), a tool call by its name, an error by its
 * message (`Error:`), a quiet notice, which reports no failure, by its words
 * alone (PRDCT-4566); the provider's own frames, the state changes and the
 * meta stay out. The items come oldest first, as the history page gives them.
 *
 * An answer that ends on a status card (PRDCT-5166) is written without the
 * raw block: its words on the `Agent:` line, then the card as plain lines
 * indented under it, so an agent reading the text alone still learns what is
 * owed. A block anywhere else is not a card and stays as written.
 */
export function readHistory(
  items: ReadonlyArray<{ readonly event: ReadableEvent }>
): HistoryReading {
  const lines: string[] = []
  // Held in an object: the closure below writes it, which narrowing does not follow.
  const last: { status: HistoryStatus | null } = { status: null }
  let answer: string | null = null
  const closeAnswer = (): void => {
    const written = answer?.trim() ?? ''
    answer = null
    if (written === '') return
    const { body, card } = readStatusCard(written)
    lines.push(body ? `Agent: ${body}` : 'Agent:')
    if (card) for (const line of statusCardLines(card)) lines.push(`  ${line}`)
    // The last agent message decides: one that ended on no card leaves none.
    last.status = card ? { ...card, needsYou: statusNeedsYou(card), answered: false } : null
  }
  for (const { event } of items) {
    if (event.parent) continue
    switch (event.type) {
      case 'user_message':
        closeAnswer()
        if (last.status) last.status.answered = true
        lines.push(
          `You: ${event.text?.trim() ? event.text : `[${event.attachments?.length ?? 0} attachment${(event.attachments?.length ?? 0) === 1 ? '' : 's'}]`}`
        )
        break
      case 'assistant_text':
        answer = (answer ?? '') + (event.delta ?? '')
        if (event.final) closeAnswer()
        break
      case 'tool_call':
        closeAnswer()
        lines.push(`Tool: ${event.name ?? 'tool'}`)
        break
      case 'error':
        closeAnswer()
        lines.push(event.quiet ? (event.message ?? '') : `Error: ${event.message ?? ''}`)
        break
      case 'permission_request':
        closeAnswer()
        lines.push(`Asked: ${event.description ?? ''}`)
        break
      default:
        break
    }
  }
  closeAnswer()
  return { lines, status: last.status }
}

/** The lines of `readHistory` alone. */
export function historyLines(items: ReadonlyArray<{ readonly event: ReadableEvent }>): string[] {
  return readHistory(items).lines
}
