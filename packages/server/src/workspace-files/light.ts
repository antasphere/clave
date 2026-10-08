/**
 * The workspace files without the server: the class, its storage and the
 * trust boundary, which import nothing of Effect or the framework, so the
 * Electron shell can build them at boot without loading either
 * (`@clave/server/workspace-files`). The port, the handlers and the event
 * wiring stay in `./index.ts`.
 */
export * from './files'
export * from './trust'
