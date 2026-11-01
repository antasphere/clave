import type { ClaveServerClient } from '../api/client'
import type { Drafts, KeyValueStore } from '../chat/drafts'
import { attachmentDraftKey } from '../attachments/drafts'
import type { SendOutcome } from '../chat/send'
import { DeliveryMarks, UnknownSends, type UnknownSend } from './ledger'
import { reconnectPass, recordUnknownSend, settleSend } from './pass'

export class DeliveryController {
  private readonly active = new Set<string>()
  private readonly reconnecting = new Map<string, Promise<void>>()
  constructor(
    readonly sends: UnknownSends,
    readonly marks: DeliveryMarks,
    private readonly drafts: Drafts,
    private readonly kv: KeyValueStore
  ) {}

  private clearAttachments = async (send: UnknownSend): Promise<void> => {
    const key = attachmentDraftKey(send.machineId, send.sessionId)
    if ((await this.kv.getItem(key)) === JSON.stringify(send.attachments ?? []))
      await this.kv.removeItem(key)
  }

  async begin(send: UnknownSend): Promise<void> {
    this.active.add(send.clientMessageId)
    try {
      await recordUnknownSend(send, 'Delivery has not been confirmed.', this)
    } catch (error) {
      this.active.delete(send.clientMessageId)
      throw error
    }
  }

  async finish(send: UnknownSend, outcome: SendOutcome): Promise<void> {
    try {
      await settleSend(send, outcome, {
        clearAttachments: this.clearAttachments,
        sends: this.sends,
        marks: this.marks,
        drafts: this.drafts,
        now: Date.now
      })
      if (outcome.kind === 'failed') {
        await this.sends.remove(send.clientMessageId)
        await this.marks.clear(send.machineId, send.sessionId)
      }
    } finally {
      this.active.delete(send.clientMessageId)
    }
  }

  reconnect(input: {
    machineId: string
    client: ClaveServerClient
    openConversations: readonly { sessionId: string }[]
    refreshRequests: (machineId: string) => Promise<void>
    refreshHistory: (machineId: string, sessionId: string) => Promise<void>
  }): Promise<void> {
    const previous = this.reconnecting.get(input.machineId)
    if (previous) return previous
    const run = reconnectPass(input, {
      clearAttachments: this.clearAttachments,
      sends: this.sends,
      marks: this.marks,
      drafts: this.drafts,
      isActive: (send) => this.active.has(send.clientMessageId),
      status: (send) => input.client.sessions.writeStatus(send.sessionId, send.clientMessageId),
      write: (send) =>
        input.client.sessions.write(send.sessionId, {
          type: 'user_message',
          text: send.text,
          clientMessageId: send.clientMessageId,
          ...(send.attachments?.length ? { attachments: send.attachments } : {})
        }),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: Date.now,
      refreshRequests: input.refreshRequests,
      refreshHistory: input.refreshHistory
    })
      .then(() => {})
      .finally(() => {
        this.reconnecting.delete(input.machineId)
      })
    this.reconnecting.set(input.machineId, run)
    return run
  }
}
