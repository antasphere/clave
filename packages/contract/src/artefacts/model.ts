/**
 * The artefacts domain (PRDCT-4472): an HTML page, document or deck an agent
 * made, shown beside its session. The SERVER a session runs on owns the
 * session's artefact, in every mode: it keeps the link between the session
 * and the page, runs the Slideless preview beside the files with its own
 * copy of the command line, and saves a version at each finished turn with
 * no window anywhere. A window holds a preview to show it, through the
 * forwarder (`forward.ts`), and lets go when it no longer shows it.
 *
 * - `OpenArtefact`: link a session to a folder holding an HTML page, or to
 *   one `.html` file; a session keeps several (PRDCT-5022), and the one
 *   opened comes in front. With `present`, the windows are also told to
 *   present it in a window of its own.
 * - `CloseArtefact`: drop one of the session's links (`target`), or all of them.
 * - The calls that name a `target` act on that artefact of the session, the
 *   front one when it is absent.
 * - `HoldArtefactPreview` / `ReleaseArtefactPreview`: a window holds the
 *   running preview of the session's artefact, renewing the hold before its
 *   time runs out, and releases it when it stops showing the page.
 * - `SaveArtefactVersion`: save a version of the artefact now.
 * - `InstallSlideless`: install, or update to, the registry's latest release.
 * - `ListArtefacts`, `GetSlidelessState`: what is linked, and the command line.
 *
 * A refusal (no such session, a path that is no artefact, Slideless not
 * ready) is `ArtefactRefused` with the sentence the window shows.
 *
 * This file is the model: the shapes, the commands, the queries and the
 * events, with no HTTP in it, so the window imports its types without
 * loading the framework's HTTP source (the routines' `model.ts` is split the
 * same way). The API group is `../artefacts.ts`.
 */
import { Schema } from 'effect'
import { Command, Query } from '@structure-ai/cqrs'
import { CapabilityUnavailable } from '../errors'
import { isForwardLease } from '../forward'

/** The Slideless command line as this server manages it. Field for field
 *  `src/shared/slideless.ts`' own (`artefacts.test.ts` holds them together). */
export const SlidelessState = Schema.Struct({
  /** missing: not installed (or too old); installing: a download runs; ready: a CLI runs artefacts; error: the last install failed. */
  phase: Schema.Literal('missing', 'installing', 'ready', 'error'),
  version: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  /** The CLI comes from CLAVE_SLIDELESS_CLI, not from the server's own install. */
  override: Schema.optional(Schema.Boolean)
})
export type SlidelessState = typeof SlidelessState.Type

/** A session's artefact, as the server links it. */
export const Artefact = Schema.Struct({
  sessionId: Schema.String,
  /** The folder, or the one `.html` file, absolute on this server. */
  target: Schema.String,
  /** The entry page, absolute: the folder's index page, or the file itself. */
  page: Schema.String,
  /** The folder's name, or the file's. */
  title: Schema.String,
  /** When it was opened, ISO time. */
  openedAt: Schema.String
})
export type Artefact = typeof Artefact.Type

/** A preview held by a window: the forward lease to reach it, and its address
 *  on this server's own loopback. */
export const ArtefactPreview = Schema.Struct({
  holdId: Schema.String,
  lease: Schema.String.pipe(
    Schema.filter(isForwardLease, { message: () => 'Not a forward lease' })
  ),
  url: Schema.String,
  /** How long the hold lives unless it is renewed. */
  ttlMs: Schema.Number
})
export type ArtefactPreview = typeof ArtefactPreview.Type

export const ArtefactVersion = Schema.Struct({
  version: Schema.Number,
  /** False when nothing changed since the last version: nothing was written. */
  created: Schema.Boolean
})
export type ArtefactVersion = typeof ArtefactVersion.Type

/** One kept version of an artefact, as its preview lists it (PRDCT-4494). */
export const ArtefactVersionEntry = Schema.Struct({
  version: Schema.Number,
  createdAt: Schema.String,
  fileCount: Schema.Number
})
export type ArtefactVersionEntry = typeof ArtefactVersionEntry.Type

/** The versions an artefact's preview keeps, oldest first; `error` when they cannot be read. */
export const ArtefactVersions = Schema.Struct({
  versions: Schema.Array(ArtefactVersionEntry),
  error: Schema.optional(Schema.String)
})
export type ArtefactVersions = typeof ArtefactVersions.Type

/** The server said no; `message` is the sentence shown to the person. */
export class ArtefactRefused extends Schema.TaggedError<ArtefactRefused>()('ArtefactRefused', {
  message: Schema.String
}) {}

/** What an artefacts call may answer besides its result: refused, or not carried here. */
export const RefusedOrUnavailable = Schema.Union(ArtefactRefused, CapabilityUnavailable)

const SessionId = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256))
const HoldId = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128))
/** One of a session's artefacts (PRDCT-5022), by its folder or file; absent, the front one. */
const Target = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4096))

// ── Commands ──

export const OpenArtefact = Command.define('OpenArtefact', {
  payload: Schema.Struct({
    sessionId: SessionId,
    path: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4096)),
    /** Present it too (PRDCT-4980): the window that holds the session shows the
     *  deck alone in a window of its own (`artefact.present_requested`). */
    present: Schema.optional(Schema.Boolean)
  }),
  success: Artefact,
  failure: RefusedOrUnavailable
})

export const CloseArtefact = Command.define('CloseArtefact', {
  payload: Schema.Struct({ sessionId: SessionId, target: Schema.optional(Target) }),
  success: Schema.Void,
  failure: CapabilityUnavailable
})

export const HoldArtefactPreview = Command.define('HoldArtefactPreview', {
  payload: Schema.Struct({
    sessionId: SessionId,
    holdId: Schema.optional(HoldId),
    target: Schema.optional(Target)
  }),
  success: ArtefactPreview,
  failure: RefusedOrUnavailable
})

export const ReleaseArtefactPreview = Command.define('ReleaseArtefactPreview', {
  payload: Schema.Struct({ sessionId: SessionId, holdId: HoldId }),
  success: Schema.Void,
  failure: CapabilityUnavailable
})

export const SaveArtefactVersion = Command.define('SaveArtefactVersion', {
  payload: Schema.Struct({ sessionId: SessionId, target: Schema.optional(Target) }),
  success: ArtefactVersion,
  failure: RefusedOrUnavailable
})

export const InstallSlideless = Command.define('InstallSlideless', {
  payload: Schema.Struct({}),
  success: SlidelessState,
  failure: CapabilityUnavailable
})

// ── Queries ──

export const ListArtefacts = Query.define('ListArtefacts', {
  payload: Schema.Struct({}),
  success: Schema.Array(Artefact),
  failure: CapabilityUnavailable
})

/** The versions of the session's artefact, read from its running preview (PRDCT-4494). */
export const ListArtefactVersions = Query.define('ListArtefactVersions', {
  payload: Schema.Struct({ sessionId: SessionId, target: Schema.optional(Target) }),
  success: ArtefactVersions,
  failure: RefusedOrUnavailable
})

export const GetSlidelessState = Query.define('GetSlidelessState', {
  payload: Schema.Struct({}),
  success: SlidelessState,
  failure: CapabilityUnavailable
})

// ── Events ──

/** A session's artefacts changed: `artefact` is its front one (the one opened, or
 *  null once none is left), `artefacts` all of them, oldest first, the front last
 *  (PRDCT-5022; absent from an older server, which keeps one per session). */
export const ArtefactChanged = Schema.TaggedStruct('artefact.changed', {
  sessionId: Schema.String,
  artefact: Schema.NullOr(Artefact),
  artefacts: Schema.optional(Schema.Array(Artefact))
})
/** The agent asked to present the session's artefact (PRDCT-4980): the window
 *  holding the session opens it in a window of its own. Never kept:
 *  a window that starts later presents nothing. */
export const ArtefactPresentRequested = Schema.TaggedStruct('artefact.present_requested', {
  sessionId: Schema.String
})
/** The preview died under its holders: a window that shows it holds again. */
export const ArtefactPreviewExited = Schema.TaggedStruct('artefact.preview_exited', {
  sessionId: Schema.String
})
/** The command line's state changed (an install started, ended or failed). */
export const SlidelessStateChanged = Schema.TaggedStruct('slideless.state_changed', {
  state: SlidelessState
})
export const ArtefactEvent = Schema.Union(
  ArtefactChanged,
  ArtefactPresentRequested,
  ArtefactPreviewExited,
  SlidelessStateChanged
)
export type ArtefactEvent = typeof ArtefactEvent.Type
