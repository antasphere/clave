/**
 * `clave_attach_session` (PRDCT-4997), served by the server: nest a tab that
 * exists under another tab, or take it out. It maps onto the server's
 * `NestSession` through the typed client: the rule that decides
 * (`@clave/contract/nest-rules`) runs there, the record's `spawnedBy` is
 * rewritten there, and the windows follow through `session.nested`. Then the
 * tab is placed right after its parent in the layout of the window that
 * holds the parent, with the tabs nested under it, as the sidebar's own drop
 * does; a placement that fails leaves the link written and the answer as it
 * is. Any tab may nest any tab of the server, as the work tools reach any tab
 * (PRDCT-4236); the call must carry a tab identity.
 */
import { nestedUnder, type NestResult } from '@clave/contract/nest-rules'
import { ATTACH_SESSION_NEEDS_TAB, attachAnswer, attachRequest } from '../../shared/nest-tools'
import { ownSessionRef } from '../../shared/own-session-ref'
import { type Ctx, type Payload, getSession, tagOf } from './served-core'

async function nest(ctx: Ctx, id: string, under: string | null): Promise<NestResult> {
  try {
    return await ctx.api.sessions.nest(id, under)
  } catch (err) {
    const tag = tagOf(err)
    if (tag === 'NestRefused')
      throw new Error((err as { message?: string }).message || 'The records refused the nesting')
    if (tag === 'SessionNotFound')
      throw new Error(`No session with id "${(err as { id?: string }).id ?? id}"`)
    throw err
  }
}

/** The tab and the tabs nested under it, right after the parent, in the
 *  parent's window. Best effort: the link is the tool's work, the place is
 *  the sidebar's comfort. */
async function placeAfter(ctx: Ctx, key: string, subject: string, parent: string): Promise<void> {
  try {
    const [sessions, parentSession] = await Promise.all([
      ctx.api.sessions.list(),
      ctx.api.sessions.get(parent)
    ])
    const records = sessions.map((s) => ({
      id: s.id,
      under: ctx.shell.record(s.id)?.spawnedBy ?? null
    }))
    await ctx.api.sidebar.moveItems({
      windowKey: parentSession.windowKey || key,
      itemIds: [subject, ...nestedUnder(records, subject)],
      targetId: parent,
      position: 'after'
    })
  } catch {
    // The link is written; where the row sits is left as it was.
  }
}

async function attachSession(ctx: Ctx, key: string, p: Payload): Promise<unknown> {
  const caller = ctx.callerSessionId
  if (!caller) throw new Error(ATTACH_SESSION_NEEDS_TAB)
  const request = attachRequest(p)
  const subject = await getSession(ctx, ownSessionRef(request.subject, caller), request.subject)
  if (request.type === 'detach') return attachAnswer(await nest(ctx, subject.id, null))
  const parent = await getSession(ctx, ownSessionRef(request.to, caller), request.to)
  const result = await nest(ctx, subject.id, parent.id)
  await placeAfter(ctx, key, subject.id, parent.id)
  return attachAnswer(result)
}

export const nestTools = { attachSession } as const
