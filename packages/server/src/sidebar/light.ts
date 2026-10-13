/**
 * The sidebar layouts without the server: the class and its ports, which
 * import nothing of Effect or the framework, so the Electron shell can build
 * them at boot without loading either (`@clave/server/sidebar-layouts`).
 * The handlers and the event wiring stay in `./index.ts`.
 */
export * from './layouts'
export * from './ports'
