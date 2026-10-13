/**
 * The sidebar domain of the wire contract: a window's groups, terminals,
 * views and order, kept by the server per window key. Lane C's folder
 * (PRDCT-3241); the root exports it as `Sidebar` and spreads
 * `SidebarEvent.members` into the server's event union. The pure layout
 * rules are `./ops`, reachable without the schemas as
 * `@clave/contract/sidebar/ops`.
 */
export * from './layout'
export { sidebarGroup } from './api'
