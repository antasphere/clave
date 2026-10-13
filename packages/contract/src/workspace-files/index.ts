/**
 * The workspace files domain of the wire contract (wave 3, lane A): the
 * `.clave` shape, the commands and queries, the review, and the events, in
 * `model.ts`; the HTTP group in `api.ts`. The root exports it as
 * `WorkspaceFiles` and spreads `WorkspaceFilesEvent.members` into the
 * server's event union.
 */
export * from './model'
export { workspaceFilesGroup } from './api'
