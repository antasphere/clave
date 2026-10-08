/**
 * `@clave/contract`: the wire between Clave's server and its clients.
 *
 * One module per domain, exported as a namespace here, plus the shared
 * pieces every domain uses (`errors.ts`, `events.ts`, `push.ts`, `api.ts`).
 * A lane adds its own module (or folder), one namespace line in its section
 * below, its members in `ServerEvent` and its group in `api.ts`, and never
 * edits a module that is not its own.
 */
export { CONTRACT_VERSION, ENV_SERVER_TOKEN, ENV_SERVER_URL, IPC_SERVER_ENDPOINT } from './env'
export { CapabilityUnavailable } from './errors'
export * as Events from './events'
export * as Push from './push'
export { ClaveApi, clientsGroup, sessionsGroup } from './api'

// ── Lane A: sessions, and the clients the shell registers as ──
export * as Sessions from './sessions'
export * as Clients from './clients'

// ── Lane C (wave 1): settings (packages/contract/src/settings/) ──
export * as Settings from './settings'

// ── Lane C (wave 2): the sidebar (packages/contract/src/sidebar/) ──
export * as Sidebar from './sidebar'

// ── Wave 3, lane A: the workspace files (packages/contract/src/workspace-files/) ──
export * as WorkspaceFiles from './workspace-files'
// ── Lane D (wave 3): the view requests ──
export * as Views from './views'

// ── Lane B: terminals · Lane D: settings served ──
