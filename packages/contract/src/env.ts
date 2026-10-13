/**
 * How a client learns where the server is. On their own here, with no
 * import, so a preload can read the names without loading the schemas.
 *
 * The one channel inside the app is IPC: main answers `IPC_SERVER_ENDPOINT`
 * with `{ url, token }` once the server runs, `null` before. The two
 * environment variables are for a process that is told the address from
 * outside, the end-to-end harness attaching the app to a server it started,
 * or a standalone server's own boot; the preload never reads them, the shell
 * never writes them into its own environment, and strips them from every
 * process it spawns (the wave's ruling of 2 October 2026: an inherited
 * address is how a Clave started from a Clave tab reaches the wrong server).
 */
export const CONTRACT_VERSION = 1
/** The IPC channel the preload asks main for the endpoint on. */
export const IPC_SERVER_ENDPOINT = 'server:endpoint'
export const ENV_SERVER_URL = 'CLAVE_SERVER_URL'
export const ENV_SERVER_TOKEN = 'CLAVE_SERVER_TOKEN'
