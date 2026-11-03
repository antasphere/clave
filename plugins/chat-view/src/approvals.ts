import type { Entry, Permission } from './reducer'

/* The transcript's reading of an approval: what was asked, in words a reader
   understands, and what the reader said. The Claude adapter names the tool
   (Write, Bash) and labels its options in words; the Codex adapter names the
   protocol's method (item/commandExecution/requestApproval,
   mcpServer/elicitation/request) with the frame's params as the input and the
   decisions as their raw ids (accept, acceptForSession, decline). On 3
   November 2026 a wave's transcript read "accept
   item/commandExecution/requestApproval" once per answer, a wall of rows all
   the same; this file reads both shapes, and says which rows fold into a run. */

export type PermissionEntry = Extract<Entry, { kind: 'permission' }>

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const text = (value: unknown): string => (typeof value === 'string' ? value : '')
/** A command as the frame carries it: a line, argv joined, or the first
 *  action Codex parsed out of it. */
const commandText = (p: Record<string, unknown>): string => {
  if (typeof p.command === 'string') return p.command
  if (Array.isArray(p.command) && p.command.every((v) => typeof v === 'string'))
    return p.command.join(' ')
  const actions = Array.isArray(p.commandActions) ? p.commandActions.map(record) : []
  return text(actions[0]?.command)
}
/** The Clave tool server as the Codex adapter binds it: `clave`, or `clave_`
 *  and twelve hex digits, a fresh name per connection that means nothing to
 *  the reader. */
const CLAVE_SERVER = /^clave(_[a-f0-9]{12})?$/
const COMMAND_METHODS = new Set(['item/commandExecution/requestApproval', 'execCommandApproval'])
const EDIT_METHODS = new Set(['item/fileChange/requestApproval', 'applyPatchApproval'])

/** The words of a decision id the adapter passed through as its own label. */
const DECISION_WORDS: Record<string, string> = {
  accept: 'Allowed',
  acceptForSession: 'Allowed for the session',
  approved: 'Allowed',
  approved_for_session: 'Allowed for the session',
  decline: 'Declined',
  cancel: 'Cancelled',
  abort: 'Cancelled'
}
/** A refusal, by the option's id (the words every provider uses) or, when
 *  the ids say nothing, by its label: Codex's extra-permissions choices
 *  carry JSON ids and "Deny extra permissions" as the label. */
const REFUSAL_ID = /deny|decline|cancel|reject|abort/i
const REFUSAL_LABEL = /^(deny|decline|cancel|reject|abort|skip)\b/i
export function refused(request: Permission, answer: string): boolean {
  const option = request.options.find((o) => o.id === answer)
  return REFUSAL_ID.test(answer) || (!!option && REFUSAL_LABEL.test(option.label))
}
/** What the reader said, as the row shows it: the provider's own label when
 *  it has one, the words of a raw id otherwise. */
export function decisionWord(request: Permission, answer: string): string {
  const option = request.options.find((o) => o.id === answer)
  if (option && option.label !== option.id) return option.label
  return DECISION_WORDS[answer] ?? option?.label ?? answer
}
/** A request answered with words rather than allowed: one that asks
 *  questions, or one that names no tool. */
export const isQuestion = (request: Permission): boolean => !!request.questions || !request.toolName

/** What a Codex request asked, in the reader's words: a verb phrase and what
 *  it was about (the command, the reason, the tool and its server).
 *  Undefined for a request the view describes by its tool name (Claude's). */
export function describeApproval(
  request: Permission
): { label: string; target: string } | undefined {
  const method = request.toolName ?? ''
  const p = record(request.input)
  if (COMMAND_METHODS.has(method))
    return { label: 'Run a command', target: commandText(p) || text(p.reason) }
  if (EDIT_METHODS.has(method))
    return { label: 'Edit files', target: text(p.reason) || text(p.grantRoot) }
  if (method === 'item/permissions/requestApproval')
    return {
      label: 'Extra permissions',
      target: text(p.reason) || Object.keys(record(p.permissions)).join(', ')
    }
  if (method === 'mcpServer/elicitation/request') {
    // Codex 0.166.0 names the tool in the message alone ("Allow the probe MCP
    // server to run tool \"ending_tool\"?"), its _meta carrying the kind, the
    // description and the params; a frame that names the tool under its own
    // key is read first. Verified live by the lane's verifier on 3 November 2026.
    const tool =
      text(record(p._meta).tool_name) || /run tool "([^"]+)"/.exec(text(p.message))?.[1] || ''
    const server = text(p.serverName)
    return {
      label: tool ? `Use ${tool}` : 'Use a tool',
      target: CLAVE_SERVER.test(server) ? 'Clave' : server || text(p.message)
    }
  }
  return undefined
}
/** An approval the reader allowed and nothing more is owed on: answered here,
 *  not a question, not a refusal. The rows that fold into a run; everything
 *  else stays a row of its own. */
export function settledApproval(entry: PermissionEntry): boolean {
  return (
    entry.answer !== undefined &&
    !entry.answeredElsewhere &&
    !isQuestion(entry.request) &&
    !refused(entry.request, entry.answer)
  )
}
/** The one line a closed run shows: how many were allowed, and of what. */
export function approvalRunSummary(approvals: PermissionEntry[]): {
  head: string
  detail: string
} {
  const counts = new Map<string, number>()
  for (const entry of approvals) {
    const label = describeApproval(entry.request)?.label ?? entry.request.toolName ?? 'request'
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  return {
    head: `Allowed ${approvals.length} ${approvals.length === 1 ? 'request' : 'requests'}`,
    detail: [...counts].map(([label, n]) => (n > 1 ? `${label} ×${n}` : label)).join(' · ')
  }
}
