import { it, expect, vi } from 'vitest'
import { createStore, conversationKey } from './store'
import { Drafts, MemoryKeyValueStore } from '../chat/drafts'
import { MemorySecureStore, SecureCredentialStore } from '../machines/credentials'
import type { SessionStream, TimelinePage } from '../contract/types'
const machine = {
  id: 'm',
  name: 'test',
  platform: 'unknown' as const,
  version: '',
  online: true,
  lastSeen: null,
  baseUrl: 'http://127.0.0.1:43211',
  pushUrl: 'http://127.0.0.1:43211/push'
}
const NoSocket = class {
  onopen = null
  onmessage = null
  onclose = null
  onerror = null
  send(): void {
    /* stub */
  }
  close(): void {
    /* stub */
  }
}
async function setup(): Promise<{
  store: ReturnType<typeof createStore>
  stream: (s: SessionStream) => void
  page: (page: TimelinePage) => void
  requests: string[]
}> {
  const kv = new MemoryKeyValueStore()
  const credentials = new SecureCredentialStore(new MemorySecureStore())
  await credentials.set('m', { serverUrl: machine.baseUrl, bearer: 'fixture' })
  let resolve!: (value: unknown) => void
  const requests: string[] = []
  const store = createStore({
    build: 'development',
    credentials,
    kv,
    drafts: new Drafts(kv),
    sources: { relay: { list: async () => [machine] }, developer: null },
    clientName: 'verify',
    pushOptions: { WebSocket: NoSocket },
    clientOptions: {
      fetch: async (url) => {
        requests.push(String(url))
        return {
          status: 200,
          ok: true,
          text: async () =>
            JSON.stringify(
              await new Promise((r) => {
                resolve = r
              })
            )
        }
      }
    }
  })
  await store.getState().loadMachines()
  const connection = await store.getState().connect('m')
  connection.push.subscribed = async () => ({ id: 's' }) as never
  let stream!: (s: SessionStream) => void
  connection.push.subscribe = (_id, cb) => {
    stream = cb
    return () => {}
  }
  return {
    store,
    stream: (s: SessionStream) => stream(s),
    requests,
    page: (page) => resolve(page)
  }
}

const item = (delta: string, sequence: number, generation = 'g'): import('../contract/types').TimelineItem => ({
  event: { type: 'assistant_text' as const, delta, final: false },
  position: { generation, sequence }
})
const page = (delta: string, sequence = 1, generation = 'g'): TimelinePage => ({
  items: [item(delta, sequence, generation)],
  before: null,
  cursor: { generation, sequence },
  truncated: false
})
const text = (p: Awaited<ReturnType<typeof setup>>): string =>
  p.store
    .getState()
    .conversations[conversationKey('m', 's')]!.conversation.entries.map((e) =>
      'text' in e ? e.text : ''
    )
    .join('')

it('retains identical new deltas during snapshot and deduplicates replay by position', async () => {
  const p = await setup()
  const open = p.store.getState().openChat('m', 's')
  await vi.waitFor(() => expect(p.requests).toHaveLength(1))
  p.stream({ kind: 'event', ...item('a', 1) })
  p.stream({ kind: 'event', ...item('a', 2) })
  p.stream({ kind: 'event', ...item('a', 2) })
  p.page(page('a'))
  await open
  expect(text(p)).toBe('aa')
  p.stream({ kind: 'event', ...item('a', 2) })
  p.stream({ kind: 'event', ...item('a', 3) })
  expect(text(p)).toBe('aaa')
  p.store.getState().disconnectAll()
})
it('reopens from a fresh snapshot and refreshes only open histories without sending', async () => {
  const p = await setup()
  let open = p.store.getState().openChat('m', 's')
  await vi.waitFor(() => expect(p.requests).toHaveLength(1))
  p.page(page('old'))
  const close = await open
  close()
  await p.store.getState().refreshOpenHistory('m')
  expect(p.requests).toHaveLength(1)
  open = p.store.getState().openChat('m', 's')
  await vi.waitFor(() => expect(p.requests).toHaveLength(2))
  p.page(page('new', 2))
  await open
  expect(text(p)).toBe('new')
  const refresh = p.store.getState().refreshOpenHistory('m')
  await vi.waitFor(() => expect(p.requests).toHaveLength(3))
  p.stream({ kind: 'event', ...item('new', 3) })
  p.page(page('new', 2))
  await refresh
  expect(text(p)).toBe('newnew')
  expect(p.requests.every((url) => url.includes('/sessions/timeline'))).toBe(true)
  p.store.getState().disconnectAll()
})
it('takes another snapshot when the generation changes while a response is delayed', async () => {
  const p = await setup()
  const open = p.store.getState().openChat('m', 's')
  await vi.waitFor(() => expect(p.requests).toHaveLength(1))
  p.stream({ kind: 'event', ...item('fresh', 1, 'new') })
  p.page(page('old'))
  await vi.waitFor(() => expect(p.requests).toHaveLength(2))
  p.page(page('fresh', 1, 'new'))
  await open
  expect(text(p)).toBe('fresh')
  p.stream({ kind: 'event', ...item('second', 1, 'third') })
  await vi.waitFor(() => expect(p.requests).toHaveLength(3))
  p.page(page('second', 1, 'third'))
  await vi.waitFor(() => expect(text(p)).toBe('second'))
  p.store.getState().disconnectAll()
})
it('a missed sequence refreshes rather than silently omitting the missing event', async () => {
  const p = await setup()
  const open = p.store.getState().openChat('m', 's')
  await vi.waitFor(() => expect(p.requests).toHaveLength(1))
  p.page(page('a'))
  await open
  p.stream({ kind: 'event', ...item('c', 3) })
  await vi.waitFor(() => expect(p.requests).toHaveLength(2))
  p.page({ ...page('unused', 3), items: [item('a', 1), item('b', 2), item('c', 3)] })
  await vi.waitFor(() => expect(text(p)).toBe('abc'))
  p.store.getState().disconnectAll()
})
