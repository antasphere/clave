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
 * - The Slideless accounts of the server's machine (PRDCT-4266), read off its
 *   own copy of the command line (`profiles --json`): `ListSlidelessAccounts`
 *   and `CheckSlidelessAccounts` list them, `AddSlidelessSite` adds a site,
 *   `SetNewLinksSite` names the site a new deck goes to, `RunSlidelessFix`
 *   runs a profile's check or removal, `StartSlidelessSignIn` /
 *   `AnswerSlidelessSignIn` / `CancelSlidelessSignIn` sign in with an e-mail
 *   code and no terminal, `PasteSlidelessKey` signs in with a key.
 * - An artefact's deck and its links (PRDCT-4266): `GetArtefactDeck` reads
 *   them, `ShareArtefact` pushes the page and makes a link, and
 *   `RevokeArtefactLink` revokes one of the links Clave made.
 *
 * A refusal (no such session, a path that is no artefact, Slideless not
 * ready) is `ArtefactRefused` with the sentence the window shows. A secret a
 * call carries (a sign-in code, a key, a password) is refused for its length
 * with a sentence that never repeats it.
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

// ── The Slideless accounts of a machine (PRDCT-4266) ──
// What the command lists is read field for field from Slideless 0.15.0's
// `profiles --json`. A value the command chooses from a set of its own (a
// state, a kind, an effect) is a plain string on the wire: a newer command's
// value never fails the decoding, and the window reads the ones it knows.

/** A profile's fix: its kind and the command line that applies it, `argv[0]`
 *  the binary's name. Known kinds: `hub_login`, `email_code`, `paste_key`,
 *  `pick_hub` (argv ends with `--hub`), `pick_login` (argv ends with
 *  `--email`), `check`, `remove_profile`. */
export const SlidelessProfileFix = Schema.Struct({
  kind: Schema.String,
  argv: Schema.Array(Schema.String)
})
export type SlidelessProfileFix = typeof SlidelessProfileFix.Type

/** The person a checked key signs in as. */
export const SlidelessPerson = Schema.Struct({
  name: Schema.NullOr(Schema.String),
  email: Schema.String,
  workspace: Schema.NullOr(Schema.String)
})
export type SlidelessPerson = typeof SlidelessPerson.Type

/** One profile of the machine: a Slideless site and how it signs in. */
export const SlidelessProfile = Schema.Struct({
  name: Schema.String,
  default: Schema.Boolean,
  saved: Schema.Boolean,
  site: Schema.Struct({
    origin: Schema.String,
    name: Schema.NullOr(Schema.String),
    hub: Schema.NullOr(Schema.String),
    federated: Schema.NullOr(Schema.Boolean),
    cliVersion: Schema.NullOr(Schema.String),
    seenAt: Schema.NullOr(Schema.String)
  }),
  cliBehind: Schema.NullOr(Schema.Boolean),
  signIn: Schema.Struct({
    /** `signed_in`, `will_sign_in`, `needs_login` or `unknown`. */
    state: Schema.String,
    /** `login` or `key`. */
    via: Schema.NullOr(Schema.String),
    hub: Schema.NullOr(Schema.String),
    email: Schema.NullOr(Schema.String),
    staleKeys: Schema.NullOr(Schema.Number),
    fix: Schema.NullOr(SlidelessProfileFix),
    /** After a check only: `ok`, `key_refused`, `unreachable` or `no_key`. */
    checked: Schema.optional(Schema.String),
    person: Schema.optional(Schema.NullOr(SlidelessPerson))
  }),
  /** The variables of the environment that change this profile: `replaces` or `refuses`. */
  environment: Schema.Array(Schema.Struct({ variable: Schema.String, effect: Schema.String }))
})
export type SlidelessProfile = typeof SlidelessProfile.Type

/** A hub login of the machine, which a hub site signs in through. */
export const SlidelessLogin = Schema.Struct({
  hub: Schema.String,
  email: Schema.NullOr(Schema.String),
  name: Schema.String
})
export type SlidelessLogin = typeof SlidelessLogin.Type

/**
 * The Slideless accounts of a server's machine, as its own copy of the
 * command lists them, with the machine's own « New links go to »
 * (`newLinksSite`, an origin). `checked` says the sign-ins were tried on
 * their sites. When they cannot be listed, `error` is the sentence why (no
 * copy installed; a copy too old, then `needsUpdate`; the command failed)
 * and every other field is empty.
 */
export const SlidelessAccounts = Schema.Struct({
  machine: Schema.NullOr(Schema.String),
  cliVersion: Schema.NullOr(Schema.String),
  defaultSite: Schema.NullOr(Schema.String),
  environment: Schema.Struct({
    url: Schema.NullOr(Schema.String),
    key: Schema.Boolean,
    hubUrl: Schema.NullOr(Schema.String)
  }),
  logins: Schema.Array(SlidelessLogin),
  profiles: Schema.Array(SlidelessProfile),
  newLinksSite: Schema.NullOr(Schema.String),
  checked: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
  needsUpdate: Schema.Boolean
})
export type SlidelessAccounts = typeof SlidelessAccounts.Type

/** A sign-in with an e-mail code, held by the server between its two calls. */
export const SlidelessSignIn = Schema.Struct({
  id: Schema.String,
  origin: Schema.String,
  /** `code_asked`, `done`, `failed` or `cancelled`. */
  phase: Schema.String,
  /** The address the code was sent to, when it is known. */
  email: Schema.NullOr(Schema.String),
  message: Schema.NullOr(Schema.String)
})
export type SlidelessSignIn = typeof SlidelessSignIn.Type

// ── An artefact's deck and its links (PRDCT-4266) ──

/** A link Clave made to an artefact's deck. `url` is a bearer: it travels
 *  only in the answer to the call that asked. */
export const ArtefactShareLink = Schema.Struct({
  tokenId: Schema.String,
  name: Schema.String,
  url: Schema.String,
  createdAt: Schema.String,
  expiresAt: Schema.NullOr(Schema.String),
  pinnedVersion: Schema.NullOr(Schema.Number),
  hasPassword: Schema.Boolean
})
export type ArtefactShareLink = typeof ArtefactShareLink.Type

/**
 * An artefact's deck on a Slideless site, as the server records it, and the
 * links Clave made to it. With no deck recorded, `linkedFolder` is the deck a
 * folder's own link file names (made outside Clave); `staged` says the
 * artefact is one `.html` file, pushed from a copy the server keeps.
 */
export const ArtefactDeck = Schema.Struct({
  target: Schema.String,
  site: Schema.NullOr(Schema.String),
  deckId: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  version: Schema.NullOr(Schema.Number),
  pushedAt: Schema.NullOr(Schema.String),
  links: Schema.Array(ArtefactShareLink),
  linkedFolder: Schema.NullOr(Schema.Struct({ deckId: Schema.String, site: Schema.String })),
  staged: Schema.Boolean
})
export type ArtefactDeck = typeof ArtefactDeck.Type

/** A secret on the wire (a sign-in code, a key, a password): its length is
 *  checked, and the refusal says `what` whatever was sent, never the value. */
const Secret = (what: string, min: number, max?: number): Schema.Schema<string> =>
  (max === undefined
    ? Schema.String.pipe(Schema.minLength(min))
    : Schema.String.pipe(Schema.minLength(min), Schema.maxLength(max))
  ).annotations({ message: () => ({ message: what, override: true }) })

/** What the link lets its recipient do; the switches off are the command's `--no-…`. */
export const ArtefactShareSettings = Schema.Struct({
  /** The owner-facing label, `Clave` when absent. */
  name: Schema.optional(Schema.String),
  /** ISO time the link stops working. */
  expiresAt: Schema.optional(Schema.String),
  /** Given to the command on its input, never on its command line. Exact: an
   *  optional's `undefined` arm would repeat a refused value in its refusal. */
  password: Schema.optionalWith(Secret('A password is at least 4 characters long.', 4), {
    exact: true
  }),
  annotator: Schema.Boolean,
  forms: Schema.Boolean,
  download: Schema.Boolean,
  bar: Schema.Boolean,
  pdf: Schema.Boolean,
  /** The link stays on the version just pushed instead of following the latest. */
  pinVersion: Schema.Boolean
})
export type ArtefactShareSettings = typeof ArtefactShareSettings.Type

/** A link made (`shared`), or the deck Clave knew is no longer on its site
 *  (`deck_gone`): nothing was recorded, and a new deck is the person's call. */
export const ArtefactShareResult = Schema.Union(
  Schema.TaggedStruct('shared', { deck: ArtefactDeck, link: ArtefactShareLink }),
  Schema.TaggedStruct('deck_gone', { deck: ArtefactDeck })
)
export type ArtefactShareResult = typeof ArtefactShareResult.Type

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

// PRDCT-4266: the Slideless accounts of the server's machine.

/** The accounts with each sign-in tried on its site (`profiles --check`). */
export const CheckSlidelessAccounts = Command.define('CheckSlidelessAccounts', {
  payload: Schema.Struct({}),
  success: SlidelessAccounts,
  failure: RefusedOrUnavailable
})

/** Add a Slideless site to the machine (`profiles add <url>`), then list. */
export const AddSlidelessSite = Command.define('AddSlidelessSite', {
  payload: Schema.Struct({ url: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(2048)) }),
  success: SlidelessAccounts,
  failure: RefusedOrUnavailable
})

/** The machine's « New links go to »: one of its sites, or none (`null`). */
export const SetNewLinksSite = Command.define('SetNewLinksSite', {
  payload: Schema.Struct({ origin: Schema.NullOr(Schema.String) }),
  success: SlidelessAccounts,
  failure: RefusedOrUnavailable
})

/** Run the fix a site's profile offers, when it runs without a question (`check`, `remove_profile`). */
export const RunSlidelessFix = Command.define('RunSlidelessFix', {
  payload: Schema.Struct({ origin: Schema.String, kind: Schema.String }),
  success: SlidelessAccounts,
  failure: RefusedOrUnavailable
})

/** Start the e-mail code sign-in of a site: answered once the code is asked
 *  (`code_asked`), or at its end. `hub` picks a login, `email` an account. */
export const StartSlidelessSignIn = Command.define('StartSlidelessSignIn', {
  payload: Schema.Struct({
    origin: Schema.String,
    email: Schema.optional(Schema.String),
    hub: Schema.optional(Schema.String)
  }),
  success: SlidelessSignIn,
  failure: RefusedOrUnavailable
})

/** Give a sign-in its code: answered at its end (`done` or `failed`). */
export const AnswerSlidelessSignIn = Command.define('AnswerSlidelessSignIn', {
  payload: Schema.Struct({
    id: Schema.String,
    code: Secret('A sign-in code is 1 to 64 characters long.', 1, 64)
  }),
  success: SlidelessSignIn,
  failure: RefusedOrUnavailable
})

export const CancelSlidelessSignIn = Command.define('CancelSlidelessSignIn', {
  payload: Schema.Struct({ id: Schema.String }),
  success: Schema.Void,
  failure: CapabilityUnavailable
})

/** Sign a site in with a key, given to the command on its input. */
export const PasteSlidelessKey = Command.define('PasteSlidelessKey', {
  payload: Schema.Struct({
    origin: Schema.String,
    key: Secret('A key is 1 to 512 characters long.', 1, 512)
  }),
  success: SlidelessAccounts,
  failure: RefusedOrUnavailable
})

// PRDCT-4266: an artefact's deck and its links.

/** Push the session's artefact to its deck (a new one on `site` the first
 *  time, or with `newDeck`) and make a link with `link`'s settings. */
export const ShareArtefact = Command.define('ShareArtefact', {
  payload: Schema.Struct({
    sessionId: SessionId,
    target: Target,
    site: Schema.optional(Schema.String),
    newDeck: Schema.optional(Schema.Boolean),
    title: Schema.optional(Schema.String),
    link: ArtefactShareSettings
  }),
  success: ArtefactShareResult,
  failure: RefusedOrUnavailable
})
/** What `ShareArtefact` asks besides the artefact it names. */
export type ArtefactShareRequest = Omit<typeof ShareArtefact.payload.Type, 'sessionId' | 'target'>

/** Revoke one of the links Clave made to the artefact's deck (`unshare --token`). */
export const RevokeArtefactLink = Command.define('RevokeArtefactLink', {
  payload: Schema.Struct({
    sessionId: SessionId,
    target: Target,
    tokenId: Schema.String.pipe(Schema.minLength(1))
  }),
  success: ArtefactDeck,
  failure: RefusedOrUnavailable
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

/** The Slideless accounts of the server's machine (`profiles --json`, PRDCT-4266). */
export const ListSlidelessAccounts = Query.define('ListSlidelessAccounts', {
  payload: Schema.Struct({}),
  success: SlidelessAccounts,
  failure: RefusedOrUnavailable
})

/** The deck and the links of one of the session's artefacts (PRDCT-4266). */
export const GetArtefactDeck = Query.define('GetArtefactDeck', {
  payload: Schema.Struct({ sessionId: SessionId, target: Target }),
  success: ArtefactDeck,
  failure: RefusedOrUnavailable
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
