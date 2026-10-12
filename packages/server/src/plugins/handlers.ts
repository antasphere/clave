/**
 * The plugins domain on the server (wave 5, lane C, PRDCT-3433): every
 * command and query of `@clave/contract/plugins`, answered from the port.
 * Each handler is one call on it; the bus has validated the payload.
 *
 * A thrown `CapabilityUnavailable` (the class, or an error carrying its tag
 * and fields) is that declared failure; a plain `Error` is the store's or the
 * host's refusal, `PluginRefused` with its sentence, wherever it is declared
 * (every command, and the panel query); anything else is a defect. The two
 * list queries declare the capability alone, so a refusal there is a defect.
 */
import { Effect } from 'effect'
import { CommandHandler, QueryHandler } from '@structure-ai/cqrs'
import { CapabilityUnavailable } from '@clave/contract/errors'
import {
  DisablePlugin,
  EnablePlugin,
  GetPluginPanel,
  LeasePluginView,
  LinkPlugin,
  ListPluginSecretRequests,
  ListPlugins,
  PluginRefused,
  RemovePlugin,
  ReplyPluginSecret,
  ReportPluginContext,
  RequestPluginView,
  RevokePluginView,
  RunPluginCommand
} from '@clave/contract/plugins'
import { Plugins, type PluginsService } from './port'

/** The server has no plugins: the contract's class, or any error carrying
 *  its tag and fields (an entry that must not load Effect at boot throws a
 *  plain error shaped like it). */
const asUnavailable = (error: unknown): CapabilityUnavailable | null => {
  if (error instanceof CapabilityUnavailable) return error
  if (
    typeof error === 'object' &&
    error !== null &&
    (error as { _tag?: unknown })._tag === 'CapabilityUnavailable' &&
    typeof (error as { capability?: unknown }).capability === 'string' &&
    typeof (error as { message?: unknown }).message === 'string'
  ) {
    const { capability, message } = error as { capability: string; message: string }
    return new CapabilityUnavailable({ capability, message })
  }
  return null
}

/** The store's or the host's refusal: a plain `Error` carrying the sentence
 *  for the person. A subclass (a TypeError, a system error) is a defect. */
const asRefused = (error: unknown): PluginRefused | null =>
  error instanceof Error && error.constructor === Error
    ? new PluginRefused({ message: error.message })
    : null

/** One call on the port for a command: the capability refusal or the
 *  store's refusal is the declared failure; anything else is a defect. */
const call = <A>(
  run: (plugins: PluginsService) => A | Promise<A>
): Effect.Effect<A, CapabilityUnavailable | PluginRefused, Plugins> =>
  Effect.flatMap(Plugins, (plugins) =>
    Effect.tryPromise({
      try: async () => await run(plugins),
      catch: (error) => error
    }).pipe(
      Effect.catchAll((error) => {
        const failure = asUnavailable(error) ?? asRefused(error)
        return failure ? Effect.fail(failure) : Effect.die(error)
      })
    )
  )

/** A list query: it declares the capability alone, so a refusal is a defect. */
const ask = <A>(
  run: (plugins: PluginsService) => A | Promise<A>
): Effect.Effect<A, CapabilityUnavailable, Plugins> =>
  call(run).pipe(Effect.catchTag('PluginRefused', (error) => Effect.die(error)))

export const pluginHandlers = [
  // The records, the panel page, the secrets waiting for an answer
  QueryHandler.make(ListPlugins, () => ask((p) => p.list())),
  // The panel query declares the refusal too: an unknown plugin or panel.
  QueryHandler.make(GetPluginPanel, (payload) =>
    call((p) => p.panel(payload.pluginId, payload.panelId))
  ),
  QueryHandler.make(ListPluginSecretRequests, () => ask((p) => p.secrets())),
  // The lifecycle
  CommandHandler.make(EnablePlugin, (payload) => call((p) => p.enable(payload.id, payload.grants))),
  CommandHandler.make(DisablePlugin, (payload) => call((p) => p.disable(payload.id))),
  CommandHandler.make(LinkPlugin, (payload) => call((p) => ({ id: p.link(payload.folder) }))),
  CommandHandler.make(RemovePlugin, (payload) => call((p) => p.remove(payload.id))),
  CommandHandler.make(RunPluginCommand, (payload) =>
    call((p) => p.command(payload.id, payload.command))
  ),
  // What a window shows, the context the plugins read
  CommandHandler.make(ReportPluginContext, (payload) =>
    call((p) => p.context(payload.windowKey, payload.sessionId))
  ),
  // The view leases
  CommandHandler.make(LeasePluginView, (payload) =>
    call((p) => p.leaseView(payload.pluginId, payload.viewId, payload.sessionId))
  ),
  CommandHandler.make(RequestPluginView, (payload) =>
    call(async (p) => {
      const result = await p.requestView(payload.leaseId, payload.method, payload.params)
      return { ...(result !== undefined && { result }) }
    })
  ),
  CommandHandler.make(RevokePluginView, (payload) => call((p) => p.revokeView(payload.leaseId))),
  // The secrets plugins asked for
  CommandHandler.make(ReplyPluginSecret, (payload) =>
    call((p) => p.replySecret(payload.id, payload.value))
  )
] as const
