import type { HistoryItem, SessionEvent } from '../../../../packages/shared/src/session-model'
import { emptyConversation, reduceConversation, type Conversation } from './reducer'

/* What each subagent said and did, read off the same session stream the
   transcript is: every message, text, call and result an adapter stamps
   with a `parent` is that agent's own (Claude names the call that started
   it, Codex the agent's thread) and reduces into a conversation of its own,
   with the transcript's reducer, so the view of an agent reads exactly as
   the transcript would. The key is the one the status stack's row carries
   (`SubAgent.id`: the call, else the task), which is how a row finds its log.

   A subagent's log is never the transcript's: `reduceConversation` drops a
   parented event, so the hundred calls of an agent at work no longer count
   into the run the conversation is on. */

export type SubagentLogs = Readonly<Record<string, Conversation>>
export const noSubagents: SubagentLogs = {}

/** How many agents' logs the view keeps; the oldest goes once more have
 *  spoken. A wave's coordinator launches a handful; a long session more. */
const KEPT = 24

/** The call that started the agent whose event this is, if any. */
export function parentOf(event: SessionEvent): string | undefined {
  return 'parent' in event && typeof event.parent === 'string' && event.parent
    ? event.parent
    : undefined
}

export function reduceSubagents(
  logs: SubagentLogs,
  event: SessionEvent,
  at: number = Date.now()
): SubagentLogs {
  const parent = parentOf(event)
  if (!parent) return logs
  // The agent's context and model are the row's, not its log's.
  if (event.type === 'context_usage' || event.type === 'subagent_model') return logs
  const { parent: _parent, ...own } = event as SessionEvent & { parent: string }
  void _parent
  const current = logs[parent] ?? emptyConversation
  const next = reduceConversation(current, { event: own as SessionEvent, at })
  if (next === current) return logs
  const kept: Record<string, Conversation> = { ...logs, [parent]: next }
  const keys = Object.keys(kept)
  for (const key of keys.slice(0, Math.max(0, keys.length - KEPT))) delete kept[key]
  return kept
}

/** A page of the past, in the order it happened. */
export function foldSubagents(logs: SubagentLogs, items: readonly HistoryItem[]): SubagentLogs {
  return items.reduce((acc, item) => reduceSubagents(acc, item.event, item.at), logs)
}
