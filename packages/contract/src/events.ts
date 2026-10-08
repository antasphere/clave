/**
 * The event envelope: what the server tells every attached client, as it
 * happens, over the push channel. Each domain adds its own members to
 * `ServerEvent`; the envelope around them is one shape for all.
 *
 * The sessions domain's events replace what the shell used to send to one
 * window at a time: a session's state, the title its first message earned,
 * the plan its agent wrote, the conversation it cleared. Every attached
 * client hears them, and a window keeps the ones about its own sessions.
 */
import { Schema } from 'effect'
import { Client } from './clients'
import { AgentState } from './sessions'
import { SettingsEvent } from './settings'
import { SidebarEvent } from './sidebar/layout'

export const ServerEvent = Schema.Union(
  // ── Clients ──
  Schema.TaggedStruct('client.registered', { client: Client }),
  Schema.TaggedStruct('client.unregistered', { id: Schema.String }),
  // ── Sessions (lane A) ──
  Schema.TaggedStruct('session.state_changed', { id: Schema.String, state: AgentState }),
  /** The tab's name, earned from its first message. */
  Schema.TaggedStruct('session.title_changed', { id: Schema.String, title: Schema.String }),
  /** The agent wrote a plan; `path` is where it is on the shell's disk. */
  Schema.TaggedStruct('session.plan_detected', { id: Schema.String, path: Schema.String }),
  /** The conversation was cleared; `providerSessionId` is the conversation
   *  the tab follows from now on, null when the provider rotated to none. */
  Schema.TaggedStruct('session.cleared', {
    id: Schema.String,
    providerSessionId: Schema.NullOr(Schema.String)
  }),
  // ── Lane D: settings (accounts, usage, workspaces) ──
  ...SettingsEvent.members,
  // ── Lane C: the sidebar (a window's layout changed or went with its window) ──
  ...SidebarEvent.members
  // ── Lane B: terminals ──
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
