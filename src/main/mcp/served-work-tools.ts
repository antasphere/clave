/**
 * The two work tools of PRDCT-4123, served by the server: `clave_set_work`
 * says which wave or lane a tab works on and in which role, `clave_hand_over`
 * offers a role to a successor, takes it over, or withdraws the offer. Each
 * maps onto the server's `ChangeSessionWork` through the typed client: the
 * rule that decides (`@clave/contract/work-rules`) runs there, the records
 * are rewritten there, and the windows follow through `session.work_changed`.
 * Who may assign whom is the messaging tools' reach: a tab reaches itself,
 * the tab that opened it, the tabs it opened, and the tabs of its group.
 */
import type { WorkChange, WorkChangeResult } from '@clave/contract/work-rules'
import {
  handOverChange,
  handOverRequest,
  setWorkChange,
  workToolAnswer
} from '../../shared/work-tools'
import { type Ctx, type Payload, getSession, str, tagOf } from './served-core'
import { isRelated } from './served-session-tools'

function callerOf(ctx: Ctx, tool: string): string {
  if (!ctx.callerSessionId)
    throw new Error(
      `${tool} must be called from inside a Clave agent tab — this request has no tab identity.`
    )
  return ctx.callerSessionId
}

async function assertReach(
  ctx: Ctx,
  caller: string,
  targetId: string,
  targetName: string,
  verb: string
): Promise<void> {
  if (caller === targetId) return
  const layouts = await ctx.api.sidebar.listLayouts()
  if (!isRelated(ctx, layouts, caller, targetId))
    throw new Error(
      `Refusing to ${verb} tab "${targetName}": it is not related to yours. You can only reach the tab that opened yours ("parent"), tabs you opened, or tabs in the same group. Put both tabs in one group to allow this.`
    )
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

const nameOf = (ctx: Ctx, id: string, fallback: string): string => {
  const record = ctx.shell.record(id)
  return record?.displayName || record?.folderName || fallback
}

async function setWork(ctx: Ctx, _key: string, p: Payload): Promise<unknown> {
  const caller = callerOf(ctx, 'clave_set_work')
  const ref = str(p.sessionId) ?? 'mine'
  const target = await getSession(ctx, ref === 'mine' ? caller : ref, ref)
  await assertReach(ctx, caller, target.id, nameOf(ctx, target.id, target.title), 'assign')
  const change = setWorkChange(p, ctx.shell.record(caller)?.work?.unit)
  return workToolAnswer(target.id, await changeWork(ctx, target.id, change))
}

async function handOver(ctx: Ctx, _key: string, p: Payload): Promise<unknown> {
  const caller = callerOf(ctx, 'clave_hand_over')
  const request = handOverRequest(p)
  if (request.type !== 'offer')
    return workToolAnswer(caller, await changeWork(ctx, caller, handOverChange(request)))
  const successor = await getSession(ctx, request.to, request.to)
  await assertReach(
    ctx,
    caller,
    successor.id,
    nameOf(ctx, successor.id, successor.title),
    'hand over to'
  )
  return workToolAnswer(
    caller,
    await changeWork(ctx, caller, handOverChange(request, successor.id))
  )
}

export const workTools = { setWork, handOver } as const
