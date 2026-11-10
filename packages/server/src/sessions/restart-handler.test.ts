import { describe, expect, it, vi } from 'vitest'
import { Effect } from 'effect'
import { RestartSession } from '@clave/contract/sessions'
import { sessionHandlers } from './handlers'
import { SessionHost, type SessionHostService } from './port'
import { ServerEvents } from '../events'

/**
 * The server's RestartSession hands the host every field of the payload,
 * the provider switch included (PRDCT-4300, verifier round 1 F7): the
 * end-to-end spec was the only thing that caught a dropped `payload.provider`.
 */
describe('RestartSession on the server (PRDCT-4300)', () => {
  const registration = sessionHandlers.find((r) => r.definition === RestartSession)!
  const run = (
    host: SessionHostService,
    payload: unknown,
    published: unknown[]
  ): Promise<unknown> =>
    Effect.runPromise(
      registration.handler(payload, (() => Effect.void) as never).pipe(
        Effect.provideService(SessionHost, host),
        Effect.provideService(ServerEvents, {
          publish: (event: unknown) => {
            published.push(event)
            return Effect.void
          }
        } as never)
      )
    )
  it('forwards the provider override to the host and announces the restart', async () => {
    const restart = vi.fn(async () => ({
      id: 's1',
      cwd: '/w',
      folderName: 'w',
      alive: true,
      claudeSessionId: null,
      piSessionId: null,
      resumed: true
    }))
    const host = { ...SessionHost.none, get: () => ({ id: 's1', state: 'idle' }), restart } as never
    const published: unknown[] = []
    const provider = { adapterId: 'codex-chat', model: 'gpt-5.5', resume: 'thread-7' }
    const out = await run(
      host,
      { id: 's1', account: { codexAccountId: 'c1' }, requestId: 'op-1', provider },
      published
    )
    expect(restart).toHaveBeenCalledExactlyOnceWith(
      's1',
      { codexAccountId: 'c1' },
      false,
      false,
      provider
    )
    expect(out).toMatchObject({ id: 's1', resumed: true, requestId: 'op-1' })
    expect(published.map((e) => (e as { _tag: string })._tag)).toEqual([
      'session.restarting',
      'session.restarted'
    ])
  })
})
