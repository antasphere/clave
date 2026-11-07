import { afterEach, expect, it, vi } from 'vitest'
import { ClaveServerClient, type FetchLike } from '../api/client'
import type { PushSocketConstructor } from '../api/push'
import { Drafts, MemoryKeyValueStore } from '../chat/drafts'
import { MemorySecureStore, SecureCredentialStore } from '../machines/credentials'
import type { Machine } from '../machines/types'
import { createStore } from '../state/store'
import { DeliveryController } from './controller'
import { DeliveryMarks, UnknownSends } from './ledger'

const machine: Machine = {
  id: 'm',
  name: 'Fixture',
  platform: 'macos',
  version: 'test',
  online: true,
  lastSeen: 1,
  baseUrl: 'http://127.0.0.1:1',
  pushUrl: 'http://127.0.0.1:1/push'
}
const NoSocket = class {
  onopen = null
  onmessage = null
  onclose = null
  onerror = null
  send(): void {
    /* no socket in this fixture */
  }
  close(): void {
    /* no socket in this fixture */
  }
} as unknown as PushSocketConstructor
const answer = (status: number, body: unknown): Awaited<ReturnType<FetchLike>> => ({
  status,
  ok: status < 300,
  text: async () => JSON.stringify(body)
})
afterEach(() => vi.useRealTimers())

async function setup(fetch: FetchLike): Promise<{
  store: ReturnType<typeof createStore>
  kv: MemoryKeyValueStore
  delivery: DeliveryController
  drafts: Drafts
}> {
  const kv = new MemoryKeyValueStore()
  const drafts = new Drafts(kv)
  const credentials = new SecureCredentialStore(new MemorySecureStore())
  await credentials.set(machine.id, {
    serverUrl: machine.baseUrl,
    bearer: 'fixture-device-session'
  })
  const delivery = new DeliveryController(new UnknownSends(kv), new DeliveryMarks(kv), drafts, kv)
  const store = createStore({
    build: 'development',
    credentials,
    delivery,
    kv,
    drafts,
    sources: { relay: { list: async () => [machine] }, developer: null },
    clientOptions: { fetch, build: 'development' },
    pushOptions: { WebSocket: NoSocket, build: 'development' },
    clientName: 'fixture-phone'
  })
  await store.getState().loadMachines()
  await drafts.set('m', 's', '  original bytes  ')
  return { store, kv, delivery, drafts }
}

it('persists original bytes and ID before dispatch and restores the unknown warning after a process restart', async () => {
  let writes = 0
  const fetch: FetchLike = async (url, init) => {
    if (url.includes('/sessions/write') && init.method === 'POST') {
      writes++
      expect(await env.delivery.sends.list()).toMatchObject([
        { clientMessageId: 'message-1000', text: 'original bytes', draftText: '  original bytes  ' }
      ])
      return answer(200, {}) // Malformed acknowledgement after a possible accepted write.
    }
    return answer(200, { status: 'unknown' })
  }
  const env = await setup(fetch)
  const result = await env.store.getState().send('m', 's', '  original bytes  ', 'message-1000')
  expect(result.kind).toBe('unknown')
  expect(writes).toBe(1)
  const restored = new DeliveryController(
    new UnknownSends(env.kv),
    new DeliveryMarks(env.kv),
    new Drafts(env.kv),
    env.kv
  )
  expect(await restored.sends.list()).toHaveLength(1)
  expect(await restored.marks.get('m', 's')).toMatchObject({
    kind: 'unknown',
    clientMessageId: 'message-1000'
  })
  expect(await new Drafts(env.kv).get('m', 's')).toBe('  original bytes  ')
  env.store.getState().disconnectAll()
})

it('a pending 200 never clears the draft or tracking until status proves acceptance', async () => {
  vi.useFakeTimers()
  let accepted = false
  const env = await setup(async (url, init) =>
    answer(
      200,
      init.method === 'POST' ? { status: 'pending' } : { status: accepted ? 'accepted' : 'pending' }
    )
  )
  let done = false
  const sending = env.store
    .getState()
    .send('m', 's', '  original bytes  ', 'message-1001')
    .then((result) => {
      done = true
      return result
    })
  await vi.advanceTimersByTimeAsync(500)
  expect(done).toBe(false)
  expect(await env.drafts.get('m', 's')).toBe('  original bytes  ')
  expect(await env.delivery.sends.list()).toHaveLength(1)
  accepted = true
  await vi.advanceTimersByTimeAsync(1000)
  expect((await sending).kind).toBe('sent')
  expect(await env.drafts.get('m', 's')).toBe('')
  expect(await env.delivery.sends.list()).toEqual([])
  env.store.getState().disconnectAll()
})

it('a reconnect queries unknown sends and preserves edits, without sending an ordinary offline draft', async () => {
  const env = await setup(async (_url, init) =>
    answer(200, init.method === 'POST' ? {} : { status: 'unknown' })
  )
  await env.store.getState().send('m', 's', '  original bytes  ', 'message-1002')
  await env.drafts.set('m', 's', 'edited after dispatch')
  await env.drafts.set('m', 'plain', 'unsent offline draft')
  let writes = 0
  const client = new ClaveServerClient(
    { serverUrl: machine.baseUrl, bearer: 'fixture-device-session' },
    {
      build: 'development',
      fetch: async (_url, init) => {
        if (init.method === 'POST') writes++
        return answer(200, { status: 'accepted' })
      }
    }
  )
  const refreshes: string[] = []
  await env.delivery.reconnect({
    machineId: 'm',
    client,
    openConversations: [{ sessionId: 's' }],
    refreshRequests: async () => {
      refreshes.push('requests')
    },
    refreshHistory: async () => {
      refreshes.push('history')
    }
  })
  expect(writes).toBe(0)
  expect(await env.drafts.get('m', 's')).toBe('edited after dispatch')
  expect(await env.drafts.get('m', 'plain')).toBe('unsent offline draft')
  expect(await env.delivery.marks.get('m', 's')).toBeNull()
  expect(refreshes).toEqual(['requests', 'history'])
  env.store.getState().disconnectAll()
})
