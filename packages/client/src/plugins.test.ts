import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import type { Call, DerivedClient } from './call'
import { pluginsClient } from './plugins'

/** The plugins client over a recording fake of the derived request client:
 *  each endpoint records the request it was given and answers what the test
 *  set, so the module's mapping is checked without a server. */
const fake = (
  answers: Record<string, unknown> = {}
): { calls: Array<[string, unknown]>; call: Call } => {
  const calls: Array<[string, unknown]> = []
  const plugins = new Proxy(
    {},
    {
      get:
        (_target, endpoint: string) =>
        (request: unknown): Effect.Effect<unknown> => {
          calls.push([endpoint, request])
          return Effect.succeed(answers[endpoint])
        }
    }
  )
  const client = { plugins } as unknown as DerivedClient
  const call: Call = (run) => Effect.runPromise(run(client))
  return { calls, call }
}

describe('the plugins client', () => {
  it('answers the linked plugin’s id', async () => {
    const { calls, call } = fake({ link: { id: 'dev.local' } })
    expect(await pluginsClient(call).link('/work/my-plugin')).toBe('dev.local')
    expect(calls).toEqual([['link', { payload: { folder: '/work/my-plugin' } }]])
  })

  it('answers a view request’s result, and undefined when the plugin gave none', async () => {
    const { calls, call } = fake({ requestView: { result: { rows: 2 } } })
    const plugins = pluginsClient(call)
    expect(await plugins.requestView('l1', 'rows.count', { table: 't' })).toEqual({ rows: 2 })
    const empty = fake({ requestView: {} })
    expect(await pluginsClient(empty.call).requestView('l1', 'ping')).toBeUndefined()
    expect(calls[0]).toEqual([
      'requestView',
      { payload: { leaseId: 'l1', method: 'rows.count', params: { table: 't' } } }
    ])
    expect(empty.calls[0]).toEqual(['requestView', { payload: { leaseId: 'l1', method: 'ping' } }])
  })

  it('passes a null session through to the context report', async () => {
    const { calls, call } = fake()
    expect(await pluginsClient(call).context('w1', null)).toBeUndefined()
    expect(calls).toEqual([['context', { payload: { windowKey: 'w1', sessionId: null } }]])
  })

  it('sends the queries an empty payload and the commands theirs, a void as undefined', async () => {
    const { calls, call } = fake({ list: [], secrets: [] })
    const plugins = pluginsClient(call)
    expect(await plugins.list()).toEqual([])
    expect(await plugins.secrets()).toEqual([])
    expect(await plugins.enable('p', ['net'])).toBeUndefined()
    expect(await plugins.replySecret('q1', null)).toBeUndefined()
    expect(calls).toEqual([
      ['list', { payload: {} }],
      ['secrets', { payload: {} }],
      ['enable', { payload: { id: 'p', grants: ['net'] } }],
      ['replySecret', { payload: { id: 'q1', value: null } }]
    ])
  })
})
