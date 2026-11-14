/**
 * What a phone may do on this server, as an ALLOWLIST: the sessions routes
 * the spec names (a list, a read, a start, a stop, a write, a resize, a
 * view, the models, the commands, the capabilities, the history, a
 * restart), the pending requests and their answers, the files reads and
 * bounded attachment preparation, launch profile and workspace reads,
 * its own device routes, and four reads the phone's list and settings show
 * (the UX round of 13 November 2026):
 * - `/sidebar/overview`, the desktop's groups projected without what drives
 *   an agent (`sidebar/overview.ts`); the layouts themselves stay the owner's;
 * - `/accounts/claude` and `/accounts/codex`, the account lists, which carry
 *   `hasToken` / `hasCredential` and never the token or the credential
 *   (`@clave/contract/settings`, `ClaudeAccountView` and `CodexAccountView`);
 * - `/usage/claude/snapshot` and `/usage/codex/snapshot`, the last read of
 *   every account from the server's cache: no provider is asked, and the
 *   payload has no `force`. The live reads (`/usage/claude`, `/usage/codex`)
 *   can ask the provider and stay the owner's;
 * - `/server/info`, the version the Mac runs, its install ref and upgrade state.
 * Everything else, the test fixture route, the logins and the Antasphere
 * account, the clients, the plugins, the sidebar's layouts and every edit
 * of them, the git panel, the server's other routes and every write to the
 * settings included, answers 403 with one sentence.
 * A denylist would admit the next route anybody adds; this list does not.
 */
const SESSION_READS = new Set([
  '/sessions',
  '/sessions/by-id',
  '/sessions/models',
  '/sessions/commands',
  '/sessions/capabilities',
  '/sessions/history',
  '/sessions/timeline',
  '/sessions/writes'
])
const SESSION_WRITES = new Set([
  '/sessions/start',
  '/sessions/stop',
  '/sessions/write',
  '/sessions/resize',
  '/sessions/view',
  '/sessions/restart'
])
const READS = new Set([
  '/requests/pending',
  '/launch-profiles',
  '/workspaces',
  '/devices/me',
  '/sidebar/overview',
  '/accounts/claude',
  '/accounts/codex',
  '/usage/claude/snapshot',
  '/usage/codex/snapshot',
  '/server/info'
])
const WRITES = new Set([
  '/requests/resolve',
  '/files/attachments/prepare',
  '/devices/me/push-token',
  '/devices/me/push-token/clear'
])

/** The sentence a phone gets on a route it may not call. */
export const DEVICE_FORBIDDEN_MESSAGE = 'A phone may not do this.'

/** Whether a device session may make this call. `path` carries no query. */
export function deviceMayCall(method: string, path: string): boolean {
  if (method === 'GET') {
    return SESSION_READS.has(path) || READS.has(path) || path.startsWith('/files/')
  }
  if (method === 'POST') return SESSION_WRITES.has(path) || WRITES.has(path)
  return false
}

/** The server events a phone's socket hears: its sessions, the requests,
 *  its own domain, the workspaces it may list, the usage reads the
 *  notifications read a limit from, and the notice that the sidebar
 *  overview changed, which carries nothing (the phone reads the overview
 *  again). The rest of the stream (the accounts, the sidebar's layouts,
 *  which carry prompts and terminal commands, the plugins, the git panel,
 *  the server's upgrade) stays with the desktop, as the desktop's view
 *  request frames do. */
export function deviceHearsEvent(tag: string): boolean {
  return (
    tag.startsWith('session.') ||
    tag === 'requests.changed' ||
    tag === 'devices.changed' ||
    tag === 'workspaces.state_changed' ||
    tag.startsWith('usage.') ||
    tag === 'sidebar.overview_changed'
  )
}
