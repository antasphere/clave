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
 *   one `.html` file; the link replaces the session's previous one.
 * - `CloseArtefact`: drop the session's link.
 * - `HoldArtefactPreview` / `ReleaseArtefactPreview`: a window holds the
 *   running preview of the session's artefact, renewing the hold before its
 *   time runs out, and releases it when it stops showing the page.
 * - `SaveArtefactVersion`: save a version of the artefact now.
 * - `InstallSlideless`: install, or update to, the registry's latest release.
 * - `ListArtefacts`, `GetSlidelessState`: what is linked, and the command line.
 *
 * A refusal (no such session, a path that is no artefact, Slideless not
 * ready) is `ArtefactRefused` with the sentence the window shows.
 */
import { Schema } from 'effect'
import { Command, Query } from '@structure-ai/cqrs'
import { ApiGroup, HttpCqrs } from '@structure-ai/http'
import { CapabilityUnavailable } from './errors'
import { isForwardLease } from './forward'

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

/** The server said no; `message` is the sentence shown to the person. */
export class ArtefactRefused extends Schema.TaggedError<ArtefactRefused>()('ArtefactRefused', {
  message: Schema.String
}) {}

/** What an artefacts call may answer besides its result: refused, or not carried here. */
export const RefusedOrUnavailable = Schema.Union(ArtefactRefused, CapabilityUnavailable)

const SessionId = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256))
const HoldId = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128))

// ── Commands ──

export const OpenArtefact = Command.define('OpenArtefact', {
  payload: Schema.Struct({
    sessionId: SessionId,
    path: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4096))
  }),
  success: Artefact,
  failure: RefusedOrUnavailable
})

export const CloseArtefact = Command.define('CloseArtefact', {
  payload: Schema.Struct({ sessionId: SessionId }),
  success: Schema.Void,
  failure: CapabilityUnavailable
})

export const HoldArtefactPreview = Command.define('HoldArtefactPreview', {
  payload: Schema.Struct({ sessionId: SessionId, holdId: Schema.optional(HoldId) }),
  success: ArtefactPreview,
  failure: RefusedOrUnavailable
})

export const ReleaseArtefactPreview = Command.define('ReleaseArtefactPreview', {
  payload: Schema.Struct({ sessionId: SessionId, holdId: HoldId }),
  success: Schema.Void,
  failure: CapabilityUnavailable
})

export const SaveArtefactVersion = Command.define('SaveArtefactVersion', {
  payload: Schema.Struct({ sessionId: SessionId }),
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

export const GetSlidelessState = Query.define('GetSlidelessState', {
  payload: Schema.Struct({}),
  success: SlidelessState,
  failure: CapabilityUnavailable
})

// ── Events ──

/** A session's artefact was opened or replaced, or closed (null). */
export const ArtefactChanged = Schema.TaggedStruct('artefact.changed', {
  sessionId: Schema.String,
  artefact: Schema.NullOr(Artefact)
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
  ArtefactPreviewExited,
  SlidelessStateChanged
)
export type ArtefactEvent = typeof ArtefactEvent.Type

export const artefactsGroup = ApiGroup.make('artefacts')
  .add(HttpCqrs.queryEndpoint('list', '/artefacts', ListArtefacts))
  .add(HttpCqrs.queryEndpoint('slidelessState', '/artefacts/slideless', GetSlidelessState))
  .add(HttpCqrs.commandEndpoint('open', '/artefacts/open', OpenArtefact))
  .add(HttpCqrs.commandEndpoint('close', '/artefacts/close', CloseArtefact))
  .add(HttpCqrs.commandEndpoint('hold', '/artefacts/hold', HoldArtefactPreview))
  .add(HttpCqrs.commandEndpoint('release', '/artefacts/release', ReleaseArtefactPreview))
  .add(HttpCqrs.commandEndpoint('saveVersion', '/artefacts/save-version', SaveArtefactVersion))
  .add(
    HttpCqrs.commandEndpoint('installSlideless', '/artefacts/slideless/install', InstallSlideless)
  )
