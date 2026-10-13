/**
 * Settings domain: workspaces. The registry of root folders, the pins of
 * every workspace, and the workspace the first window of a run opens on.
 *
 * Mirrors the preload's workspace methods as of this change
 * (`src/preload/index.ts`). The types in `src/shared/workspace-types.ts` and
 * `src/preload/index.d.ts` are the originals until the renderer reads this
 * contract instead; then this module becomes the original.
 */
import { Command, Query } from '@structure-ai/cqrs'
import { Schema } from 'effect'
import { SettingsRefused } from './failures'

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export const WorkspaceView = Schema.Struct({
  /** Stable uuid — sessions, groups, and pins are stamped with it. */
  id: Schema.String,
  name: Schema.String,
  /** Absolute, realpath-normalized root folder, unique across the registry. */
  rootDir: Schema.String,
  /** The chosen profile .clave file, or null for a bare workspace. */
  profileFile: Schema.NullOr(Schema.String),
  createdAt: Schema.Number
})

/** Pins are stored opaquely: the client's pinned store owns their shape. */
export const PinsView = Schema.Array(Schema.Unknown)

export const WorkspaceStateView = Schema.Struct({
  version: Schema.Literal(1),
  workspaces: Schema.Array(WorkspaceView),
  /** What the first window of a run opens on. */
  lastActiveWorkspaceId: Schema.NullOr(Schema.String),
  /** Legacy mirror of `lastActiveWorkspaceId`, read by pre-multi-window releases. */
  activeWorkspaceId: Schema.NullOr(Schema.String),
  pins: PinsView,
  pinsMigrated: Schema.Boolean
})

const Ok = Schema.Struct({ ok: Schema.Literal(true) })

/** The window key of the writer, when a window wrote. The change event
 *  carries it back so the writer drops its own echo: it already holds the
 *  state, and folding the echo in would race its next mutation (the rule the
 *  IPC handler kept by sending to every OTHER window). */
const Origin = Schema.optional(Schema.String)

// ---------------------------------------------------------------------------
// Commands and queries
// ---------------------------------------------------------------------------

/** `workspace:load` */
export const LoadWorkspaceState = Query.define('LoadWorkspaceState', {
  payload: Schema.Struct({}),
  success: WorkspaceStateView
})

/** `workspace:update-registry` — the whole list replaces the registry, or nothing does. */
export const UpdateWorkspaceRegistry = Command.define('UpdateWorkspaceRegistry', {
  payload: Schema.Struct({ workspaces: Schema.Array(WorkspaceView), origin: Origin }),
  success: Schema.Union(
    Ok,
    Schema.Struct({ ok: Schema.Literal(false), reason: Schema.Literal('invalid') })
  ),
  failure: SettingsRefused
})

/** `workspace:update-pins` — one workspace's pins, the unscoped ones (null), or 'all'. */
export const UpdateWorkspacePins = Command.define('UpdateWorkspacePins', {
  payload: Schema.Struct({
    scope: Schema.NullOr(Schema.String),
    pins: PinsView,
    origin: Origin
  }),
  success: Schema.Union(
    Ok,
    Schema.Struct({ ok: Schema.Literal(false), reason: Schema.Literal('invalid-key', 'no-window') })
  ),
  failure: SettingsRefused
})

/** `workspace:set-last-active` */
export const SetLastActiveWorkspace = Command.define('SetLastActiveWorkspace', {
  payload: Schema.Struct({ workspaceId: Schema.NullOr(Schema.String) }),
  success: Ok,
  failure: SettingsRefused
})

// ---------------------------------------------------------------------------
// Events: members of the server's one event union (`../events.ts`).
// ---------------------------------------------------------------------------

/** `workspace:state-changed`: the registry and the pins, never groups or
 *  sessions; `origin` names the window that wrote, or null when main did. */
export const WorkspaceStateChanged = Schema.TaggedStruct('workspaces.state_changed', {
  workspaces: Schema.Array(WorkspaceView),
  pins: PinsView,
  origin: Schema.NullOr(Schema.String)
})
