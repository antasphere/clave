/** The environment variable the terminal process reads its token from, and
 *  takes out of its environment before anything spawns (`main.ts`). In a
 *  module of its own so the supervisor and the entry share the name without
 *  the entry's bundle pulling the server's client in. */
export const TOKEN_ENV = 'CLAVE_TERMINALS_TOKEN'

/** The variable that makes an Electron binary run as plain Node. A child the
 *  app starts that way (the terminal process, the separate server) reads
 *  nothing of it and TAKES IT OUT of its environment at boot, before anything
 *  spawns: a session's child would otherwise inherit it, and a Clave started
 *  from a Clave tab would start as a bare Node process instead of the app. */
export const RUN_AS_NODE_ENV = 'ELECTRON_RUN_AS_NODE'
