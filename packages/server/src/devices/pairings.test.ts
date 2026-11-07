/** The pairings in flight, against a clock the test turns. */
import { describe, expect, it } from 'vitest'
import { MAX_PENDING_PAIRINGS, PAIRING_TTL_MS, PairingDesk } from './pairings'

const PHONE = { name: 'A phone', platform: 'ios' as const, appVersion: '0.1.0' }
const SERVER = { id: 'srv', name: 'mac' }
let minted = 0
const issue = (): { device: { id: string }; token: string } => ({
  device: { id: `dev-${++minted}` },
  token: `token-${minted}`
})

describe('the pairing desk', () => {
  it('answers pending, then approved once with the session, then approved without it', () => {
    const clock = { now: 0 }
    const desk = new PairingDesk(() => clock.now)
    const { pairingId, expiresAt } = desk.request('user', PHONE)!
    expect(expiresAt).toBe(PAIRING_TTL_MS)
    expect(desk.read(pairingId)).toEqual({ status: 'pending' })
    expect(desk.pending()).toMatchObject([{ id: pairingId, ...PHONE, requestedAt: 0 }])
    const device = desk.approve(pairingId, issue, SERVER)
    expect(device).toMatchObject({ id: expect.stringMatching(/^dev-/) })
    expect(desk.pending()).toEqual([])
    const first = desk.read(pairingId)
    expect(first.status).toBe('approved')
    expect(first.deviceSession).toMatchObject({
      deviceId: device!.id,
      serverId: 'srv',
      serverName: 'mac'
    })
    expect(desk.read(pairingId)).toEqual({ status: 'approved' })
    expect(desk.approve(pairingId, issue, SERVER)).toBeUndefined()
    expect(desk.refuse(pairingId)).toBe(false)
  })
  it('reads refused after a refusal, expired after ten minutes, and forgets the record later', () => {
    const clock = { now: 0 }
    const desk = new PairingDesk(() => clock.now)
    const refused = desk.request('user', PHONE)!.pairingId
    expect(desk.refuse(refused)).toBe(true)
    expect(desk.read(refused)).toEqual({ status: 'refused' })
    const lapsed = desk.request('user', PHONE)!.pairingId
    clock.now = PAIRING_TTL_MS - 1
    expect(desk.read(lapsed)).toEqual({ status: 'pending' })
    expect(desk.pending()).toMatchObject([{ id: lapsed }])
    clock.now = PAIRING_TTL_MS
    expect(desk.read(lapsed)).toEqual({ status: 'expired' })
    expect(desk.pending()).toEqual([])
    expect(desk.approve(lapsed, issue, SERVER)).toBeUndefined()
    // Still readable as what it was, one lifetime more; then gone.
    expect(desk.read(refused)).toEqual({ status: 'refused' })
    clock.now = 2 * PAIRING_TTL_MS
    expect(desk.read(refused)).toEqual({ status: 'expired' })
    expect(desk.read('pair-unknown')).toEqual({ status: 'expired' })
  })
  it('turns the next phone away when too many are waiting, and takes it once one lapses', () => {
    const clock = { now: 0 }
    const desk = new PairingDesk(() => clock.now)
    for (let i = 0; i < MAX_PENDING_PAIRINGS; i++)
      expect(desk.request('user', PHONE)).not.toBeNull()
    expect(desk.request('user', PHONE)).toBeNull()
    clock.now = PAIRING_TTL_MS
    expect(desk.request('user', PHONE)).not.toBeNull()
  })
})
