/**
 * The two work tools of PRDCT-4123, served by the server: `clave_set_work`
 * says which wave or lane a tab works on and in which role, `clave_hand_over`
 * offers a role to a successor, takes it over, or withdraws the offer. Each
 * maps onto the server's `ChangeSessionWork` through the typed client: the
 * rule that decides (`@clave/contract/work-rules`) runs there, the records
 * are rewritten there, and the windows follow through `session.work_changed`.
 * Any tab may assign or hand over to any tab of the server, as the messaging
 * tools reach any tab (PRDCT-4236); the call must carry a tab identity.
 */
import type { WorkChange, WorkChangeResult } from '@clave/contract/work-rules'
import {
  handOverChange,
  handOverRequest,
  setWorkChange,
  workToolAnswer
} from '../../shared/work-tools'
import { type Ctx, type Payload, getSession, str, tagOf } from './served-core'

function callerOf(ctx: Ctx, tool: string): string {
  if (!ctx.callerSessionId)
    throw new Error(
      `${tool} must be called from inside a Clave agent tab — this request has no tab identity.`
    )
  return ctx.callerSessionId
}

async function changeWork(ctx: Ctx, id: string, change: WorkChange): Promise<WorkChangeResult> {
  try {
    return await ctx.api.sessions.changeWork(id, change)
  } catch (err) {
    const tag = tagOf(err)
    if (tag === 'WorkChangeRefused')
      throw new Error((err as { message?: string }).message || 'The records refused the change')
    if (tag === 'SessionNotFound') throw new Error(`No session with id "${id}"`)
    throw err
  }
}

async function setWork(ctx: Ctx, _key: string, p: Payload): Promise<unknown> {
  const caller = callerOf(ctx, 'clave_set_work')
  const ref = str(p.sessionId) ?? 'mine'
  const target = await getSession(ctx, ref === 'mine' ? caller : ref, ref)
  const change = setWorkChange(p, ctx.shell.record(caller)?.work?.unit)
  return workToolAnswer(target.id, await changeWork(ctx, target.id, change))
}

async function handOver(ctx: Ctx, _key: string, p: Payload): Promise<unknown> {
  const caller = callerOf(ctx, 'clave_hand_over')
  const request = handOverRequest(p)
  if (request.type !== 'offer')
    return workToolAnswer(caller, await changeWork(ctx, caller, handOverChange(request)))
  const successor = await getSession(ctx, request.to, request.to)
  return workToolAnswer(
    caller,
    await changeWork(ctx, caller, handOverChange(request, successor.id))
  )
}

export const workTools = { setWork, handOver } as const
