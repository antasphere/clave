import type { KeyValueStore } from '../chat/drafts'
import { EnrollmentClient } from '../enroll/client'
import type { CredentialStore } from '../machines/types'
import type { BuildKind } from '../machines/transport-policy'
import { clearDeviceToken } from './token'

export const PUSH_CLEANUP_KEY = 'clave.pending-push-cleanup'
export interface PushCleanupResult {
  /** Null when local storage prevented enumerating or recording cleanup. */
  readonly pending: number | null
  readonly retryRecorded: boolean
}

export async function pendingPushCleanup(kv: KeyValueStore): Promise<string[]> {
  const raw = await kv.getItem(PUSH_CLEANUP_KEY)
  if (!raw) return []
  const ids: unknown = JSON.parse(raw)
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string' && id.length > 0))
    throw new Error('Notification cleanup could not be read.')
  return [...new Set(ids as string[])]
}

/** Receives immutable owner stores, never the current hub account. Each
 * request uses only that owner's captured device credential. Drafts stay put. */
export async function clearPushRegistrations(
  machineIds: readonly string[],
  owner: { kv: KeyValueStore; credentials: CredentialStore; build: BuildKind }
): Promise<PushCleanupResult> {
  const captured = await Promise.all(
    [...new Set(machineIds)].map(async (machineId) => ({
      machineId,
      credential: await owner.credentials.get(machineId)
    }))
  )
  await owner.kv.setItem(
    PUSH_CLEANUP_KEY,
    JSON.stringify(captured.map((target) => target.machineId))
  )
  const failed = await Promise.all(
    captured.map(async ({ machineId, credential }) => {
      if (!credential) return machineId
      try {
        await clearDeviceToken(
          { machineId, bearer: credential.bearer },
          {
            kv: owner.kv,
            client: new EnrollmentClient(credential.serverUrl, {
              build: owner.build,
              timeoutMs: 3000
            })
          }
        )
        return null
      } catch {
        return machineId
      }
    })
  )
  const pending = failed.filter((id): id is string => id !== null)
  if (pending.length) await owner.kv.setItem(PUSH_CLEANUP_KEY, JSON.stringify(pending))
  else await owner.kv.removeItem(PUSH_CLEANUP_KEY)
  return { pending: pending.length, retryRecorded: true }
}
