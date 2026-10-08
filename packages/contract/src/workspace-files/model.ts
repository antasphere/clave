/**
 * The workspace files domain: the `.clave` files Clave reads, writes, watches
 * and trusts (wave 3, lane A, PRDCT-3291). A `.clave` file describes a group
 * of sessions and terminals; it can act the moment it is opened (run a
 * command, auto-submit a prompt, start an agent with its permissions off),
 * so a file nobody trusted is REVIEWED before its elevated fields reach a
 * window: the server publishes `workspace_files.review_needed` and holds the
 * read until `AnswerWorkspaceFileReview` arrives, or the review times out
 * and reads as Cancel. The dialog itself is the client's (the Electron
 * shell's); the server only knows what it would disclose.
 *
 * Mirrors the preload's `.clave` methods as of this change
 * (`src/preload/index.ts`), and is place 3 of the six-place mirror rule in
 * the app's CLAUDE.md: the shape here, the parser and the writer in
 * `@clave/server/workspace-files`, the trust boundary beside them.
 */
import { Command, Query } from '@structure-ai/cqrs'
import { Schema } from 'effect'

// ---------------------------------------------------------------------------
// The file shape, resolved: every path absolute, the logo a data URL.
// ---------------------------------------------------------------------------

export const ClaveSession = Schema.Struct({
  cwd: Schema.String,
  name: Schema.String,
  claudeMode: Schema.Boolean,
  antigravityMode: Schema.Boolean,
  codexMode: Schema.Boolean,
  piMode: Schema.optional(Schema.Boolean),
  claudeAgentsMode: Schema.optional(Schema.Boolean),
  dangerousMode: Schema.Boolean,
  /** Auto-submitted to the agent on launch: elevated. */
  prompt: Schema.optional(Schema.String),
  rootSession: Schema.optional(Schema.Boolean),
  /** The account by label, or `any` (ADR 0002): routes the session, drives nothing. */
  account: Schema.optional(Schema.String)
})
export type ClaveSession = typeof ClaveSession.Type

export const ClaveTerminal = Schema.Struct({
  command: Schema.String,
  /** `auto` runs the command on launch without a keypress: elevated. */
  commandMode: Schema.Literal('prefill', 'auto'),
  color: Schema.String,
  icon: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  autoLaunchLocalhost: Schema.optional(Schema.Boolean),
  persistent: Schema.optional(Schema.Boolean),
  serverUrl: Schema.optional(Schema.String),
  /** Bind this terminal's `serverUrl` as the group's web view at launch: elevated. */
  groupView: Schema.optional(Schema.Boolean)
})
export type ClaveTerminal = typeof ClaveTerminal.Type

/** A terminal as a window hands it to the writer: its `cwd` may be null
 *  (a terminal with no folder of its own), which the writer drops. */
export const ClaveTerminalWrite = Schema.Struct({
  ...ClaveTerminal.fields,
  cwd: Schema.optional(Schema.NullOr(Schema.String))
})
export type ClaveTerminalWrite = typeof ClaveTerminalWrite.Type

const groupFields = {
  name: Schema.String,
  cwd: Schema.String,
  color: Schema.NullOr(Schema.String),
  toolbar: Schema.optional(Schema.Boolean),
  category: Schema.optional(Schema.String),
  logo: Schema.optional(Schema.String),
  /** The group's default prompt, auto-submitted by its `+`: elevated. */
  prompt: Schema.optional(Schema.String),
  /** The group's web view when no terminal serves it: elevated. */
  view: Schema.optional(Schema.String),
  sessions: Schema.Array(ClaveSession),
  terminals: Schema.Array(ClaveTerminal)
}

export const ClaveGroup = Schema.Struct(groupFields)
export type ClaveGroup = typeof ClaveGroup.Type

/** What a read answers: one group (`single`) or a list of them (`multi`). */
export const ClaveFileReadResult = Schema.Union(
  Schema.Struct({ type: Schema.Literal('single'), ...groupFields }),
  Schema.Struct({ type: Schema.Literal('multi'), groups: Schema.Array(ClaveGroup) })
)
export type ClaveFileReadResult = typeof ClaveFileReadResult.Type

// ---------------------------------------------------------------------------
// The write shape: what a window hands the writer, paths absolute, which the
// writer makes relative to the file's root.
// ---------------------------------------------------------------------------

const writeGroupFields = {
  name: Schema.String,
  cwd: Schema.NullOr(Schema.String),
  color: Schema.NullOr(Schema.String),
  toolbar: Schema.optional(Schema.Boolean),
  category: Schema.optional(Schema.String),
  logo: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  view: Schema.optional(Schema.String),
  sessions: Schema.Array(ClaveSession),
  terminals: Schema.Array(ClaveTerminalWrite)
}
export const ClaveFileWriteGroup = Schema.Struct(writeGroupFields)
export type ClaveFileWriteGroup = typeof ClaveFileWriteGroup.Type

export const ClaveFileWriteData = Schema.Struct({
  name: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.NullOr(Schema.String)),
  color: Schema.optional(Schema.NullOr(Schema.String)),
  toolbar: Schema.optional(Schema.Boolean),
  category: Schema.optional(Schema.String),
  logo: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  view: Schema.optional(Schema.String),
  sessions: Schema.optional(Schema.Array(ClaveSession)),
  terminals: Schema.optional(Schema.Array(ClaveTerminalWrite)),
  /** Present for a multi-group file; the single-group fields are ignored then. */
  groups: Schema.optional(Schema.Array(ClaveFileWriteGroup))
})
export type ClaveFileWriteData = typeof ClaveFileWriteData.Type

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** A `.clave` found in a folder: `workspace.clave` resolves against its own
 *  directory (`rootDir` null), one under `.clave/workspaces/` against the folder. */
export const DiscoveredFile = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  rootDir: Schema.NullOr(Schema.String)
})
export type DiscoveredFile = typeof DiscoveredFile.Type

/** A `.clave` found by the recursive walk: `rootDir` is the project folder. */
export const DiscoveredProjectFile = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  rootDir: Schema.String
})
export type DiscoveredProjectFile = typeof DiscoveredProjectFile.Type

export const AutoDiscoverConfig = Schema.Struct({
  enabled: Schema.Boolean,
  patterns: Schema.optional(Schema.Array(Schema.String)),
  exclude: Schema.optional(Schema.Array(Schema.String)),
  maxDepth: Schema.optional(Schema.Number)
})
export type AutoDiscoverConfig = typeof AutoDiscoverConfig.Type

// ---------------------------------------------------------------------------
// The review
// ---------------------------------------------------------------------------

/** The dialog's three buttons, in the order the shell shows them. */
export const ReviewResponse = Schema.Literal(0, 1, 2)
export type ReviewResponse = typeof ReviewResponse.Type
export const REVIEW_OPEN_SAFELY = 0
export const REVIEW_TRUST_AND_RUN = 1
export const REVIEW_CANCEL = 2

/** What the person answered: a button, and whether the folder checkbox was ticked. */
export const ReviewAnswer = Schema.Struct({
  response: ReviewResponse,
  checkboxChecked: Schema.Boolean
})
export type ReviewAnswer = typeof ReviewAnswer.Type

/** No review carries that id: answered already, timed out, or never asked. */
export class ReviewNotFound extends Schema.TaggedError<ReviewNotFound>()('ReviewNotFound', {
  reviewId: Schema.String
}) {}

// ---------------------------------------------------------------------------
// Commands and queries
// ---------------------------------------------------------------------------

/** `clave:read-file`. A command, not a query: a read may trust content and
 *  ask for a review. `requestId` is the caller's own mark, carried on the
 *  review event so the client that asked knows the review is its own. The
 *  answer is null when the file cannot be read or the review was cancelled. */
export const ReadWorkspaceFile = Command.define('ReadWorkspaceFile', {
  payload: Schema.Struct({
    path: Schema.String,
    rootDir: Schema.optional(Schema.String),
    requestId: Schema.optional(Schema.String)
  }),
  success: Schema.NullOr(ClaveFileReadResult)
})

/** `clave:write-file`: the file written with relative paths, its content trusted as authored. */
export const WriteWorkspaceFile = Command.define('WriteWorkspaceFile', {
  payload: Schema.Struct({
    path: Schema.String,
    data: ClaveFileWriteData,
    rootDir: Schema.optional(Schema.String)
  }),
  success: Schema.Void
})

/** Who holds a watch: a window names itself, so two windows on one file are
 *  two holders and one window's release does not close the other's watcher.
 *  A window reaching the SAME server instance over two roads (IPC and the
 *  in-process server) names each road apart, so a watch handed from one road
 *  to the other is never released on the road that took it over. */
const Holder = Schema.optional(Schema.String)

/** `clave:watch-file`: changes on disk reach every client as `workspace_files.changed`. */
export const WatchWorkspaceFile = Command.define('WatchWorkspaceFile', {
  payload: Schema.Struct({ path: Schema.String, holder: Holder }),
  success: Schema.Void
})

/** `clave:unwatch-file`: the holder's watch released; the watcher closes with its last holder. */
export const UnwatchWorkspaceFile = Command.define('UnwatchWorkspaceFile', {
  payload: Schema.Struct({ path: Schema.String, holder: Holder }),
  success: Schema.Void
})

/** `clave:file-exists` */
export const WorkspaceFileExists = Query.define('WorkspaceFileExists', {
  payload: Schema.Struct({ path: Schema.String }),
  success: Schema.Boolean
})

/** `clave:discover-files`: `workspace.clave` and `.clave/workspaces/*.clave` in one folder. */
export const DiscoverWorkspaceFiles = Query.define('DiscoverWorkspaceFiles', {
  payload: Schema.Struct({ folder: Schema.String }),
  success: Schema.Array(DiscoveredFile)
})

/** A list on a GET, carried as one JSON-encoded parameter: repeated keys
 *  would lose an empty list (no key at all) and read one value as a string,
 *  and an empty `exclude` means "exclude nothing", not the defaults. */
const StringList = Schema.parseJson(Schema.Array(Schema.String))

/** `clave:discover-files-recursive`: every project workspace file under a
 *  root, the root's own file included when it has one (the renderer skips
 *  the profile file it already holds). */
export const DiscoverWorkspaceFilesRecursive = Query.define('DiscoverWorkspaceFilesRecursive', {
  payload: Schema.Struct({
    rootDir: Schema.String,
    patterns: Schema.optional(StringList),
    exclude: Schema.optional(StringList),
    maxDepth: Schema.optional(Schema.NumberFromString),
    workspaceId: Schema.optional(Schema.String)
  }),
  success: Schema.Array(DiscoveredProjectFile)
})

/** `clave:read-auto-discover`: the `autoDiscover` key of a file, or null. */
export const ReadAutoDiscoverConfig = Query.define('ReadAutoDiscoverConfig', {
  payload: Schema.Struct({ path: Schema.String }),
  success: Schema.NullOr(AutoDiscoverConfig)
})

/** `clave:read-image`: an image on the server's disk as a data URL, or null. */
export const ReadWorkspaceImage = Query.define('ReadWorkspaceImage', {
  payload: Schema.Struct({ path: Schema.String }),
  success: Schema.NullOr(Schema.String)
})

/** `clave:trust-root`: every `.clave` under the folder skips the review. */
export const TrustWorkspaceRoot = Command.define('TrustWorkspaceRoot', {
  payload: Schema.Struct({ root: Schema.String }),
  success: Schema.Void
})

/** `clave:untrust-root` */
export const UntrustWorkspaceRoot = Command.define('UntrustWorkspaceRoot', {
  payload: Schema.Struct({ root: Schema.String }),
  success: Schema.Void
})

/** `clave:list-trusted-roots` */
export const ListTrustedRoots = Query.define('ListTrustedRoots', {
  payload: Schema.Struct({}),
  success: Schema.Array(Schema.String)
})

/** The client's word on a review the server asked for. */
export const AnswerWorkspaceFileReview = Command.define('AnswerWorkspaceFileReview', {
  payload: Schema.Struct({ reviewId: Schema.String, ...ReviewAnswer.fields }),
  success: Schema.Void,
  failure: ReviewNotFound
})

// ---------------------------------------------------------------------------
// Events: members of the server's one event union (`../events.ts`).
// ---------------------------------------------------------------------------

/** `clave:file-changed`: a watched file changed on disk (not by the server's own write). */
export const WorkspaceFileChanged = Schema.TaggedStruct('workspace_files.changed', {
  path: Schema.String
})

/** A read met an elevated file nobody trusted: what the dialog must disclose,
 *  and the id the answer names. `requestId` is the reader's own mark, null
 *  when the reader gave none. */
export const WorkspaceFileReviewNeeded = Schema.TaggedStruct('workspace_files.review_needed', {
  reviewId: Schema.String,
  requestId: Schema.NullOr(Schema.String),
  path: Schema.String,
  /** The folder the checkbox would trust: the root dir given, else the file's own. */
  folder: Schema.String,
  autoCommands: Schema.Array(Schema.String),
  prompts: Schema.Array(Schema.String),
  dangerous: Schema.Boolean
})

export const WorkspaceFilesEvent = Schema.Union(WorkspaceFileChanged, WorkspaceFileReviewNeeded)
export type WorkspaceFilesEvent = typeof WorkspaceFilesEvent.Type
