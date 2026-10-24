/** Workspace model shared between main and renderer.
 *
 * A workspace is a ROOT FOLDER (e.g. ~/.antasphere), not a .clave file: each
 * workspace carries one chosen profile file (.clave/workspaces/<name>.clave)
 * that defines its pinned groups and toolbar. Each WINDOW shows one workspace
 * at a time and scopes everything visible in it (sessions, groups, pins,
 * toolbar); a window's `activeWorkspaceId === null` if and only if no
 * workspaces are registered (the app then behaves as if the feature didn't
 * exist). Any number of windows may show the same workspace: a window is the
 * whole app once more, on whatever workspace the user picks for it.
 */
export interface Workspace {
  /** Stable uuid — sessions, groups, and pins are stamped with it. */
  id: string
  /** Display name; defaults to the cleaned basename of rootDir ("Antasphere"). */
  name: string
  /** Absolute, realpath-normalized root folder. Unique across the registry;
   *  nested roots are rejected at registration. */
  rootDir: string
  /** Absolute path to the chosen profile .clave file, or null for a bare
   *  workspace with no pins (sessions still scope to it). */
  profileFile: string | null
  createdAt: number
}

/** A workspace that lives on a connected Clave server (#241): its id is the
 *  server's own id wrapped as a remote key, `resourceKey('workspace',
 *  serverId, id)` in `@clave/contract/fleet`. This Mac's registry never holds
 *  one, so main takes it on trust for a window to show and persists it on
 *  the window; the renderer reads the server's registry for everything else. */
export function isServerWorkspaceId(id: unknown): id is string {
  return typeof id === 'string' && id.startsWith('clave-owner:workspace:')
}

/** Everything persisted in <userData>/workspace-state.json. The main process
 *  stores `pins` opaquely (the renderer's pinned-store owns their shape), the
 *  same way the sidebar layouts store groups — main is dumb, crash-safe
 *  storage; the renderer is the source of truth during a run. */
/** What a renderer learns about the window it runs in — and only that
 *  window. `windowId` is runtime truth from the main-process WindowRegistry
 *  (BrowserWindow ids restart at 1 on every launch); `windowKey` is the
 *  persisted identity that survives a restart, the name of the window's own
 *  sidebar layout file and the stamp on the session records it opened. */
export interface WindowIdentity {
  windowId: number
  windowKey: string
  /** The workspace this window SHOWS; null only in no-workspace mode. */
  workspaceId: string | null
  /** The lowest-id live window, re-elected when it closes: takes in what a
   *  closing window leaves behind and adopts orphans at boot (records and
   *  layouts whose window no longer exists), and carries app-level fallbacks. */
  isPrimary: boolean
}

/** One entry of <userData>/windows.json — a window to bring back at boot. */
export interface PersistedWindow {
  key: string
  workspaceId: string | null
  bounds?: { x: number; y: number; width: number; height: number }
}

export interface WorkspaceStateFile {
  version: 1
  workspaces: Workspace[]
  /** What the FIRST window of a run opens on; updated whenever any window
   *  switches to or opens a workspace. Informational only while running — a
   *  window's own workspace lives in the WindowRegistry, never here. */
  lastActiveWorkspaceId: string | null
  /** Legacy mirror of `lastActiveWorkspaceId`, read by releases before the
   *  multi-window build. Written for one release so a downgrade keeps its
   *  active workspace; read only when the new key is absent. */
  activeWorkspaceId: string | null
  pins: unknown[]
  /** False right after the main-side registry migration (Phase A); the
   *  renderer imports localStorage pins (Phase B) and flips it true. */
  pinsMigrated: boolean
}

/** Where a copy of the registry and the pins stands (PRDCT-3405). `revision`
 *  is bumped by the process holding the state at every registry or pins
 *  write; `instance` names that process, minted when it starts and never
 *  written to disk. Two copies compare by revision only within one
 *  instance: an attached window that booted on main's copy and reached the
 *  server later meets a second instance, whose stamp it adopts. The window
 *  keeps the last stamp it loaded, wrote or took in and drops any fold that
 *  is not newer, which is what keeps a catch-up read older than the
 *  window's own write from resetting the pins that write just loaded. */
export interface WorkspaceStamp {
  revision: number
  instance: string
}

/** The state as `workspace:load` answers it: the file, stamped. */
export interface WorkspaceState extends WorkspaceStateFile, WorkspaceStamp {}
