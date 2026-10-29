import { it, expect } from 'vitest'
import { createStore, conversationKey } from './store'
import { Drafts, MemoryKeyValueStore } from '../chat/drafts'
import { MemorySecureStore, SecureCredentialStore } from '../machines/credentials'
import type { SessionStream } from '../contract/types'
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
  page: (text: string) => void
}> {
  const kv = new MemoryKeyValueStore()
  const credentials = new SecureCredentialStore(new MemorySecureStore())
  await credentials.set('m', { serverUrl: machine.baseUrl, bearer: 'fixture' })
  let resolve!: (value: unknown) => void
  const store = createStore({
    build: 'development',
    credentials,
    kv,
    drafts: new Drafts(kv),
    sources: { relay: { list: async () => [machine] }, developer: null },
    clientName: 'verify',
    pushOptions: { WebSocket: NoSocket },
    clientOptions: {
      fetch: async () => ({
        status: 200,
        ok: true,
        text: async () =>
          JSON.stringify(
            await new Promise((r) => {
              resolve = r
            })
          )
      })
    }
  })
  await store.getState().loadMachines()
  const connection = await store.getState().connect('m')
  let stream!: (s: SessionStream) => void
  connection.push.subscribe = (_id, cb) => {
    stream = cb
    return () => {}
  }
  return {
    store,
    stream: (s: SessionStream) => stream(s),
    page: (text: string) =>
      resolve({
        items: [{ event: { type: 'assistant_text', delta: text, final: true }, at: 1 }],
        before: null
      })
  }
}
it('retains live messages arriving while initial history is in flight', async () => {
  const p = await setup()
  const open = p.store.getState().openChat('m', 's')
  await new Promise((r) => setTimeout(r, 0))
  p.stream({ kind: 'event', event: { type: 'assistant_text', delta: 'live', final: true } })
  p.page('history')
  await open
  expect(
    p.store
      .getState()
      .conversations[
        conversationKey('m', 's')
      ]!.conversation.entries.map((e) => ('text' in e ? e.text : ''))
  ).toEqual(['history', 'live'])
  p.store.getState().disconnectAll()
})
it('refreshes missed history when reopening loaded chat', async () => {
  const p = await setup()
  let open = p.store.getState().openChat('m', 's')
  await new Promise((r) => setTimeout(r, 0))
  p.page('old')
  const close = await open
  close()
  open = p.store.getState().openChat('m', 's')
  await new Promise((r) => setTimeout(r, 0))
  p.page('new')
  await open
  expect(
    p.store
      .getState()
      .conversations[
        conversationKey('m', 's')
      ]!.conversation.entries.map((e) => ('text' in e ? e.text : ''))
  ).toEqual(['new'])
  p.store.getState().disconnectAll()
})
