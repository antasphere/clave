/**
 * The sidebar domain of the server: the layouts kept per window key, their
 * ports, the handlers on the buses and the wiring that tells every change to
 * the clients (PRDCT-3241).
 */
export * from './light'
export { SidebarLayoutsPort } from './port'
export { SidebarEventsLive, sidebarHandlers } from './handlers'
