/**
 * The sidebar domain of the client (PRDCT-3241): every endpoint of
 * `@clave/contract/sidebar`'s group as a promise, built on the one `call`
 * (`./call.ts`) so a refusal, an unreachable server and a declared failure
 * (`LayoutConflict`, `GroupNotFound`, `CapabilityUnavailable`) reach the
 * caller the way the other domains' do. Lane C's module; `api.ts` mounts it
 * as `sidebar`.
 */
import type { Schema } from 'effect'
import type * as Sidebar from '@clave/contract/sidebar'
import type { Call } from './call'

/** The decoded payload of a command or query definition. */
type Payload<D extends { payload: Schema.Schema.Any }> = Schema.Schema.Type<D['payload']>

export interface SidebarClient {
  readonly getLayout: (windowKey: string) => Promise<Sidebar.LayoutSnapshot>
  readonly listLayouts: () => Promise<ReadonlyArray<Sidebar.LayoutSnapshot>>
  /** Throws `LayoutConflict` (the contract's tagged error) on a stale revision. */
  readonly saveLayout: (
    input: Payload<typeof Sidebar.SaveWindowLayout>
  ) => Promise<Sidebar.LayoutSnapshot>
  readonly createGroup: (
    input: Payload<typeof Sidebar.CreateGroup>
  ) => Promise<{ group: Sidebar.SidebarGroup; layout: Sidebar.LayoutSnapshot }>
  readonly renameGroup: (
    input: Payload<typeof Sidebar.RenameGroup>
  ) => Promise<Sidebar.LayoutSnapshot>
  readonly setGroupView: (
    input: Payload<typeof Sidebar.SetGroupView>
  ) => Promise<Sidebar.LayoutSnapshot>
  readonly setGroupColor: (
    input: Payload<typeof Sidebar.SetGroupColor>
  ) => Promise<Sidebar.LayoutSnapshot>
  readonly setGroupPrompt: (
    input: Payload<typeof Sidebar.SetGroupPrompt>
  ) => Promise<Sidebar.LayoutSnapshot>
  readonly setGroupCollapsed: (
    input: Payload<typeof Sidebar.SetGroupCollapsed>
  ) => Promise<Sidebar.LayoutSnapshot>
  readonly deleteGroup: (
    input: Payload<typeof Sidebar.DeleteGroup>
  ) => Promise<Sidebar.LayoutSnapshot>
  readonly addTerminal: (
    input: Payload<typeof Sidebar.AddGroupTerminal>
  ) => Promise<{ terminal: Sidebar.GroupTerminal; layout: Sidebar.LayoutSnapshot }>
  readonly updateTerminal: (
    input: Payload<typeof Sidebar.UpdateGroupTerminal>
  ) => Promise<Sidebar.LayoutSnapshot>
  readonly removeTerminal: (
    input: Payload<typeof Sidebar.RemoveGroupTerminal>
  ) => Promise<Sidebar.LayoutSnapshot>
  readonly moveItems: (input: Payload<typeof Sidebar.MoveItems>) => Promise<Sidebar.LayoutSnapshot>
  readonly placeSession: (
    input: Payload<typeof Sidebar.PlaceSession>
  ) => Promise<Sidebar.LayoutSnapshot>
  readonly removeSession: (
    input: Payload<typeof Sidebar.RemoveSession>
  ) => Promise<Sidebar.LayoutSnapshot>
  readonly absorbLayout: (
    input: Payload<typeof Sidebar.AbsorbLayout>
  ) => Promise<Sidebar.LayoutSnapshot>
  /** Throws `CapabilityUnavailable` on a server that hosts no windows. */
  readonly moveSessions: (
    input: Payload<typeof Sidebar.MoveSessionsToWindow>
  ) => Promise<Sidebar.MoveResult>
  readonly moveGroup: (
    input: Payload<typeof Sidebar.MoveGroupToWindow>
  ) => Promise<{ ok: boolean } & Sidebar.MoveResult>
}

export function sidebarClient(call: Call): SidebarClient {
  return {
    getLayout: (windowKey) => call((c) => c.sidebar.getLayout({ payload: { windowKey } })),
    listLayouts: () => call((c) => c.sidebar.listLayouts({ payload: {} })),
    saveLayout: (input) => call((c) => c.sidebar.saveLayout({ payload: input })),
    createGroup: (input) => call((c) => c.sidebar.createGroup({ payload: input })),
    renameGroup: (input) => call((c) => c.sidebar.renameGroup({ payload: input })),
    setGroupView: (input) => call((c) => c.sidebar.setGroupView({ payload: input })),
    setGroupColor: (input) => call((c) => c.sidebar.setGroupColor({ payload: input })),
    setGroupPrompt: (input) => call((c) => c.sidebar.setGroupPrompt({ payload: input })),
    setGroupCollapsed: (input) => call((c) => c.sidebar.setGroupCollapsed({ payload: input })),
    deleteGroup: (input) => call((c) => c.sidebar.deleteGroup({ payload: input })),
    addTerminal: (input) => call((c) => c.sidebar.addTerminal({ payload: input })),
    updateTerminal: (input) => call((c) => c.sidebar.updateTerminal({ payload: input })),
    removeTerminal: (input) => call((c) => c.sidebar.removeTerminal({ payload: input })),
    moveItems: (input) => call((c) => c.sidebar.moveItems({ payload: input })),
    placeSession: (input) => call((c) => c.sidebar.placeSession({ payload: input })),
    removeSession: (input) => call((c) => c.sidebar.removeSession({ payload: input })),
    absorbLayout: (input) => call((c) => c.sidebar.absorbLayout({ payload: input })),
    moveSessions: (input) => call((c) => c.sidebar.moveSessions({ payload: input })),
    moveGroup: (input) => call((c) => c.sidebar.moveGroup({ payload: input }))
  }
}
