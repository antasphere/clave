import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DECISIONS_NEED_UPDATE,
  type DecisionPreference
} from '../../../shared/decision-preferences'

// The Settings page's store of the decisions' switches (PRDCT-5179), the
// mirror of the helpers' store: every read and write goes to the machine the
// page names.

let store: typeof import('./decision-preferences-store')

const decision = (over: Partial<DecisionPreference> = {}): DecisionPreference => ({
  id: 'tab-project',
  label: 'Tab projects',
  description: 'Reads which project a tab works on.',
  enabled: true,
  ...over
})

const api = { fleetDecisions: vi.fn(), fleetDecisionSet: vi.fn() }

beforeAll(async () => {
  vi.stubGlobal('window', { electronAPI: api, addEventListener: () => {} })
  store = await import('./decision-preferences-store')
})
beforeEach(() => {
  api.fleetDecisions.mockReset()
  api.fleetDecisionSet.mockReset()
  store.useDecisionPreferencesStore.setState({ byMachine: {} })
})

describe('the machine the page names', () => {
  it('reads and writes that machine, and keeps its answer under it alone', async () => {
    api.fleetDecisions.mockResolvedValue([decision()])
    await store.loadDecisionPreferences('server-b')
    expect(api.fleetDecisions).toHaveBeenCalledWith('server-b')
    api.fleetDecisionSet.mockResolvedValue([decision({ enabled: false })])
    await store.setDecisionPreference('server-b', 'tab-project', { enabled: false })
    expect(api.fleetDecisionSet).toHaveBeenCalledWith('server-b', 'tab-project', {
      enabled: false
    })
    const { byMachine } = store.useDecisionPreferencesStore.getState()
    expect(Object.keys(byMachine)).toEqual(['server-b'])
    expect(byMachine['server-b']).toMatchObject({ status: 'ready', error: null })
    expect(byMachine['server-b'].decisions[0].enabled).toBe(false)
  })

  it('a refused write keeps the list and says the machine’s sentence; a raw error is not shown', async () => {
    api.fleetDecisions.mockResolvedValue([decision()])
    await store.loadDecisionPreferences('local')
    api.fleetDecisionSet.mockRejectedValue(
      new Error("Error invoking remote method 'decisions:set': Error: The switch is on or off.")
    )
    await store.setDecisionPreference('local', 'tab-project', {})
    let local = store.useDecisionPreferencesStore.getState().byMachine.local
    expect(local.decisions).toEqual([decision()])
    expect(local.error).toBe('The switch is on or off.')
    api.fleetDecisionSet.mockRejectedValue(new Error('ECONNRESET at socket.ts:12'))
    await store.setDecisionPreference('local', 'tab-project', { enabled: false })
    local = store.useDecisionPreferencesStore.getState().byMachine.local
    expect(local.error).toBe('The change did not reach the machine.')
  })

  it('an older server is said as the update it needs; a failed read says so', async () => {
    api.fleetDecisions.mockRejectedValue(new Error(`Error: ${DECISIONS_NEED_UPDATE}`))
    await store.loadDecisionPreferences('server-old')
    expect(store.useDecisionPreferencesStore.getState().byMachine['server-old']).toMatchObject({
      status: 'error',
      error: DECISIONS_NEED_UPDATE
    })
    api.fleetDecisions.mockRejectedValue(new Error('socket hang up'))
    await store.loadDecisionPreferences('server-c')
    expect(store.useDecisionPreferencesStore.getState().byMachine['server-c'].error).toBe(
      'The decisions could not be read from this machine.'
    )
  })
})
