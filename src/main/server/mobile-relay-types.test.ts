import { describe, expect, it } from 'vitest'
import * as D from '@clave/contract/devices'
import { MOBILE_RELAY_STATES, type MobileRelayStatus } from '../../shared/mobile-relay-types'

describe('the renderer copy of the relay status (issue #407)', () => {
  it('names the states the contract names, in the same order', () => {
    expect([...MOBILE_RELAY_STATES]).toEqual([...D.MobileRelayState.literals])
  })
  it('has the contract’s shape both ways', () => {
    const fromContract: MobileRelayStatus = {} as D.MobileRelayStatus
    const toContract: D.MobileRelayStatus = {} as MobileRelayStatus
    expect([fromContract, toContract]).toHaveLength(2)
    expect(Object.keys(D.MobileRelayStatus.fields).sort()).toEqual(
      ['lastFailure', 'machineId', 'relay', 'since', 'state'].sort()
    )
  })
})
