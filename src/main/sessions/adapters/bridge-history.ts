/**
 * The session bridge's readers are Clave's transcript readers (PRDCT-4301):
 * `@clave/session-bridge` reads a Claude Code transcript and a Codex rollout
 * into one representation, and the two adapters replay a resumed
 * conversation through it. The bridge's events were copied from Clave's
 * session model field for field, so this translation is a type boundary and
 * two rules the chat's replay keeps for itself:
 *
 * - the window a Claude model reads, from Clave's own table when the bridge
 *   (which knows only the `[1m]` suffix) left it unknown;
 * - the CLI's own rows, which Claude Code writes as user messages with no
 *   `isMeta` mark (`<local-command-stdout>`, a `<task-notification>`), kept
 *   out of the bubbles by their EXACT tag. Every other text the person's rows
 *   hold stays, a message that opens with `<` or with `Caveat:` included: the
 *   old rule dropped those by their first character, and the next answer
 *   merged into the turn before on replay (lane C's verifier, round 1).
 */
import type {
  HistoryItem as BridgeHistoryItem,
  SessionEvent as BridgeEvent
} from '@clave/session-bridge/ir'
import type { HistoryItem, SessionEvent } from '../../../shared/session-model'
import { claudeContextWindow } from '../../../shared/claude-models'

/** The tags of the rows Claude Code writes itself into a conversation, as the
 *  person's turn and without an `isMeta` mark: the output of a slash command
 *  the person ran, the caveat on it, a background task's notification, and a
 *  reminder injected without the mark. A row opening with one of these is the
 *  CLI's, never the person's words. */
export const CLI_WRAPPER_TAGS: readonly string[] = [
  '<local-command-stdout>',
  '<local-command-stderr>',
  '<local-command-caveat>',
  '<command-name>',
  '<task-notification>',
  '<system-reminder>'
]

/** Whether a text is one of the CLI's own rows, by its exact opening tag. */
export function isCliWrapper(text: string): boolean {
  const head = text.trimStart()
  return CLI_WRAPPER_TAGS.some((tag) => head.startsWith(tag))
}

export interface TranslateOptions {
  /** `drop` leaves out the user messages that are the CLI's own rows
   *  (`isCliWrapper`); `keep` (the default) carries every message. The Codex
   *  reader filters its own injected rows, so only the Claude road drops. */
  wrappers?: 'keep' | 'drop'
}

/** One bridge event as Clave's session model speaks it. `null` for an event
 *  the chat leaves out. */
function translate(event: BridgeEvent, options: TranslateOptions): SessionEvent | null {
  switch (event.type) {
    case 'user_message':
      if (options.wrappers === 'drop' && isCliWrapper(event.text)) return null
      return {
        type: 'user_message',
        text: event.text,
        ...(event.form !== undefined ? { form: event.form } : {}),
        ...(event.parent !== undefined ? { parent: event.parent } : {})
      }
    case 'assistant_text':
      return {
        type: 'assistant_text',
        delta: event.delta,
        final: event.final,
        ...(event.parent !== undefined ? { parent: event.parent } : {})
      }
    case 'tool_call':
      return {
        type: 'tool_call',
        id: event.id,
        name: event.name,
        input: event.input,
        ...(event.parent !== undefined ? { parent: event.parent } : {})
      }
    case 'tool_result':
      return {
        type: 'tool_result',
        id: event.id,
        output: event.output,
        ...(event.error !== undefined ? { error: event.error } : {}),
        ...(event.parent !== undefined ? { parent: event.parent } : {})
      }
    case 'context_usage':
      return {
        type: 'context_usage',
        used: event.used,
        // The bridge knows a window off the `[1m]` suffix alone; Clave's table
        // names the rest ("claude-opus-5-5" reads a million), as the live
        // translator does for a turn's result.
        window: event.window ?? claudeContextWindow(event.model ?? null),
        ...(event.parent !== undefined ? { parent: event.parent } : {})
      }
    case 'turn_interrupted':
      return { type: 'turn_interrupted' }
    case 'session_meta':
      return {
        type: 'session_meta',
        model: event.model,
        providerSessionId: event.providerSessionId
      }
  }
}

/** The bridge's replay as the history a view pages through. */
export function toHistoryItems(
  items: readonly BridgeHistoryItem[],
  options: TranslateOptions = {}
): HistoryItem[] {
  const out: HistoryItem[] = []
  for (const item of items) {
    const event = translate(item.event, options)
    if (!event) continue
    out.push(item.at !== undefined ? { event, at: item.at } : { event })
  }
  return out
}
