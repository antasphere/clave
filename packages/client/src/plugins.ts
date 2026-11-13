/**
 * The plugins domain of the client (wave 5, lane C, PRDCT-3433): the
 * installed plugins and their host, served by the server. The shell and the
 * windows list, enable, link and remove plugins here, report the focused
 * window and session, lease a plugin's view and carry its requests, and
 * answer a plugin's secret request. A refusal of the store or the host is
 * thrown as the contract's `PluginRefused`, a server that runs no plugins
 * as `CapabilityUnavailable`, like every declared failure.
 */
import type {
  PluginActionPreviewRow,
  PluginActionResult,
  PluginActionTarget,
  PluginGroup,
  PluginPage,
  PluginPermission,
  PluginRecord,
  PluginSecretRequest,
  PluginViewLease
} from '@clave/contract/plugins'
import type { Call } from './call'

export interface PluginsClient {
  readonly list: () => Promise<ReadonlyArray<PluginRecord>>
  /** The page of one panel of a plugin; the shell mints its URL. */
  readonly panel: (pluginId: string, panelId: string) => Promise<PluginPage>
  /** The secrets plugins are waiting on. */
  readonly secrets: () => Promise<ReadonlyArray<PluginSecretRequest>>
  readonly enable: (id: string, grants: ReadonlyArray<PluginPermission>) => Promise<void>
  readonly disable: (id: string) => Promise<void>
  /** Link a plugin from a folder; answers its id. */
  readonly link: (folder: string) => Promise<string>
  readonly remove: (id: string) => Promise<void>
  readonly command: (id: string, command: string) => Promise<void>
  /** The focused window and its active session, null when none. */
  readonly context: (windowKey: string, sessionId: string | null) => Promise<void>
  readonly leaseView: (
    pluginId: string,
    viewId: string,
    sessionId: string
  ) => Promise<PluginViewLease>
  /** A view's request through its lease; answers the plugin's result,
   *  undefined when it gave none. */
  readonly requestView: (leaseId: string, method: string, params?: unknown) => Promise<unknown>
  readonly revokeView: (leaseId: string) => Promise<void>
  /** The person's answer to a secret request; null when they declined. */
  readonly replySecret: (id: string, value: string | null) => Promise<void>
  /** Run a plugin's action on a target; answers the page it opens, if any. */
  readonly invokeAction: (
    pluginId: string,
    actionId: string,
    target: PluginActionTarget
  ) => Promise<PluginActionResult>
  /** The rows a plugin's action shows for a target before it runs. */
  readonly previewAction: (
    pluginId: string,
    actionId: string,
    target: PluginActionTarget
  ) => Promise<ReadonlyArray<PluginActionPreviewRow>>
  /** A window's sidebar groups; an empty list clears them. */
  readonly groups: (windowKey: string, groups: ReadonlyArray<PluginGroup>) => Promise<void>
}

export const pluginsClient = (call: Call): PluginsClient => ({
  list: () => call((c) => c.plugins.list({ payload: {} })),
  panel: (pluginId, panelId) => call((c) => c.plugins.panel({ payload: { pluginId, panelId } })),
  secrets: () => call((c) => c.plugins.secrets({ payload: {} })),
  enable: (id, grants) =>
    call((c) => c.plugins.enable({ payload: { id, grants } })).then(() => undefined),
  disable: (id) => call((c) => c.plugins.disable({ payload: { id } })).then(() => undefined),
  link: (folder) => call((c) => c.plugins.link({ payload: { folder } })).then((r) => r.id),
  remove: (id) => call((c) => c.plugins.remove({ payload: { id } })).then(() => undefined),
  command: (id, command) =>
    call((c) => c.plugins.command({ payload: { id, command } })).then(() => undefined),
  context: (windowKey, sessionId) =>
    call((c) => c.plugins.context({ payload: { windowKey, sessionId } })).then(() => undefined),
  leaseView: (pluginId, viewId, sessionId) =>
    call((c) => c.plugins.leaseView({ payload: { pluginId, viewId, sessionId } })),
  requestView: (leaseId, method, params) =>
    call((c) =>
      c.plugins.requestView({
        payload: { leaseId, method, ...(params !== undefined && { params }) }
      })
    ).then((answer) => answer.result),
  revokeView: (leaseId) =>
    call((c) => c.plugins.revokeView({ payload: { leaseId } })).then(() => undefined),
  replySecret: (id, value) =>
    call((c) => c.plugins.replySecret({ payload: { id, value } })).then(() => undefined),
  invokeAction: (pluginId, actionId, target) =>
    call((c) => c.plugins.invokeAction({ payload: { pluginId, actionId, target } })),
  previewAction: (pluginId, actionId, target) =>
    call((c) => c.plugins.previewAction({ payload: { pluginId, actionId, target } })),
  groups: (windowKey, groups) =>
    call((c) => c.plugins.groups({ payload: { windowKey, groups } })).then(() => undefined)
})
