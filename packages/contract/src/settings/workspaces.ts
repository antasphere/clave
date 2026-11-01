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

/** Where a copy of the registry and the pins stands (wave 5, lane A,
 *  PRDCT-3405): `revision` is bumped by the process holding the state at
 *  every registry or pins write, `instance` names that process (minted at
 *  its start, never persisted). Two copies compare by revision only within
 *  one instance. The load, the change event and both write results carry
 *  it, so a window keeps the last stamp it loaded, wrote or took in and
 *  drops any fold that is not newer: a catch-up read older than the
 *  window's own write can no longer reset the pins that write just loaded. */
export const WorkspaceStampFields = {
  revision: Schema.Number,
  instance: Schema.String
}
export const WorkspaceStamp = Schema.Struct(WorkspaceStampFields)

export const WorkspaceStateView = Schema.Struct({
  version: Schema.Literal(1),
  workspaces: Schema.Array(WorkspaceView),
  /** What the first window of a run opens on. */
  lastActiveWorkspaceId: Schema.NullOr(Schema.String),
  /** Legacy mirror of `lastActiveWorkspaceId`, read by pre-multi-window releases. */
  activeWorkspaceId: Schema.NullOr(Schema.String),
  pins: PinsView,
  pinsMigrated: Schema.Boolean,
  ...WorkspaceStampFields
})

const Ok = Schema.Struct({ ok: Schema.Literal(true) })
/** A registry or pins write that landed: the registry and the pins as the
 *  write left them, with the stamp it produced. The writer folds this the
 *  way it folds a change event, so what it knows at that revision is the
 *  whole state and not only the partition it wrote (round 1 of the lane's
 *  verifier: a change of another window that landed between the writer's
 *  read and its write was dropped as older than the write's own stamp). */
const Written = Schema.Struct({
  ok: Schema.Literal(true),
  workspaces: Schema.Array(WorkspaceView),
  pins: PinsView,
  ...WorkspaceStampFields
})

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

/** `workspace:update-registry` — the whole list replaces the registry, or nothing does.
 *  With `base`, only while the registry still stands at that stamp: a writer
 *  that read, edited and wrote back is refused as `stale` when another wrote
 *  in between, and reads again (#241, two Macs adding to one server). */
export const UpdateWorkspaceRegistry = Command.define('UpdateWorkspaceRegistry', {
  payload: Schema.Struct({
    workspaces: Schema.Array(WorkspaceView),
    origin: Origin,
    base: Schema.optional(WorkspaceStamp)
  }),
  success: Schema.Union(
    Written,
    Schema.Struct({ ok: Schema.Literal(false), reason: Schema.Literal('invalid', 'stale') })
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
    Written,
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
 *  sessions; `origin` names the window that wrote, or null when main did;
 *  the stamp is the state's after the write. */
export const WorkspaceStateChanged = Schema.TaggedStruct('workspaces.state_changed', {
  workspaces: Schema.Array(WorkspaceView),
  pins: PinsView,
  origin: Schema.NullOr(Schema.String),
  ...WorkspaceStampFields
})
