import { describe, expect, it } from 'vitest'
import { MOBILE_RELAY_STATES, type MobileRelayStatus } from '../../../shared/mobile-relay-types'
import { RELAY_STATE_LABELS, relayStateSentence, relayStateTone } from './mobile-relay'

const status = (state: MobileRelayStatus['state']): MobileRelayStatus => ({
  state,
  relay: null,
  machineId: null,
  since: 0,
  lastFailure: null
})

describe('Settings → Mobile, the relay state in words (issue #407)', () => {
  it('names every state and says what it means', () => {
    for (const state of MOBILE_RELAY_STATES) {
      expect(RELAY_STATE_LABELS[state]).toBeTruthy()
      expect(relayStateSentence(status(state), 'https://relay.example.com')).toMatch(/\.$/)
    }
  })
  it('is green connected, red refused, amber on the way and quiet off', () => {
    expect(relayStateTone('connected')).toBe('connected')
    expect(relayStateTone('refused')).toBe('error')
    expect(relayStateTone('waiting')).toBe('connecting')
    expect(relayStateTone('claiming')).toBe('connecting')
    expect(relayStateTone('off')).toBeUndefined()
  })
  it('says off differently with and without a saved address', () => {
    expect(relayStateSentence(status('off'), '')).toMatch(/No relay address/)
    expect(relayStateSentence(status('off'), 'https://relay.example.com')).toMatch(/not running/)
  })
})
