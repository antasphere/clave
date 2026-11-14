/**
 * The sidebar domain of the server: the layouts kept per window key, their
 * ports, the handlers on the buses and the wiring that tells every change to
 * the clients (PRDCT-3241).
 */
export * from './light'
export { SidebarLayoutsPort, SidebarOverviewPort } from './port'
export { SidebarEventsLive, SidebarOverviewEventsLive, sidebarHandlers } from './handlers'
