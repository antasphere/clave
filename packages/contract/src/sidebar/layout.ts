/**
 * The sidebar domain of the wire contract: what a window's sidebar holds
 * (its groups, their quick-launch terminals and views, the top-level order),
 * kept by the server one layout per WINDOW KEY, and the commands and queries
 * that reach it (PRDCT-3241).
 *
 * Two kinds of caller write a layout. A window edits its own copy as the
 * user drags and types, then hands the whole layout back with the revision
 * it last saw (`SaveWindowLayout`); a write on a stale revision is refused
 * with the current snapshot, never merged last-writer-wins, and the window
 * resolves it by applying that snapshot and writing again. Everything that is
 * not a window (an agent tool in wave 3, a move between windows, a window
 * closing) uses the granular commands below, and every change, whoever made
 * it, reaches every client as `sidebar.layout_changed`.
 *
 * Ported field by field from `src/renderer/src/store/session-types.ts`
 * (`SessionGroup`, `GroupTerminalConfig`, `GroupViewConfig`), which stays
 * the renderer's copy; `layout.test.ts` holds the two shapes together.
 */
import { Schema } from 'effect'
import { Command, Query } from '@structure-ai/cqrs'
import { CapabilityUnavailable } from '../errors'

/** A window's persisted key, the id alphabet the shell mints; it names a
 *  file, so nothing outside this alphabet is ever accepted. */
export const WindowKey = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z0-9_-]{1,128}$/, { message: () => 'a window key' })
)
export type WindowKey = typeof WindowKey.Type

export const TerminalCommandMode = Schema.Literal('prefill', 'auto')

export const GroupTerminal = Schema.Struct({
  id: Schema.NonEmptyString,
  command: Schema.String,
  commandMode: TerminalCommandMode,
  color: Schema.String,
  icon: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.NullOr(Schema.String)),
  autoLaunchLocalhost: Schema.optional(Schema.Boolean),
  serverUrl: Schema.optional(Schema.String),
  groupView: Schema.optional(Schema.Boolean),
  /** The live session running this terminal, null while none does. */
  sessionId: Schema.NullOr(Schema.String)
})
export type GroupTerminal = typeof GroupTerminal.Type

export const GroupView = Schema.Struct({
  url: Schema.String,
  title: Schema.optional(Schema.String),
  terminalId: Schema.optional(Schema.NullOr(Schema.String))
})
export type GroupView = typeof GroupView.Type

export const SidebarGroup = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.String,
  sessionIds: Schema.Array(Schema.String),
  collapsed: Schema.Boolean,
  cwd: Schema.NullOr(Schema.String),
  terminals: Schema.Array(GroupTerminal),
  prompt: Schema.optional(Schema.NullOr(Schema.String)),
  rootSession: Schema.optional(Schema.Boolean),
  color: Schema.optional(Schema.NullOr(Schema.String)),
  view: Schema.optional(Schema.NullOr(GroupView)),
  workspaceId: Schema.optional(Schema.String)
})
export type SidebarGroup = typeof SidebarGroup.Type

/** What a window's sidebar holds: the groups, and the top level in order
 *  (group ids, standalone session ids, file-tab ids). */
export const WindowLayout = Schema.Struct({
  groups: Schema.Array(SidebarGroup),
  displayOrder: Schema.Array(Schema.String)
})
export type WindowLayout = typeof WindowLayout.Type

/** A window's layout as the server holds it, with the revision a write must
 *  name. The revision counts the server's writes to this key since it was
 *  loaded, from 0. */
export const LayoutSnapshot = Schema.Struct({
  windowKey: WindowKey,
  revision: Schema.NonNegativeInt,
  ...WindowLayout.fields
})
export type LayoutSnapshot = typeof LayoutSnapshot.Type

// ── Failures ──

/** The write named a revision the server has moved past; `current` is what
 *  it holds now, so the caller can apply it and write again. */
export class LayoutConflict extends Schema.TaggedError<LayoutConflict>()('LayoutConflict', {
  windowKey: WindowKey,
  current: LayoutSnapshot
}) {}
export class GroupNotFound extends Schema.TaggedError<GroupNotFound>()('GroupNotFound', {
  groupId: Schema.String
}) {}
export class TerminalNotFound extends Schema.TaggedError<TerminalNotFound>()('TerminalNotFound', {
  groupId: Schema.String,
  terminalId: Schema.String
}) {}
export class WindowNotFound extends Schema.TaggedError<WindowNotFound>()('WindowNotFound', {
  windowKey: Schema.String
}) {}

// ── Queries ──

/** One window's layout. For the primary window the answer also takes in the
 *  ORPHANS, the layouts of windows that no longer exist, which the shell
 *  decides through its port; the files of the orphans are removed and the
 *  primary's layout holds their groups from then on. */
export const GetWindowLayout = Query.define('GetWindowLayout', {
  payload: Schema.Struct({ windowKey: WindowKey }),
  success: LayoutSnapshot
})
/** Every window layout the server knows, loaded from storage when needed. */
export const ListWindowLayouts = Query.define('ListWindowLayouts', {
  payload: Schema.Struct({}),
  success: Schema.Array(LayoutSnapshot)
})

// ── The window's own write ──

/** A window hands its whole layout back. With `baseRevision`, the write is
 *  refused when the server has moved past it (a command landed meanwhile):
 *  the conflict carries the current snapshot. Without it, the write is
 *  unconditional, which only the shell's own migration should ever want. */
export const SaveWindowLayout = Command.define('SaveWindowLayout', {
  payload: Schema.Struct({
    windowKey: WindowKey,
    baseRevision: Schema.optional(Schema.NonNegativeInt),
    ...WindowLayout.fields
  }),
  success: LayoutSnapshot,
  failure: LayoutConflict
})

// ── Granular commands: what a caller that is not a window says ──

/** A group's fields a caller may set at creation; the server mints the id
 *  when none is given and stamps the rest as the renderer does. */
export const NewGroup = Schema.Struct({
  id: Schema.optional(Schema.NonEmptyString),
  name: Schema.String,
  sessionIds: Schema.optional(Schema.Array(Schema.String)),
  cwd: Schema.optional(Schema.NullOr(Schema.String)),
  color: Schema.optional(Schema.NullOr(Schema.String)),
  prompt: Schema.optional(Schema.NullOr(Schema.String)),
  rootSession: Schema.optional(Schema.Boolean),
  view: Schema.optional(Schema.NullOr(GroupView)),
  terminals: Schema.optional(Schema.Array(GroupTerminal)),
  workspaceId: Schema.optional(Schema.String)
})
export type NewGroup = typeof NewGroup.Type

export const GroupResult = Schema.Struct({ group: SidebarGroup, layout: LayoutSnapshot })

/** A new group in a window. Its members leave any group they were in; the
 *  group takes the first member's place at the top level, else the end, as
 *  the renderer's own createGroup does. */
export const CreateGroup = Command.define('CreateGroup', {
  payload: Schema.Struct({ windowKey: WindowKey, group: NewGroup }),
  success: GroupResult
})

const GroupRef = { windowKey: WindowKey, groupId: Schema.NonEmptyString }

export const RenameGroup = Command.define('RenameGroup', {
  payload: Schema.Struct({ ...GroupRef, name: Schema.String }),
  success: LayoutSnapshot,
  failure: GroupNotFound
})
export const SetGroupView = Command.define('SetGroupView', {
  payload: Schema.Struct({ ...GroupRef, view: Schema.NullOr(GroupView) }),
  success: LayoutSnapshot,
  failure: GroupNotFound
})
export const SetGroupColor = Command.define('SetGroupColor', {
  payload: Schema.Struct({ ...GroupRef, color: Schema.NullOr(Schema.String) }),
  success: LayoutSnapshot,
  failure: GroupNotFound
})
export const SetGroupPrompt = Command.define('SetGroupPrompt', {
  payload: Schema.Struct({ ...GroupRef, prompt: Schema.NullOr(Schema.String) }),
  success: LayoutSnapshot,
  failure: GroupNotFound
})
export const SetGroupCollapsed = Command.define('SetGroupCollapsed', {
  payload: Schema.Struct({ ...GroupRef, collapsed: Schema.Boolean }),
  success: LayoutSnapshot,
  failure: GroupNotFound
})
/** `dissolve` keeps the members as top-level rows (the explicit ungroup);
 *  `remove` drops the group and its members from the layout (the renderer
 *  closes their sessions beside it). Either way the quick-launch terminals
 *  go with the group. */
export const DeleteGroup = Command.define('DeleteGroup', {
  payload: Schema.Struct({ ...GroupRef, mode: Schema.Literal('dissolve', 'remove') }),
  success: LayoutSnapshot,
  failure: GroupNotFound
})

export const NewGroupTerminal = Schema.Struct({
  ...GroupTerminal.fields,
  id: Schema.optional(Schema.NonEmptyString),
  sessionId: Schema.optional(Schema.NullOr(Schema.String))
})
export const TerminalResult = Schema.Struct({ terminal: GroupTerminal, layout: LayoutSnapshot })

export const AddGroupTerminal = Command.define('AddGroupTerminal', {
  payload: Schema.Struct({ ...GroupRef, terminal: NewGroupTerminal }),
  success: TerminalResult,
  failure: GroupNotFound
})
export const GroupTerminalPatch = Schema.Struct({
  command: Schema.optional(Schema.String),
  commandMode: Schema.optional(TerminalCommandMode),
  color: Schema.optional(Schema.String),
  icon: Schema.optional(Schema.String),
  serverUrl: Schema.optional(Schema.String),
  groupView: Schema.optional(Schema.Boolean),
  sessionId: Schema.optional(Schema.NullOr(Schema.String))
})
export type GroupTerminalPatch = typeof GroupTerminalPatch.Type
export const UpdateGroupTerminal = Command.define('UpdateGroupTerminal', {
  payload: Schema.Struct({
    ...GroupRef,
    terminalId: Schema.NonEmptyString,
    patch: GroupTerminalPatch
  }),
  success: LayoutSnapshot,
  failure: Schema.Union(GroupNotFound, TerminalNotFound)
})
export const RemoveGroupTerminal = Command.define('RemoveGroupTerminal', {
  payload: Schema.Struct({ ...GroupRef, terminalId: Schema.NonEmptyString }),
  success: LayoutSnapshot,
  failure: GroupNotFound
})

export const MovePosition = Schema.Literal('before', 'after', 'inside')
/** The structural edit: rows or groups relative to `targetId`, `null` for
 *  the top level at the end. The rules are `ops.ts`'s `moveLayoutItems`; a
 *  move that changes nothing answers the current snapshot unchanged. */
export const MoveItems = Command.define('MoveItems', {
  payload: Schema.Struct({
    windowKey: WindowKey,
    itemIds: Schema.Array(Schema.String),
    targetId: Schema.NullOr(Schema.String),
    position: MovePosition
  }),
  success: LayoutSnapshot
})
/** A session enters a window's layout: the first row of `groupId`, or the
 *  first row of the sidebar when null. A session already placed stays. */
export const PlaceSession = Command.define('PlaceSession', {
  payload: Schema.Struct({
    windowKey: WindowKey,
    sessionId: Schema.NonEmptyString,
    groupId: Schema.NullOr(Schema.String)
  }),
  success: LayoutSnapshot
})
/** A session leaves a window's layout: out of the order, out of its group,
 *  a terminal it ran detached. The group stays, empty or not. */
export const RemoveSession = Command.define('RemoveSession', {
  payload: Schema.Struct({ windowKey: WindowKey, sessionId: Schema.NonEmptyString }),
  success: LayoutSnapshot
})
/** Groups handed to a window by another: unknown groups and order entries
 *  appended, known ones left alone (`ops.ts`'s `absorbLayout`). */
export const AbsorbLayout = Command.define('AbsorbLayout', {
  payload: Schema.Struct({ windowKey: WindowKey, ...WindowLayout.fields }),
  success: LayoutSnapshot
})

// ── Between windows ──

export const MoveRefusal = Schema.Struct({
  sessionId: Schema.String,
  /** Not live, not tmux-backed (a plain pty's scrollback lives in one
   *  renderer), already in the target window. */
  reason: Schema.Literal('not-live', 'not-tmux', 'same-window')
})
export type MoveRefusal = typeof MoveRefusal.Type
export const MoveResult = Schema.Struct({
  moved: Schema.Array(Schema.String),
  refused: Schema.Array(MoveRefusal)
})
export type MoveResult = typeof MoveResult.Type

/** Live tabs to another window, ids and scrollback kept: the shell detaches
 *  each tmux-backed session from its window and the target re-adopts it;
 *  the layouts of both windows follow. */
export const MoveSessionsToWindow = Command.define('MoveSessionsToWindow', {
  payload: Schema.Struct({
    sessionIds: Schema.Array(Schema.NonEmptyString),
    targetWindowKey: WindowKey,
    /** A deliberate move takes focus in its new window like a spawn does. */
    focus: Schema.optional(Schema.Boolean)
  }),
  success: MoveResult,
  /** `CapabilityUnavailable` from a server that hosts no windows. */
  failure: Schema.Union(WindowNotFound, CapabilityUnavailable)
})
/** A group whole: its object with the members and terminals that could
 *  move, the source dropping its copy. `ok: false` when nothing could move,
 *  and nothing changes anywhere. */
export const MoveGroupToWindow = Command.define('MoveGroupToWindow', {
  payload: Schema.Struct({
    windowKey: WindowKey,
    groupId: Schema.NonEmptyString,
    targetWindowKey: WindowKey
  }),
  success: Schema.Struct({ ok: Schema.Boolean, ...MoveResult.fields }),
  failure: Schema.Union(GroupNotFound, WindowNotFound, CapabilityUnavailable)
})

// ── Events: members of the server's one event union (`../events.ts`) ──

/** A window's layout changed, whoever changed it, with the new snapshot.
 *  `cause` says who: the window's own save (which that window ignores by
 *  revision), a command, a move between windows, a closing window's hand-over. */
export const LayoutChanged = Schema.TaggedStruct('sidebar.layout_changed', {
  layout: LayoutSnapshot,
  cause: Schema.Literal('save', 'command', 'move', 'window-closed', 'orphans')
})
export type LayoutChanged = typeof LayoutChanged.Type
/** A window's layout is gone: it closed and the primary took its groups. */
export const LayoutRemoved = Schema.TaggedStruct('sidebar.layout_removed', {
  windowKey: WindowKey
})
export const SidebarEvent = Schema.Union(LayoutChanged, LayoutRemoved)
export type SidebarEvent = typeof SidebarEvent.Type
