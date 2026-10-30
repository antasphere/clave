import type { KeyValueStore } from '../chat/drafts'
import { EnrollmentClient } from '../enroll/client'
import type { CredentialStore } from '../machines/types'
import type { BuildKind } from '../machines/transport-policy'
import { clearDeviceToken, pushTokenKey } from './token'

export const PUSH_CLEANUP_KEY = 'clave.pending-push-cleanup'
export interface OwnerPushWork {
  /** Shared by services for this owner; never retains credential or token results. */
  tail: Promise<void>
  /** Invalidates approvals captured before a same-owner road reset. */
  roadGeneration: number
}
interface PendingCleanup {
  readonly refs: string[]
  readonly legacyMachineIds: string[]
}
export interface PushCleanupResult {
  /** Null when local storage prevented enumerating or recording cleanup. */
  readonly pending: number | null
  readonly retryRecorded: boolean
}
interface CleanupOwner {
  readonly kv: KeyValueStore
  readonly credentials: CredentialStore
  /** Separate encrypted owner namespace; never an active machine pairing. */
  readonly cleanupCredentials: CredentialStore
  readonly build: BuildKind
}

async function readPending(kv: KeyValueStore): Promise<PendingCleanup> {
  const raw = await kv.getItem(PUSH_CLEANUP_KEY)
  if (!raw) return { refs: [], legacyMachineIds: [] }
  const parsed: unknown = JSON.parse(raw)
  // Migrate the earlier pending-machine list before an active pairing disappears.
  if (Array.isArray(parsed) && parsed.every((id) => typeof id === 'string' && id))
    return { refs: [], legacyMachineIds: parsed }
  if (
    parsed &&
    typeof parsed === 'object' &&
    'v' in parsed &&
    parsed.v === 2 &&
    'refs' in parsed &&
    Array.isArray(parsed.refs) &&
    parsed.refs.every((ref) => typeof ref === 'string' && /^push-cleanup-[a-z0-9-]+$/.test(ref))
  )
    return { refs: [...new Set<string>(parsed.refs)], legacyMachineIds: [] }
  throw new Error('Notification cleanup could not be read.')
}

export async function pendingPushCleanup(kv: KeyValueStore): Promise<readonly string[]> {
  const pending = await readPending(kv)
  return [...pending.refs, ...pending.legacyMachineIds]
}

async function savePending(kv: KeyValueStore, refs: readonly string[]): Promise<void> {
  await kv.setItem(PUSH_CLEANUP_KEY, JSON.stringify({ v: 2, refs }))
}

let sequence = 0
async function retainCredential(
  owner: CleanupOwner,
  credential: NonNullable<Awaited<ReturnType<CredentialStore['get']>>>
): Promise<string> {
  let id: string
  do {
    id =
      'push-cleanup-' +
      Date.now().toString(36) +
      '-' +
      (++sequence).toString(36) +
      '-' +
      Math.random().toString(36).slice(2)
  } while (await owner.cleanupCredentials.get(id))
  await owner.cleanupCredentials.set(id, credential)
  return id
}

/** Persist immutable old-road credentials BEFORE any active pairing is forgotten.
 * Only opaque references enter key-value storage. */
async function capture(machineIds: readonly string[], owner: CleanupOwner): Promise<string[]> {
  const saved = await readPending(owner.kv)
  const pending = [...saved.refs]
  const active = new Set([...saved.legacyMachineIds, ...machineIds])
  for (const machineId of active) {
    const credential = await owner.credentials.get(machineId)
    if (!credential) throw new Error('Notification cleanup credentials are unavailable.')
    let retained = false
    for (const ref of pending) {
      const previous = await owner.cleanupCredentials.get(ref)
      if (previous?.serverUrl === credential.serverUrl && previous.bearer === credential.bearer)
        retained = true
    }
    if (!retained) pending.push(await retainCredential(owner, credential))
  }
  await savePending(owner.kv, pending)
  // A later pairing or same-owner login must register again, even after offline cleanup.
  for (const machineId of active) await owner.kv.removeItem(pushTokenKey(machineId))
  return pending
}

/** Receives immutable owner stores, never the current hub account. A new road
 * or a replacement pairing cannot change the credential of a pending clear. */
export async function clearPushRegistrations(
  machineIds: readonly string[],
  owner: CleanupOwner
): Promise<PushCleanupResult> {
  const captured = await capture(machineIds, owner)
  const results = await Promise.all(
    captured.map(async (ref) => {
      try {
        const credential = await owner.cleanupCredentials.get(ref)
        if (!credential) return { ref, cleared: false }
        await clearDeviceToken(
          { machineId: ref, bearer: credential.bearer },
          {
            kv: owner.kv,
            client: new EnrollmentClient(credential.serverUrl, {
              build: owner.build,
              timeoutMs: 3000
            })
          }
        )
        return { ref, cleared: true }
      } catch {
        return { ref, cleared: false }
      }
    })
  )
  const pending = results.filter((result) => !result.cleared).map((result) => result.ref)
  if (pending.length) await savePending(owner.kv, pending)
  else await owner.kv.removeItem(PUSH_CLEANUP_KEY)
  // Commit the pending list before discarding acknowledged encrypted context.
  for (const { ref, cleared } of results) if (cleared) await owner.cleanupCredentials.remove(ref)
  return { pending: pending.length, retryRecorded: true }
}
