/**
 * The plugins domain (wave 5, lane C, PRDCT-3433): the installed plugins and
 * their host, served by the server. The server owns the store (what is
 * installed, enabled and granted), the host that runs each plugin's `main`,
 * and the leases a window takes on a plugin's view. The shell keeps what
 * only a desktop app has: the folder dialog a link starts from, the OS
 * notification, the preview protocol that serves a plugin's page to a
 * window, and the report of which window and session have the focus.
 */
import { Schema } from 'effect'
import { Command, Query } from '@structure-ai/cqrs'
import { ApiGroup, HttpCqrs } from '@structure-ai/http'
import { CapabilityUnavailable } from './errors'

/** What a plugin may be granted, as its manifest declares it. */
export const PluginPermission = Schema.Literal(
  'sessions.read',
  'sessions.write',
  'fs.read',
  'fs.write',
  'net',
  'secrets',
  'shell'
)
export type PluginPermission = typeof PluginPermission.Type

/** Where a plugin came from: shipped with the app, cloned, or linked from a folder. */
export const PluginSource = Schema.Literal('bundled', 'git', 'link')
export type PluginSource = typeof PluginSource.Type

/** Where a plugin's `main` stands in the host. */
export const PluginStatus = Schema.Literal('disabled', 'starting', 'active', 'error')
export type PluginStatus = typeof PluginStatus.Type

/** Why a plugin waits for the person before it runs again. */
export const PluginReview = Schema.Literal(
  'permission-growth',
  'digest-change',
  'source-change',
  'engine-refusal'
)
export type PluginReview = typeof PluginReview.Type

/** The last notification a plugin raised. */
export const PluginNotification = Schema.Struct({
  title: Schema.String,
  body: Schema.optional(Schema.String)
})
export type PluginNotification = typeof PluginNotification.Type

/**
 * One installed plugin and its running state. Mirrors `PluginRecord` of
 * `src/main/plugins/plugin-store.ts` field by field. `manifest` is the
 * plugin SDK's parsed manifest, opaque on the wire: the renderer types it
 * through the SDK.
 */
export const PluginRecord = Schema.Struct({
  id: Schema.String,
  version: Schema.String,
  source: PluginSource,
  enabled: Schema.Boolean,
  enabledBeforeEngineRefusal: Schema.optional(Schema.Boolean),
  permissionsGranted: Schema.Array(PluginPermission),
  installedAt: Schema.String,
  directory: Schema.String,
  contentDigest: Schema.optional(Schema.String),
  reviewDigest: Schema.optional(Schema.String),
  declaredPermissions: Schema.optional(Schema.Array(Schema.String)),
  needsReview: Schema.optional(PluginReview),
  manifest: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.String),
  status: PluginStatus,
  panels: Schema.Array(Schema.String),
  commands: Schema.Array(Schema.String),
  toolbar: Schema.Array(Schema.String),
  generation: Schema.Number,
  lastNotification: Schema.optional(PluginNotification)
})
export type PluginRecord = typeof PluginRecord.Type

/** A plugin asking the person for a secret, waiting on the answer. */
export const PluginSecretRequest = Schema.Struct({
  id: Schema.String,
  pluginId: Schema.String,
  title: Schema.String,
  description: Schema.optional(Schema.String)
})
export type PluginSecretRequest = typeof PluginSecretRequest.Type

/** A plugin's page on disk and the content security policy it is served
 *  under; the shell mints the URL. */
export const PluginPage = Schema.Struct({ file: Schema.String, csp: Schema.String })
export type PluginPage = typeof PluginPage.Type

/** A window's hold on a plugin's view for one session: the page to load and
 *  the lease its requests go through. */
export const PluginViewLease = Schema.Struct({
  leaseId: Schema.String,
  sessionId: Schema.String,
  file: Schema.String,
  csp: Schema.String
})
export type PluginViewLease = typeof PluginViewLease.Type

/** The store or the host said no; `message` is the sentence shown to the user. */
export class PluginRefused extends Schema.TaggedError<PluginRefused>()('PluginRefused', {
  message: Schema.String
}) {}

/** What a plugins call may answer besides its result: refused, or not carried here. */
export const RefusedOrUnavailable = Schema.Union(PluginRefused, CapabilityUnavailable)

// ── Queries ──

/** Every installed plugin, with its running state. A registry the host could
 *  not read refuses the list with its sentence, as it refuses every call. */
export const ListPlugins = Query.define('ListPlugins', {
  payload: Schema.Struct({}),
  success: Schema.Array(PluginRecord),
  failure: RefusedOrUnavailable
})

/** The page of one panel of a plugin, for the window that shows it. */
export const GetPluginPanel = Query.define('GetPluginPanel', {
  payload: Schema.Struct({ pluginId: Schema.String, panelId: Schema.String }),
  success: PluginPage,
  failure: RefusedOrUnavailable
})

/** The secrets plugins are waiting on. */
export const ListPluginSecretRequests = Query.define('ListPluginSecretRequests', {
  payload: Schema.Struct({}),
  success: Schema.Array(PluginSecretRequest),
  failure: RefusedOrUnavailable
})

// ── Commands ──

/** Enable a plugin with the permissions the person granted. */
export const EnablePlugin = Command.define('EnablePlugin', {
  payload: Schema.Struct({ id: Schema.String, grants: Schema.Array(PluginPermission) }),
  success: Schema.Void,
  failure: RefusedOrUnavailable
})

/** Disable a plugin: its `main` stops and its panels go. */
export const DisablePlugin = Command.define('DisablePlugin', {
  payload: Schema.Struct({ id: Schema.String }),
  success: Schema.Void,
  failure: RefusedOrUnavailable
})

/** Install a plugin by linking a folder the shell's dialog picked; answers its id. */
export const LinkPlugin = Command.define('LinkPlugin', {
  payload: Schema.Struct({ folder: Schema.String }),
  success: Schema.Struct({ id: Schema.String }),
  failure: RefusedOrUnavailable
})

/** Remove an installed plugin. */
export const RemovePlugin = Command.define('RemovePlugin', {
  payload: Schema.Struct({ id: Schema.String }),
  success: Schema.Void,
  failure: RefusedOrUnavailable
})

/** Run one of a plugin's commands. */
export const RunPluginCommand = Command.define('RunPluginCommand', {
  payload: Schema.Struct({ id: Schema.String, command: Schema.String }),
  success: Schema.Void,
  failure: RefusedOrUnavailable
})

/** The window that has the focus and its active session (null when none),
 *  as the shell reports it, for the plugins that read the context. */
export const ReportPluginContext = Command.define('ReportPluginContext', {
  payload: Schema.Struct({ windowKey: Schema.String, sessionId: Schema.NullOr(Schema.String) }),
  success: Schema.Void,
  failure: RefusedOrUnavailable
})

/** Take a lease on a plugin's view for one session. */
export const LeasePluginView = Command.define('LeasePluginView', {
  payload: Schema.Struct({
    pluginId: Schema.String,
    viewId: Schema.String,
    sessionId: Schema.String
  }),
  success: PluginViewLease,
  failure: RefusedOrUnavailable
})

/** A view's request to its plugin, through the lease; answers the plugin's result. */
export const RequestPluginView = Command.define('RequestPluginView', {
  payload: Schema.Struct({
    leaseId: Schema.String,
    method: Schema.String,
    params: Schema.optional(Schema.Unknown)
  }),
  success: Schema.Struct({ result: Schema.optional(Schema.Unknown) }),
  failure: RefusedOrUnavailable
})

/** Give a view's lease back: the view was closed. */
export const RevokePluginView = Command.define('RevokePluginView', {
  payload: Schema.Struct({ leaseId: Schema.String }),
  success: Schema.Void,
  failure: RefusedOrUnavailable
})

/** The person's answer to a plugin's secret request; null when they declined. */
export const ReplyPluginSecret = Command.define('ReplyPluginSecret', {
  payload: Schema.Struct({ id: Schema.String, value: Schema.NullOr(Schema.String) }),
  success: Schema.Void,
  failure: RefusedOrUnavailable
})

export const pluginsGroup = ApiGroup.make('plugins')
  .add(HttpCqrs.queryEndpoint('list', '/plugins', ListPlugins))
  .add(HttpCqrs.queryEndpoint('panel', '/plugins/panel', GetPluginPanel))
  .add(HttpCqrs.queryEndpoint('secrets', '/plugins/secrets', ListPluginSecretRequests))
  .add(HttpCqrs.commandEndpoint('enable', '/plugins/enable', EnablePlugin))
  .add(HttpCqrs.commandEndpoint('disable', '/plugins/disable', DisablePlugin))
  .add(HttpCqrs.commandEndpoint('link', '/plugins/link', LinkPlugin))
  .add(HttpCqrs.commandEndpoint('remove', '/plugins/remove', RemovePlugin))
  .add(HttpCqrs.commandEndpoint('command', '/plugins/command', RunPluginCommand))
  .add(HttpCqrs.commandEndpoint('context', '/plugins/context', ReportPluginContext))
  .add(HttpCqrs.commandEndpoint('leaseView', '/plugins/views/lease', LeasePluginView))
  .add(HttpCqrs.commandEndpoint('requestView', '/plugins/views/request', RequestPluginView))
  .add(HttpCqrs.commandEndpoint('revokeView', '/plugins/views/revoke', RevokePluginView))
  .add(HttpCqrs.commandEndpoint('replySecret', '/plugins/secrets/reply', ReplyPluginSecret))
