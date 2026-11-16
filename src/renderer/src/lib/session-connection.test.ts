import { describe, expect, it } from 'vitest'
import { LOCAL_SERVER_ID, resourceKey } from '@clave/contract/fleet'
import type { MachineProviderConnections } from '../store/provider-connections-store'
import { sessionConnection } from './session-connection'

const machine = (connections: { id: string; label: string }[]): MachineProviderConnections =>
  ({ connections, loading: false, error: null }) as unknown as MachineProviderConnections

describe('the connection a Pi or OpenCode tab names (PRDCT-4427)', () => {
  const tab = { id: 's1', opencodeMode: true, connectionId: 'c1', connectionLabel: 'Kimi' }

  it('reads the store’s current label on the tab’s own machine', () => {
    expect(
      sessionConnection(tab, { [LOCAL_SERVER_ID]: machine([{ id: 'c1', label: 'Kimi work' }]) })
    ).toEqual({ id: 'c1', label: 'Kimi work' })
  })

  it('else the label the record kept, else Removed connection', () => {
    expect(sessionConnection(tab, {})).toEqual({ id: 'c1', label: 'Kimi' })
    expect(sessionConnection(tab, { [LOCAL_SERVER_ID]: machine([]) })).toEqual({
      id: 'c1',
      label: 'Kimi'
    })
    expect(sessionConnection({ ...tab, connectionLabel: undefined }, {})).toEqual({
      id: 'c1',
      label: 'Removed connection'
    })
  })

  it('a server tab reads that server’s list, never this Mac’s', () => {
    const remote = { ...tab, id: resourceKey('session', 'srv1', 's1') }
    const byMachine = {
      [LOCAL_SERVER_ID]: machine([{ id: 'c1', label: 'Mac Kimi' }]),
      srv1: machine([{ id: 'c1', label: 'Server Kimi' }])
    }
    expect(sessionConnection(remote, byMachine)?.label).toBe('Server Kimi')
  })

  it('names none for a tab on no connection, or for a tab that is not Pi or OpenCode', () => {
    expect(sessionConnection({ id: 's2', piMode: true }, {})).toBeNull()
    expect(
      sessionConnection({ id: 's3', connectionId: 'c1', connectionLabel: 'Kimi' }, {})
    ).toBeNull()
    expect(sessionConnection({ ...tab, opencodeMode: false, piMode: true }, {})?.label).toBe('Kimi')
    expect(sessionConnection(undefined, {})).toBeNull()
  })
})
