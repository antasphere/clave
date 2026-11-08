import { afterEach, expect, it, vi } from 'vitest'
import type { AntasphereAccountManager } from '../antasphere-account'
import { electronTestPorts } from '../ports/testing'
import { startMobileRelay, stopMobileRelay } from './relay-wiring'

const client = vi.hoisted(() => ({
  kick: vi.fn(),
  stop: vi.fn(async () => {}),
  status: vi.fn()
}))
vi.mock('@clave/server', async (original) => ({
  ...(await original<typeof import('@clave/server')>()),
  startRelayClient: () => ({ ...client })
}))
afterEach(async () => {
  await stopMobileRelay()
  vi.clearAllMocks()
})

it('keeps the connection on token renewal and reconnects when the owner changes', async () => {
  let subject: string | null = 'owner-A'
  let changed: () => void = () => {}
  const unsubscribe = vi.fn()
  const manager = {
    status: () => ({ account: subject ? { subject } : null }),
    onChange: (listener: () => void) => {
      changed = listener
      return unsubscribe
    }
  } as unknown as AntasphereAccountManager
  startMobileRelay({
    local: { url: 'http://127.0.0.1:43203' },
    version: '2.4.0',
    flag: 'https://relay.example',
    antasphere: manager,
    ports: electronTestPorts(),
    log: () => {}
  })
  changed()
  changed()
  expect(client.kick).not.toHaveBeenCalled()
  subject = null
  changed()
  expect(client.kick).toHaveBeenCalledTimes(1)
  subject = 'owner-B'
  changed()
  expect(client.kick).toHaveBeenCalledTimes(2)
  await stopMobileRelay()
  expect(unsubscribe).toHaveBeenCalledOnce()
})
