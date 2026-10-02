/**
 * `@clave/server`: Clave's server on `@structure-ai`. The buses, the event
 * store, the HTTP API and the push channel, composed in `runtime.ts` for any
 * listener; `embedded.ts` is the in-process entry Electron main calls.
 */
export { startEmbedded, type EmbeddedOptions, type EmbeddedServer } from './embedded'
export { SessionSource, type SessionSourceService, type Unsubscribe } from './ports'
export { ServerEvents, type ServerEventsService } from './events'
export { ClientRegistry, type ClientRegistryService } from './clients'
export { PushHub, type PushSocket, type PushPeer } from './push/hub'
export { PushHubService, pushRoute } from './push/route'
export { bearerAuth, safeEqual, tokenMatches } from './auth'
export { corsForLoopback, isLoopbackOrigin, isOwnPageOrigin } from './cors'
export { ServerLive, ServicesLive, BusesLive, type ServerOptions } from './runtime'
