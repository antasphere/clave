/**
 * The pairing as a state machine (decision 3 of the spec, lane A's routes):
 * the phone asks with its ID token and its client id, waits while the owner
 * approves or refuses it on the Mac (Settings → Mobile), polling every two
 * seconds, and on the approval takes the device session the server hands
 * out once: the credential goes to lane C's credential store under the
 * machine id, with the machine's road as the server URL, and the record of
 * the pairing (the device id, the server's id and name) to the enrollment
 * records. A refusal, a lapse and a failure are said plainly as states, so
 * a screen renders each; nothing is retried on its own.
 *
 * Pure over its ports: the client, the two stores, the clock and the sleep,
 * so every branch runs under Node against a stub of the routes.
 */
import type { CredentialStore, Machine } from '../machines/types'
import {
  EnrollmentClient,
  EnrollmentError,
  type DeviceDescription,
  type EnrollmentFailure
} from './client'
import type { EnrollmentRecord, EnrollmentRecords } from './records'

export type PairingState =
  | { readonly kind: 'requesting' }
  | {
      readonly kind: 'waiting'
      readonly pairingId: string
      readonly expiresAt: number
      /** How many times the server was asked so far. */
      readonly polls: number
    }
  | { readonly kind: 'approved'; readonly record: EnrollmentRecord }
  | { readonly kind: 'refused' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'cancelled' }
  | {
      readonly kind: 'failed'
      readonly failure: EnrollmentFailure
      readonly message: string
      readonly check?: string
    }

export interface PairingInput {
  readonly machine: Pick<Machine, 'id' | 'baseUrl'>
  readonly idToken: string
  readonly clientId: string
  readonly device: DeviceDescription
}

export interface PairingPorts {
  readonly client: EnrollmentClient
  readonly credentials: CredentialStore
  readonly records: EnrollmentRecords
  readonly sleep: (ms: number) => Promise<void>
  readonly now: () => number
  /** Every state as it happens, for the screen. */
  readonly onState?: (state: PairingState) => void
  /** The person left the screen: polling stops at the next step. */
  readonly cancelled?: () => boolean
}

export interface PairingOptions {
  /** Between two reads of the pairing; two seconds, lane A's figure. */
  readonly pollMs?: number
  /** Past the server's own deadline, how long a still-pending answer is
   *  believed before the pairing is read as lapsed here. */
  readonly graceMs?: number
}

export const POLL_MS = 2_000
const GRACE_MS = 60_000

const failed = (error: unknown): PairingState =>
  error instanceof EnrollmentError
    ? { kind: 'failed', failure: error.kind, message: error.message, check: error.check }
    : {
        kind: 'failed',
        failure: 'protocol',
        message: error instanceof Error ? error.message : String(error)
      }

const transient = (error: unknown): boolean =>
  error instanceof EnrollmentError && (error.kind === 'network' || error.kind === 'timeout')

export async function pair(
  input: PairingInput,
  ports: PairingPorts,
  options: PairingOptions = {}
): Promise<PairingState> {
  const pollMs = options.pollMs ?? POLL_MS
  const graceMs = options.graceMs ?? GRACE_MS
  const emit = (state: PairingState): PairingState => {
    ports.onState?.(state)
    return state
  }
  const cancelled = (): boolean => ports.cancelled?.() === true

  emit({ kind: 'requesting' })
  let ticket
  try {
    ticket = await ports.client.requestPairing({
      idToken: input.idToken,
      clientId: input.clientId,
      device: input.device
    })
  } catch (error) {
    return emit(failed(error))
  }
  let polls = 0
  emit({ kind: 'waiting', pairingId: ticket.pairingId, expiresAt: ticket.expiresAt, polls })
  for (;;) {
    if (cancelled()) return emit({ kind: 'cancelled' })
    await ports.sleep(pollMs)
    if (cancelled()) return emit({ kind: 'cancelled' })
    polls += 1
    let read
    try {
      read = await ports.client.readPairing(ticket.pairingId)
    } catch (error) {
      // The network, not the server: the owner may still be about to
      // answer, so the wait goes on until the server's own deadline.
      if (transient(error) && ports.now() <= ticket.expiresAt + graceMs) {
        emit({ kind: 'waiting', pairingId: ticket.pairingId, expiresAt: ticket.expiresAt, polls })
        continue
      }
      return emit(failed(error))
    }
    switch (read.status) {
      case 'pending':
        if (ports.now() > ticket.expiresAt + graceMs) return emit({ kind: 'expired' })
        emit({ kind: 'waiting', pairingId: ticket.pairingId, expiresAt: ticket.expiresAt, polls })
        continue
      case 'refused':
        return emit({ kind: 'refused' })
      case 'expired':
        return emit({ kind: 'expired' })
      case 'approved': {
        const session = read.deviceSession
        if (!session)
          return emit({
            kind: 'failed',
            failure: 'consumed',
            message: 'The approval was already handed out and cannot be read again. Pair again.'
          })
        await ports.credentials.set(input.machine.id, {
          serverUrl: input.machine.baseUrl,
          bearer: session.token
        })
        const record: EnrollmentRecord = {
          machineId: input.machine.id,
          deviceId: session.deviceId,
          serverId: session.serverId,
          serverName: session.serverName,
          pairedAt: ports.now()
        }
        await ports.records.set(record)
        return emit({ kind: 'approved', record })
      }
    }
  }
}
