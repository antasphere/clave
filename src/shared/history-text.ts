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
  readonly description?: string
  readonly parent?: string
}

/**
 * A chat's recent history as lines an agent can read (PRDCT-4199): what
 * `clave_read_session` answers for a tab that has no terminal screen, on the
 * desktop and on the daemon alike. One line per thing said or done, the
 * reader's messages marked `You:`, the agent's answers `Agent:` (one line
 * per turn, the deltas joined), a tool call by its name, an error by its
 * message; the provider's own frames, the state changes and the meta stay
 * out. The items come oldest first, as the history page gives them.
 */
export function historyLines(items: ReadonlyArray<{ readonly event: ReadableEvent }>): string[] {
  const lines: string[] = []
  let answer: string | null = null
  const closeAnswer = (): void => {
    if (answer !== null && answer.trim() !== '') lines.push(`Agent: ${answer.trim()}`)
    answer = null
  }
  for (const { event } of items) {
    if (event.parent) continue
    switch (event.type) {
      case 'user_message':
        closeAnswer()
        lines.push(`You: ${event.text ?? ''}`)
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
        lines.push(`Error: ${event.message ?? ''}`)
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
  return lines
}
