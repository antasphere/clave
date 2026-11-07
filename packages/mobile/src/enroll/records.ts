/**
 * What the phone keeps of a pairing beside the credential: the device id the
 * server gave it, the server's id and name, and when. The credential itself
 * (the device session as the bearer, with the machine's road) lives in lane
 * C's credential store under the machine id (`machines/credentials.ts`);
 * this file holds the record that lets a notification, which names a
 * server, find the machine the phone reaches it through. One JSON list in
 * the key-value store (AsyncStorage on the phone, a Map in the tests).
 */
import type { KeyValueStore } from '../chat/drafts'

export interface EnrollmentRecord {
  readonly machineId: string
  readonly deviceId: string
  readonly serverId: string
  readonly serverName: string
  readonly pairedAt: number
}

export const ENROLLMENTS_KEY = 'clave.enrollments'

const isRecord = (value: unknown): value is EnrollmentRecord =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as EnrollmentRecord).machineId === 'string' &&
  typeof (value as EnrollmentRecord).deviceId === 'string' &&
  typeof (value as EnrollmentRecord).serverId === 'string'

export class EnrollmentRecords {
  private writing: Promise<void> = Promise.resolve()

  private mutate(change: () => Promise<void>): Promise<void> {
    const next = this.writing.then(change)
    this.writing = next.catch(() => {})
    return next
  }
  constructor(private readonly store: KeyValueStore) {}

  async list(): Promise<EnrollmentRecord[]> {
    const raw = await this.store.getItem(ENROLLMENTS_KEY)
    if (!raw) return []
    try {
      const parsed: unknown = JSON.parse(raw)
      return Array.isArray(parsed)
        ? parsed.filter(isRecord).map((r) => ({
            machineId: r.machineId,
            deviceId: r.deviceId,
            serverId: r.serverId,
            serverName: typeof r.serverName === 'string' ? r.serverName : '',
            pairedAt: typeof r.pairedAt === 'number' ? r.pairedAt : 0
          }))
        : []
    } catch {
      return []
    }
  }

  async get(machineId: string): Promise<EnrollmentRecord | null> {
    return (await this.list()).find((r) => r.machineId === machineId) ?? null
  }

  /** The machine a server is reached through: what a notification's
   *  `serverId` resolves to. The most recent pairing wins when two
   *  machines name one server (a relay road and a direct address). */
  async byServerId(serverId: string): Promise<EnrollmentRecord | null> {
    const matches = (await this.list()).filter((r) => r.serverId === serverId)
    return matches.sort((a, b) => b.pairedAt - a.pairedAt)[0] ?? null
  }

  /** Keeps the record, replacing the one of the same machine. */
  set(record: EnrollmentRecord): Promise<void> {
    return this.mutate(async () => {
      const others = (await this.list()).filter((r) => r.machineId !== record.machineId)
      await this.store.setItem(ENROLLMENTS_KEY, JSON.stringify([...others, record]))
    })
  }

  remove(machineId: string): Promise<void> {
    return this.mutate(async () => {
      const others = (await this.list()).filter((r) => r.machineId !== machineId)
      if (others.length === 0) await this.store.removeItem(ENROLLMENTS_KEY)
      else await this.store.setItem(ENROLLMENTS_KEY, JSON.stringify(others))
    })
  }
}
