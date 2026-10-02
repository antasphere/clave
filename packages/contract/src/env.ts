/**
 * The two environment variables through which a shell hands a client the
 * server's address. On their own here, with no import, so a preload can read
 * them without loading the contract's schemas.
 */
export const CONTRACT_VERSION = 1
/** Where a client finds the server: set by the shell that started it. */
export const ENV_SERVER_URL = 'CLAVE_SERVER_URL'
export const ENV_SERVER_TOKEN = 'CLAVE_SERVER_TOKEN'
