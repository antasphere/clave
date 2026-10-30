/**
 * What the phone keeps about sends whose outcome it never saw (decision 10
 * of the spec, the write-status seam of 29 October 2026): the id the phone
 * minted, the session, and the text sent under it, so that a reconnection
 * can ask the server about exactly that id and, when the server says it
 * never arrived, complete the same send with the same bytes. The ledger is
 * a JSON list in the key-value store (AsyncStorage on the phone, a Map in
 * the tests), so it survives a restart as the drafts do. Beside it, one
 * delivery mark per conversation says what the composer shows above the
 * draft: delivery unknown with the person's choice, or rejected with the
 * reason.
 */
import type { KeyValueStore } from '../chat/drafts'
import type { Attachment } from '../contract/types'

export interface UnknownSend {
  readonly machineId: string
  readonly sessionId: string
  readonly clientMessageId: string
  /** The text as sent, so a resend the server asks for is the same bytes. */
  readonly text: string
  readonly at: number
  readonly draftText?: string
  readonly attachments?: readonly Attachment[]
}

export const UNKNOWN_SENDS_KEY = 'clave.unknown-sends'

const isSend = (value: unknown): value is UnknownSend =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as UnknownSend).machineId === 'string' &&
  typeof (value as UnknownSend).sessionId === 'string' &&
  typeof (value as UnknownSend).clientMessageId === 'string' &&
  typeof (value as UnknownSend).text === 'string'

export class UnknownSends {
  private writing: Promise<void> = Promise.resolve()

  private mutate(change: () => Promise<void>): Promise<void> {
    const next = this.writing.then(change)
    this.writing = next.catch(() => {})
    return next
  }
  constructor(private readonly store: KeyValueStore) {}

  async list(): Promise<UnknownSend[]> {
    const raw = await this.store.getItem(UNKNOWN_SENDS_KEY)
    if (!raw) return []
    try {
      const parsed: unknown = JSON.parse(raw)
      return Array.isArray(parsed)
        ? parsed.filter(isSend).map((s) => ({ ...s, at: typeof s.at === 'number' ? s.at : 0 }))
        : []
    } catch {
      return []
    }
  }

  async forMachine(machineId: string): Promise<UnknownSend[]> {
    return (await this.list()).filter((s) => s.machineId === machineId)
  }

  async forSession(machineId: string, sessionId: string): Promise<UnknownSend[]> {
    return (await this.list()).filter((s) => s.machineId === machineId && s.sessionId === sessionId)
  }

  /** Keeps the send, replacing one of the same id. */
  add(send: UnknownSend): Promise<void> {
    return this.mutate(async () => {
      const others = (await this.list()).filter((s) => s.clientMessageId !== send.clientMessageId)
      await this.write([...others, send])
    })
  }

  remove(clientMessageId: string): Promise<void> {
    return this.mutate(async () => {
      await this.write((await this.list()).filter((s) => s.clientMessageId !== clientMessageId))
    })
  }

  private async write(sends: UnknownSend[]): Promise<void> {
    if (sends.length === 0) await this.store.removeItem(UNKNOWN_SENDS_KEY)
    else await this.store.setItem(UNKNOWN_SENDS_KEY, JSON.stringify(sends))
  }
}

export interface DeliveryMark {
  readonly kind: 'unknown' | 'rejected'
  readonly clientMessageId: string
  readonly reason: string
  readonly at: number
}

export const deliveryMarkKey = (machineId: string, sessionId: string): string =>
  `clave.delivery:${machineId}:${sessionId}`

export class DeliveryMarks {
  private readonly listeners = new Set<() => void>()
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private changed(): void {
    for (const listener of this.listeners) listener()
  }
  constructor(private readonly store: KeyValueStore) {}

  async get(machineId: string, sessionId: string): Promise<DeliveryMark | null> {
    const raw = await this.store.getItem(deliveryMarkKey(machineId, sessionId))
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as Partial<DeliveryMark>
      if (
        (parsed.kind === 'unknown' || parsed.kind === 'rejected') &&
        typeof parsed.clientMessageId === 'string'
      )
        return {
          kind: parsed.kind,
          clientMessageId: parsed.clientMessageId,
          reason: typeof parsed.reason === 'string' ? parsed.reason : '',
          at: typeof parsed.at === 'number' ? parsed.at : 0
        }
    } catch {
      /* an unreadable mark is no mark */
    }
    return null
  }

  async set(machineId: string, sessionId: string, mark: DeliveryMark): Promise<void> {
    await this.store.setItem(deliveryMarkKey(machineId, sessionId), JSON.stringify(mark))
    this.changed()
  }

  async clear(machineId: string, sessionId: string): Promise<void> {
    await this.store.removeItem(deliveryMarkKey(machineId, sessionId))
    this.changed()
  }
}
