import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_SERVER_ID, type SavedServerConnection } from '@clave/contract/fleet'

let machine: typeof import('./settings-machine-store')
let fleet: typeof import('./fleet-store')

const server = (id: string, enabled = true): SavedServerConnection => ({
  id,
  name: `Server ${id}`,
  url: 'http://server.example:7300',
  enabled
})

beforeAll(async () => {
  const memory = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
    removeItem: (key: string) => memory.delete(key)
  })
  vi.stubGlobal('window', globalThis)
  vi.stubGlobal('electronAPI', {})
  fleet = await import('./fleet-store')
  machine = await import('./settings-machine-store')
  machine.startSettingsMachineGuard()
  machine.startSettingsMachineGuard()
})

beforeEach(() => {
  fleet.useFleetStore.setState({ connections: [server('a'), server('b')], statuses: {} })
  machine.useSettingsMachineStore.setState({ machine: LOCAL_SERVER_ID })
})

const picked = (): string => machine.useSettingsMachineStore.getState().machine

describe('the machine the Agents settings show', () => {
  it('is this Mac until a server is picked', () => {
    expect(picked()).toBe(LOCAL_SERVER_ID)
    machine.useSettingsMachineStore.getState().setMachine('a')
    expect(picked()).toBe('a')
  })

  it('falls back to this Mac when the picked server is removed', () => {
    machine.useSettingsMachineStore.getState().setMachine('a')
    fleet.useFleetStore.setState({ connections: [server('b')] })
    expect(picked()).toBe(LOCAL_SERVER_ID)
  })

  it('falls back to this Mac when the picked server is switched off', () => {
    machine.useSettingsMachineStore.getState().setMachine('b')
    fleet.useFleetStore.setState({ connections: [server('a'), server('b', false)] })
    expect(picked()).toBe(LOCAL_SERVER_ID)
  })

  it('stays on a server that is only reconnecting', () => {
    machine.useSettingsMachineStore.getState().setMachine('a')
    fleet.useFleetStore.setState({
      statuses: { a: { serverId: 'a', state: 'reconnecting', attempt: 2 } }
    })
    expect(picked()).toBe('a')
  })

  it('leaves another server removed alone', () => {
    machine.useSettingsMachineStore.getState().setMachine('a')
    fleet.useFleetStore.setState({ connections: [server('a')] })
    expect(picked()).toBe('a')
  })
})
