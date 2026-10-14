/**
 * The plugins port (wave 5, lane C, PRDCT-3433): what the server needs from
 * whoever holds the installed plugins, runs their host and leases their
 * views. Inside the app the shell implements it over its plugin store and
 * host; a server with nothing behind it runs on `Plugins.none`, which
 * refuses every call as unavailable rather than answer an empty store.
 *
 * The methods are plain calls and promises, not Effects: the port is
 * implemented in plain TypeScript, and the handlers (`handlers.ts`) are where
 * a thrown error becomes a declared failure. A refusal is a plain `Error`
 * carrying the sentence to show, the way the settings managers say no; a
 * thrown `CapabilityUnavailable` is the server saying it has no plugins.
 */
import { Context, Layer } from 'effect'
import { CapabilityUnavailable } from '@clave/contract/errors'
import type * as Contract from '@clave/contract/plugins'
import type { Unsubscribe } from '../sessions/port'

export type PluginRecord = typeof Contract.PluginRecord.Type
export type PluginPermission = typeof Contract.PluginPermission.Type
export type PluginPage = typeof Contract.PluginPage.Type
export type PluginViewLease = typeof Contract.PluginViewLease.Type
export type PluginSecretRequest = typeof Contract.PluginSecretRequest.Type

/** The service's news, exactly the two `ServerEvent` members of the domain,
 *  so the events layer publishes them as they are. */
export type PluginsEvent =
  | { readonly _tag: 'plugins.changed' }
  | {
      readonly _tag: 'plugins.notified'
      readonly pluginId: string
      readonly name: string
      readonly title: string
      readonly body?: string
    }

export interface PluginsService {
  /** Every installed plugin, with its manifest, grants and running state. */
  list(): ReadonlyArray<PluginRecord>
  /** Turn a plugin on with the permissions the person granted it. */
  enable(id: string, grants: ReadonlyArray<PluginPermission>): void
  /** Turn a plugin off, stopping it if it runs. */
  disable(id: string): void
  /** Install the plugin in a local folder by linking it; answers its id. */
  link(folder: string): string
  /** Uninstall a plugin, stopping it first. */
  remove(id: string): void
  /** Run one of the commands a running plugin declared. */
  command(id: string, command: string): Promise<void>
  /** The page a plugin's side panel renders, with the policy it runs under. */
  panel(pluginId: string, panelId: string): PluginPage
  /** Which session a window shows now, the context a plugin reads. */
  context(windowKey: string, sessionId: string | null): void
  /** A lease on a plugin's view for one session: the page and its id. */
  leaseView(pluginId: string, viewId: string, sessionId: string): PluginViewLease
  /** A call from a leased view to its plugin; answers what the plugin answered. */
  requestView(leaseId: string, method: string, params: unknown): unknown | Promise<unknown>
  /** Give a view's lease back: its page is gone. */
  revokeView(leaseId: string): void
  /** The secrets plugins asked for and nobody answered yet. */
  secrets(): ReadonlyArray<PluginSecretRequest>
  /** The person's answer to a secret request; null declines it. */
  replySecret(id: string, value: string | null): void
  /** The service's news: `plugins.changed` after any change of the records or
   *  their running state, `plugins.notified` when a plugin notifies and this
   *  entry shows no notification itself. The server publishes each one. */
  subscribe(listener: (event: PluginsEvent) => void): Unsubscribe
}

const NO_PLUGINS = new CapabilityUnavailable({
  capability: 'plugins',
  message: 'This server runs no plugins: the entry gave it no plugin store.'
})

const refuse = (): never => {
  throw NO_PLUGINS
}

export class Plugins extends Context.Tag('@clave/server/Plugins')<Plugins, PluginsService>() {
  static layer(service: PluginsService): Layer.Layer<Plugins> {
    return Layer.succeed(Plugins, service)
  }
  /** A server with no plugin store behind it: every call says so, so it
   *  never looks like one with nothing installed. The tests' default. */
  static readonly none: PluginsService = {
    list: refuse,
    enable: refuse,
    disable: refuse,
    link: refuse,
    remove: refuse,
    command: () => Promise.reject(NO_PLUGINS),
    panel: refuse,
    context: refuse,
    leaseView: refuse,
    requestView: refuse,
    revokeView: refuse,
    secrets: refuse,
    replySecret: refuse,
    subscribe: () => () => {}
  }
}
