/**
 * `@clave/server`: Clave's server on `@structure-ai`. The buses, the event
 * store, the HTTP API and the push channel, composed in `runtime.ts` for any
 * listener; `embedded.ts` is the in-process entry Electron main calls and
 * the standalone entry runs. One folder per domain (`sessions/`, `clients/`),
 * each with its port and its handler list; `ports.ts` gathers the ports an
 * entry provides.
 */
export { startEmbedded, type EmbeddedOptions, type EmbeddedServer } from './embedded'
export { PortsLive, type ServerPorts, type Unsubscribe } from './ports'
export { ServerEvents, type ServerEventsService } from './events'
export { PushHub, type PushSocket, type PushPeer } from './push/hub'
export { PushHubService, pushRoute } from './push/route'
export { bearerAuth, safeEqual, tokenMatches } from './auth'
export { corsForLoopback, isLoopbackOrigin, isOwnPageOrigin } from './cors'
export { ServerLive, ServicesLive, BusesLive, type ServerOptions } from './runtime'

// ── Lane A: sessions, and the clients the shell registers as ──
export {
  SessionHost,
  type SessionHostService,
  type SessionStreamSource,
  type StartInput,
  sessionHandlers
} from './sessions'
export { ClientRegistry, type ClientRegistryService, clientHandlers } from './clients'

// ── Lane B: terminals · Lane C: sidebar · Lane D: settings ──
