/**
 * `@clave/contract`: the wire between Clave's server and its clients.
 *
 * One module per domain. Lane A owns the root and the modules below; another
 * lane adds its own file (or folder) and one line in its section here, and
 * never edits a module that is not its own.
 */
export { CONTRACT_VERSION, ENV_SERVER_TOKEN, ENV_SERVER_URL } from './env'

export * as Sessions from './sessions'
export * as Clients from './clients'
export * as Events from './events'
export * as Push from './push'
export { ClaveApi, clientsGroup, sessionsGroup } from './api'

// ── Lane C: settings (packages/contract/src/settings/) ──
// Exported here once C's modules exist on dev; until then the folder is C's
// alone and nothing in the root refers to it.

// ── Lane F: the shell ──
