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
import { AccountOverride, AgentState, SessionPage } from './sessions'
import { SettingsEvent } from './settings'
import { SidebarEvent } from './sidebar/layout'
import { WorkspaceFilesEvent } from './workspace-files/model'

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
  ...SidebarEvent.members,
  // ── Wave 3, lane A: the workspace files (a watched file changed, a review needed) ──
  ...WorkspaceFilesEvent.members,
  // ── Wave 4, lane D: what the served agent tools did to a session, for the windows ──
  /** The tab was renamed by the person or an agent; the name is protected
   *  from the auto-title from now on. */
  Schema.TaggedStruct('session.renamed', { id: Schema.String, name: Schema.String }),
  /** The page on the tab's row changed, with the session serving it (null
   *  when the page needs none, or when the page was taken off). */
  Schema.TaggedStruct('session.page_changed', {
    id: Schema.String,
    page: Schema.NullOr(SessionPage),
    servingSessionId: Schema.NullOr(Schema.String)
  }),
  /** Another tab's agent typed a message into this one (`from` is its name,
   *  null when it had none): the window marks the row so the message is
   *  never silent. */
  Schema.TaggedStruct('session.typed', { id: Schema.String, from: Schema.NullOr(Schema.String) }),
  /** The tab was restarted on another account under the same id: the window
   *  remounts its pane and shows the account. */
  Schema.TaggedStruct('session.restarted', {
    id: Schema.String,
    resumed: Schema.Boolean,
    account: AccountOverride
  }),
  /** A pinned group was launched by an agent through the server: the group
   *  with that id in that window is the pin's live group from now on. */
  Schema.TaggedStruct('pinned_group.launched', {
    pinnedId: Schema.String,
    groupId: Schema.String,
    windowKey: Schema.String
  })
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
