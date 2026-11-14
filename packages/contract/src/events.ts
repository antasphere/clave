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
import { FilesDirsChanged } from './files'
import { AccountOverride, AgentState, SessionPage, RestartRequestId } from './sessions'
import { WorkAssignment } from './work'
import { SettingsEvent } from './settings'
import { OverviewChanged, SidebarEvent } from './sidebar/layout'
import { WorkspaceFilesEvent } from './workspace-files/model'
// ── Wave wcs1023, lane C: the git domain ──
import { GitEvent } from './git'
// ── Issue #266: the server domain ──
import { ServerUpgradeEvent } from './server-info'
// ── ADR 0004: the routines ──
import { RoutinesChanged } from './routines/model'
// ── Mobile wave, lane A: the devices (a phone paired, asking, or revoked) ──
import { DevicePairingRequested, DevicesChanged } from './devices'

export const ServerEvent = Schema.Union(
  FilesDirsChanged,
  Schema.TaggedStruct('requests.changed', { revision: Schema.Number }),
  // ── Clients ──
  Schema.TaggedStruct('client.registered', { client: Client }),
  Schema.TaggedStruct('client.unregistered', { id: Schema.String }),
  // ── Sessions (lane A) ──
  /** A session was registered. Clients reconcile their local projection;
   *  this is not a request to start or resume its provider. */
  Schema.TaggedStruct('session.registered', { id: Schema.String }),
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
  /** The session runs on `model` now, as its provider said it (the Claude
   *  CLI's init frame, a switch it took, the default resolved at ready; the
   *  Codex app-server's thread): what a window's sidebar judges the caps by
   *  (PRDCT-4256). Sent over the window's IPC too while no server runs. */
  Schema.TaggedStruct('session.model_changed', { id: Schema.String, model: Schema.String }),
  /** The session's CLI reported its account's limit and WHICH cap it hit
   *  (ADR 0002, PRDCT-4302): a shared cap, one model family's week, the org's
   *  credits, or nothing more than the refusal. The window's policy picks its
   *  rung from it. Sent over the window's IPC too while no server runs. */
  Schema.TaggedStruct('session.limit_reported', {
    id: Schema.String,
    scope: Schema.Union(
      Schema.Literal('shared'),
      Schema.Literal('credits'),
      Schema.Literal('unknown'),
      Schema.Struct({ family: Schema.String })
    ),
    resetsAt: Schema.optional(Schema.Number)
  }),
  /** The account served a turn again after the session's limit report
   *  (PRDCT-4415): the report is closed, and the window's chip and proposal
   *  with it. A turn refused again reports again. Sent over the window's IPC
   *  too while no server runs. */
  Schema.TaggedStruct('session.limit_cleared', { id: Schema.String }),
  // ── Lane D: settings (accounts, usage, workspaces) ──
  ...SettingsEvent.members,
  // ── Lane C: the sidebar (a window's layout changed or went with its window) ──
  ...SidebarEvent.members,
  // ── The phone's notice that the sidebar overview may have changed, with no payload ──
  OverviewChanged,
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
  /** A session's work assignment changed: the record's new one, or null when
   *  it belongs to no wave or lane any more. */
  Schema.TaggedStruct('session.work_changed', {
    id: Schema.String,
    work: Schema.NullOr(WorkAssignment)
  }),
  /** Another tab's agent typed a message into this one (`from` is its name,
   *  null when it had none): the window marks the row so the message is
   *  never silent. */
  Schema.TaggedStruct('session.typed', { id: Schema.String, from: Schema.NullOr(Schema.String) }),
  /** The tab is about to be restarted on another account: its process ends
   *  in a moment, and the window must not announce that end as the tab's. */
  Schema.TaggedStruct('session.restarting', { id: Schema.String }),
  /** The tab was restarted on another account under the same id: the window
   *  remounts its pane and shows the account. */
  Schema.TaggedStruct('session.restarted', {
    id: Schema.String,
    requestId: Schema.optional(RestartRequestId),
    resumed: Schema.Boolean,
    account: AccountOverride
  }),
  /** A pinned group was launched by an agent through the server: the group
   *  with that id in that window is the pin's live group from now on. */
  Schema.TaggedStruct('pinned_group.launched', {
    pinnedId: Schema.String,
    groupId: Schema.String,
    windowKey: Schema.String
  }),
  // ── Wave 5, lane C: the plugins ──
  /** The installed plugins or their running state changed; a client re-lists. */
  Schema.TaggedStruct('plugins.changed', {}),
  /** A plugin's notification, for the client that shows notifications when
   *  the server cannot. */
  Schema.TaggedStruct('plugins.notified', {
    pluginId: Schema.String,
    name: Schema.String,
    title: Schema.String,
    body: Schema.optional(Schema.String)
  }),
  // ── Wave wcs1023, lane C: the git domain (a watched repository changed on the server's disk, a batch moved) ──
  ...GitEvent.members,
  // ── Issue #266: the server's self-upgrade changed state ──
  ServerUpgradeEvent,
  // ── ADR 0004: the routines (the routines or their runs changed) ──
  RoutinesChanged,
  // ── Mobile wave, lane A: the paired phones or the pending pairings changed; a phone asked ──
  DevicesChanged,
  DevicePairingRequested
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
