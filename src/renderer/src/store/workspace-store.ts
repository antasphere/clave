import { create } from 'zustand'
import type { Workspace } from '../../../shared/workspace-types'
import { LOCAL_SERVER_ID as LOCAL_OWNER } from '@clave/contract/fleet'
import { ownerOf } from '../lib/fleet-identity'

export type { Workspace }

/** Workspace registry — a LEAF store: plain state, no imports of the session
 *  or pinned stores (they import this one for stamping). All orchestration
 *  (activation side effects, add/remove cascades, persistence) lives in
 *  lib/workspace-actions.ts, which sits above every store.
 *
 *  Multi-window (PRDCT-1703): a window is the whole app once more, on
 *  whatever workspace the user put it on. `activeWorkspaceId` is the
 *  workspace THIS WINDOW shows — a per-window value handed to the renderer by
 *  main at boot, never read from the state file. The identity fields beside
 *  it say which window this is: its runtime id, its persisted key (the name
 *  of its own sidebar layout file, the stamp on the session records it
 *  opened), and whether it is the primary (the window that takes in what a
 *  closing window leaves and adopts orphans at boot).
 *
 *  Invariant: `activeWorkspaceId === null` ⟺ `workspaces.length === 0`.
 *  While workspaces exist, exactly one is always active in a window — there
 *  is no "deactivated" state. With zero workspaces the app runs unscoped and
 *  behaves as if the workspace feature didn't exist.
 *
 *  Server workspaces (#241): a connected Clave server keeps its own registry,
 *  and its workspaces sit in `serverWorkspaces`, per server, beside the local
 *  ones. Their id is the server's id wrapped as a remote key
 *  (`resourceKey('workspace', serverId, id)`), so `ownerOf(ws.id)` names the
 *  server and `rootDir` is a path on the server's disk. They are never
 *  written to this Mac's registry: `workspaces` stays the local list, the
 *  one persisted, and `allWorkspaces` is what lists and switches read.
 */
interface WorkspaceState {
  /** This Mac's registry — the list persisted to main. */
  workspaces: Workspace[]
  /** Each connected server's own registry, keyed by server id; ids are remote keys. */
  serverWorkspaces: Record<string, Workspace[]>
  activeWorkspaceId: string | null
  /** True once boot hydration (workspace:load + pin import) has run. */
  loaded: boolean
  /** This window's BrowserWindow id; null until identity arrives (or outside
   *  Electron, where the renderer behaves as the sole, primary window). */
  windowId: number | null
  windowKey: string | null
  isPrimary: boolean
}

export const useWorkspaceStore = create<WorkspaceState>(() => ({
  workspaces: [],
  serverWorkspaces: {},
  activeWorkspaceId: null,
  loaded: false,
  windowId: null,
  windowKey: null,
  isPrimary: true
}))

/** The active workspace's id, for stamping newly created sessions/groups/pins.
 *  Null in no-workspace mode (nothing gets stamped). */
export function getActiveWorkspaceId(): string | null {
  return useWorkspaceStore.getState().activeWorkspaceId
}

type WorkspaceLists = Pick<WorkspaceState, 'workspaces' | 'serverWorkspaces'>

/** The local workspaces, then every server's, in the order servers were heard. */
export function allWorkspaces(state: WorkspaceLists): Workspace[] {
  const servers = Object.values(state.serverWorkspaces)
  return servers.length === 0 ? state.workspaces : [...state.workspaces, ...servers.flat()]
}

/** A workspace by id, local or on a server. */
export function findWorkspace(
  state: WorkspaceLists,
  id: string | null | undefined
): Workspace | undefined {
  if (!id) return undefined
  const owner = ownerOf(id)
  const list = owner === LOCAL_OWNER ? state.workspaces : state.serverWorkspaces[owner]
  return list?.find((w) => w.id === id)
}

export function getWorkspaceById(id: string | null | undefined): Workspace | undefined {
  return findWorkspace(useWorkspaceStore.getState(), id)
}

/** The server a workspace lives on, or null for a workspace of this Mac. */
export function workspaceServer(id: string | null | undefined): string | null {
  const owner = ownerOf(id)
  return owner === LOCAL_OWNER ? null : owner
}
