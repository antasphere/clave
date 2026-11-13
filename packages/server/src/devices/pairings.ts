/**
 * The pairings in flight: a phone that proved it is the owner's and waits
 * for the owner's word. Kept in memory, ten minutes each: a server restart
 * drops them and the phone asks again. A settled pairing stays readable
 * until the same deadline, so the phone can read the answer; an approved
 * one carries the device session exactly once, consumed by the first read.
 */
import { randomUUID } from 'node:crypto'
import type {
  DeviceDescription,
  DeviceSessionView,
  PairingStatus,
  PendingPairingView
} from '@clave/contract/devices'

export const PAIRING_TTL_MS = 10 * 60 * 1000
/** More phones than this waiting at once, and the next one is told to try later. */
export const MAX_PENDING_PAIRINGS = 32

interface Pairing {
  readonly id: string
  readonly subject: string
  readonly device: DeviceDescription
  readonly requestedAt: number
  readonly expiresAt: number
  status: 'pending' | 'approved' | 'refused'
  /** The session, until the phone has read it. */
  deviceSession: DeviceSessionView | null
}

export class PairingDesk {
  private readonly pairings = new Map<string, Pairing>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = PAIRING_TTL_MS
  ) {}

  /** A proven phone asks; null when too many are waiting already. */
  request(
    subject: string,
    device: DeviceDescription
  ): { pairingId: string; expiresAt: number } | null {
    this.sweep()
    // Every account's waiting pairings count against the bound, not only one owner's view.
    const waiting = [...this.pairings.values()].filter(
      (pairing) => pairing.status === 'pending' && this.now() < pairing.expiresAt
    ).length
    if (waiting >= MAX_PENDING_PAIRINGS) return null
    const requestedAt = this.now()
    const pairing: Pairing = {
      id: `pair-${randomUUID()}`,
      subject,
      device,
      requestedAt,
      expiresAt: requestedAt + this.ttlMs,
      status: 'pending',
      deviceSession: null
    }
    this.pairings.set(pairing.id, pairing)
    return { pairingId: pairing.id, expiresAt: pairing.expiresAt }
  }

  /** Where a pairing stands; the session once, on the first read after the approval. */
  read(
    id: string,
    owner: string | null
  ): { status: PairingStatus; deviceSession?: DeviceSessionView } {
    this.sweep()
    const pairing = this.pairings.get(id)
    if (!pairing) return { status: 'expired' }
    if (pairing.status === 'pending')
      return { status: this.now() >= pairing.expiresAt ? 'expired' : 'pending' }
    // The session is handed out only while the account that asked is the one signed in:
    // otherwise it waits, kept, for that account to come back (PRDCT-4448).
    if (pairing.status === 'approved' && pairing.deviceSession && pairing.subject !== owner)
      return { status: 'pending' }
    if (pairing.status === 'approved' && pairing.deviceSession) {
      const deviceSession = pairing.deviceSession
      pairing.deviceSession = null
      return { status: 'approved', deviceSession }
    }
    return { status: pairing.status }
  }

  /** The pairings waiting for `owner`'s word: another account's or nobody's are not listed. */
  pending(owner: string | null): PendingPairingView[] {
    this.sweep()
    const now = this.now()
    return [...this.pairings.values()]
      .filter(
        (pairing) =>
          pairing.status === 'pending' && now < pairing.expiresAt && pairing.subject === owner
      )
      .map((pairing) => ({
        id: pairing.id,
        name: pairing.device.name,
        platform: pairing.device.platform,
        appVersion: pairing.device.appVersion,
        requestedAt: pairing.requestedAt,
        expiresAt: pairing.expiresAt
      }))
  }

  /** Approve a pending pairing: `issue` mints the device and its token, and
   *  the session is put on the pairing for the phone's next read. Undefined
   *  when the pairing is not pending (unknown, settled, or lapsed). */
  approve<D extends { readonly id: string }>(
    id: string,
    issue: (device: DeviceDescription, subject: string) => { device: D; token: string },
    server: { id: string; name: string },
    owner: string | null
  ): D | undefined {
    const pairing = this.livePending(id)
    // Only the account that asked approves it: another one signed in since, or nobody,
    // finds nothing waiting (PRDCT-4448).
    if (!pairing || pairing.subject !== owner) return undefined
    const { device, token } = issue(pairing.device, pairing.subject)
    pairing.status = 'approved'
    pairing.deviceSession = {
      token,
      deviceId: device.id,
      serverId: server.id,
      serverName: server.name
    }
    return device
  }

  refuse(id: string): boolean {
    const pairing = this.livePending(id)
    if (!pairing) return false
    pairing.status = 'refused'
    return true
  }

  private livePending(id: string): Pairing | undefined {
    this.sweep()
    const pairing = this.pairings.get(id)
    return pairing && pairing.status === 'pending' && this.now() < pairing.expiresAt
      ? pairing
      : undefined
  }

  /** A pairing is forgotten one lifetime after its deadline. */
  private sweep(): void {
    const now = this.now()
    for (const [id, pairing] of this.pairings)
      if (now >= pairing.expiresAt + this.ttlMs) this.pairings.delete(id)
  }
}
