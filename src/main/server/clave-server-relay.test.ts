import { afterEach, expect, it, vi } from 'vitest'
import type { ServerPorts } from '@clave/server'

const state = vi.hoisted(() => {
  let release!: () => void
  const ready = new Promise<void>((resolve) => {
    release = resolve
  })
  return { ready, release, importing: false, order: [] as string[], count: 0 }
})
vi.mock('../sessions/session-manager', () => ({ sessionManager: {} }))
vi.mock('../sessions/e2e-hooks', () => ({ installE2eHooks: vi.fn() }))
vi.mock('./session-events', () => ({
  setServerEventPublisher: vi.fn(),
  publishSessionStates: () => () => {},
  observeSessionsForNotify: () => () => {}
}))
vi.mock('@clave/server', () => ({
  ServerInfoPort: {},
  loadPushPorts: vi.fn(),
  fileWriteLedgerStorage: vi.fn(),
  parsePushFixtureArgs: () => ({}),
  startEmbedded: async () => {
    const id = ++state.count
    state.order.push(`embedded-start:${id}`)
    return {
      url: `http://127.0.0.1:${43000 + id}`,
      token: 'test',
      publish: vi.fn(),
      writes: {},
      stop: async () => {
        state.order.push(`server-stop:${id}`)
        return { ms: 0, inFlight: 0, drained: true, peers: 0, destroyed: 0 }
      }
    }
  }
}))
vi.mock('../settings/shell-source', async () => {
  state.importing = true
  await state.ready
  return { shellAntasphereAccount: null }
})
vi.mock('./relay-wiring', () => ({
  startMobileRelay: () => {
    state.order.push(`relay-start:${state.count}`)
  },
  stopMobileRelay: async () => {
    state.order.push(`relay-stop:${state.count}`)
  }
}))
import { startClaveServer, stopClaveServer } from './clave-server'

const electron = Object.getOwnPropertyDescriptor(process.versions, 'electron')
afterEach(async () => {
  state.release()
  await stopClaveServer()
  if (electron) Object.defineProperty(process.versions, 'electron', electron)
  else Reflect.deleteProperty(process.versions, 'electron')
})

it('orders delayed relay startup, shutdown and a concurrent restart', async () => {
  Object.defineProperty(process.versions, 'electron', { value: 'test', configurable: true })
  const options = { ports: { devices: {} } as ServerPorts }
  const first = startClaveServer(options)
  await vi.waitFor(() => expect(state.importing).toBe(true))
  const stopped = stopClaveServer()
  const restarted = startClaveServer(options)
  await new Promise((resolve) => setImmediate(resolve))
  expect(state.order).toEqual(['embedded-start:1'])
  state.release()
  await Promise.all([first, stopped, restarted])
  expect(state.order).toEqual([
    'embedded-start:1',
    'relay-start:1',
    'server-stop:1',
    'relay-stop:1',
    'embedded-start:2',
    'relay-start:2'
  ])
})
