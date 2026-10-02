/**
 * The event envelope: what the server tells every attached client, as it
 * happens, over the push channel. Each domain adds its own members to
 * `ServerEvent`; the envelope around them is one shape for all.
 */
import { Schema } from 'effect'
import { Client } from './clients'
import { AgentState } from './sessions'

export const ServerEvent = Schema.Union(
  Schema.TaggedStruct('client.registered', { client: Client }),
  Schema.TaggedStruct('client.unregistered', { id: Schema.String }),
  Schema.TaggedStruct('session.state_changed', { id: Schema.String, state: AgentState })
)
export type ServerEvent = typeof ServerEvent.Type

export const ServerEventEnvelope = Schema.Struct({
  /** Unique per event, minted by the server. */
  id: Schema.String,
  /** The server's own order, from 1, so a client can tell what it missed. */
  seq: Schema.Number,
  /** Epoch milliseconds, the server's clock. */
  at: Schema.Number,
  event: ServerEvent
})
export type ServerEventEnvelope = typeof ServerEventEnvelope.Type
