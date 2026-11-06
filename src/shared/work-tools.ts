import {
  WORK_KINDS,
  WORK_ROLES,
  type WorkAssignInput,
  type WorkAssignment,
  type WorkChange,
  type WorkChangeResult,
  type WorkKind,
  type WorkRole
} from '@clave/contract/work-rules'

/**
 * What the two work tools (PRDCT-4123) ask for, read from their arguments the
 * same way on both roads: the server's (`src/main/mcp/served-work-tools.ts`)
 * and the window's (`mcp-dispatcher.ts`). Each road keeps its own reach check
 * and its own call; this file only turns arguments into the change the rule
 * applies (`@clave/contract/work-rules`), and the rule's updates into the
 * tool's answer. A bad argument is an error in words, before any call.
 */

type Args = Record<string, unknown>
const text = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined

/** clave_set_work: the change for the session it names. `callerUnit` is the
 *  calling tab's own unit, the default when an assign names none. */
export function setWorkChange(p: Args, callerUnit: string | undefined): WorkChange {
  const action = text(p.action) ?? 'assign'
  if (action === 'complete' || action === 'leave') return { type: action }
  if (action !== 'assign') throw new Error('action is one of: assign, complete, leave')
  const role = text(p.role)
  if (!role || !(WORK_ROLES as readonly string[]).includes(role))
    throw new Error(`role is required to assign, one of: ${WORK_ROLES.join(', ')}`)
  const kind = text(p.kind)
  if (kind !== undefined && !(WORK_KINDS as readonly string[]).includes(kind))
    throw new Error('kind is wave or lane')
  const unit = text(p.unit) ?? callerUnit
  if (!unit)
    throw new Error(
      'Name the unit (unit: a stable key such as a workstream stem or a run and lane id), or assign the tab to your own unit'
    )
  const work: WorkAssignInput = {
    unit,
    role: role as WorkRole,
    ...(kind !== undefined ? { kind: kind as WorkKind } : {}),
    ...(text(p.label) !== undefined ? { label: text(p.label) } : {}),
    ...(text(p.wave) !== undefined ? { wave: text(p.wave) } : {}),
    ...(text(p.waveLabel) !== undefined ? { waveLabel: text(p.waveLabel) } : {}),
    ...(text(p.task) !== undefined ? { task: text(p.task) } : {})
  }
  return { type: 'assign', work, ...(p.replace === true ? { replace: true } : {}) }
}

/** clave_hand_over: an offer to the successor `to` names (its id still to be
 *  resolved by the road), the successor's accept, or the holder's cancel. */
export type HandOverRequest =
  | { type: 'offer'; to: string }
  | { type: 'accept'; replace: boolean }
  | { type: 'cancel' }

export function handOverRequest(p: Args): HandOverRequest {
  const to = text(p.to)
  const asked = [to !== undefined, p.accept === true, p.cancel === true].filter(Boolean).length
  if (asked !== 1)
    throw new Error(
      "Pass exactly one of: to (the successor's session id), accept: true (take over the role handed to you), cancel: true (withdraw your offer)"
    )
  if (to !== undefined) return { type: 'offer', to }
  if (p.accept === true) return { type: 'accept', replace: p.replace === true }
  return { type: 'cancel' }
}

export function handOverChange(request: HandOverRequest, successorId?: string): WorkChange {
  if (request.type === 'offer') {
    if (!successorId) throw new Error('The successor could not be found')
    return { type: 'offer', to: successorId }
  }
  if (request.type === 'accept')
    return { type: 'accept', ...(request.replace ? { replace: true } : {}) }
  return { type: 'cancel' }
}

/** A tool's answer: the subject's assignment as it stands now, every record
 *  the change rewrote, and the names an accepted handover gave (the
 *  successor's is the name its tab is addressed by from now on). */
export function workToolAnswer(
  subject: string,
  result: WorkChangeResult
): {
  sessionId: string
  work: WorkAssignment | null
  changed: { sessionId: string; work: WorkAssignment | null }[]
  renamed: { sessionId: string; name: string }[]
} {
  return {
    sessionId: subject,
    work: result.changed.find((u) => u.id === subject)?.work ?? null,
    changed: result.changed.map((u) => ({ sessionId: u.id, work: u.work })),
    renamed: result.renamed.map((r) => ({ sessionId: r.id, name: r.name }))
  }
}
