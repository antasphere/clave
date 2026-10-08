/**
 * Settings domain: the Antasphere account (PRDCT-3259), the optional login
 * of Clave itself with an Antasphere account. The server owns the login:
 * its flow, its token exchange and validation, the sealed session, its
 * renewal and its sign-out run beside the settings managers
 * (`src/main/antasphere-account.ts`), in the app's process while the server
 * runs there and in the standalone server's when it runs alone.
 *
 * What a client reads is the status, a read model with nothing in it that
 * could sign a request: no token, no callback query, no text from the hub.
 * The one thing beyond it is the browser handoff a sign-in answers to the
 * caller that asked: the authorization URL bound to the login's generation,
 * in the command's direct answer only. It is in no event and no query, so
 * it never rides the push channel, and the preload that receives it hands
 * it to the shell to open and the page the status without it.
 */
import { Command, Query } from '@structure-ai/cqrs'
import { Schema } from 'effect'
import { RefusedOrUnavailable } from './failures'

/** Why the last login did not land (`src/shared/antasphere-account-types.ts`). */
export const AntasphereLoginFailure = Schema.Literal(
  'cancelled',
  'timeout',
  'denied',
  'network',
  'invalid-response',
  'registration',
  'storage',
  'configuration',
  'expired'
)

/** What the ID token said about the person, after validation. */
export const AntasphereAccountView = Schema.Struct({
  subject: Schema.String,
  name: Schema.NullOr(Schema.String),
  email: Schema.NullOr(Schema.String),
  emailVerified: Schema.Boolean
})

export const AntasphereAccountPhase = Schema.Literal('signed-out', 'signing-in', 'signed-in')

/** The account as every client sees it: the same nine fields the window's
 *  store mirrors, and never one more. */
export const AntasphereAccountStatusView = Schema.Struct({
  phase: AntasphereAccountPhase,
  account: Schema.NullOr(AntasphereAccountView),
  issuerHost: Schema.String,
  signedInAt: Schema.NullOr(Schema.Number),
  expiresAt: Schema.NullOr(Schema.Number),
  renewable: Schema.Boolean,
  loginStartedAt: Schema.NullOr(Schema.Number),
  lastFailure: Schema.NullOr(AntasphereLoginFailure),
  secureStorage: Schema.Boolean
})

/** The browser handoff: for the caller of the sign-in, and nobody else. */
export const AntasphereHandoffView = Schema.Struct({
  url: Schema.String,
  generation: Schema.Number
})

/** `antasphere-account:get` */
export const ReadAntasphereAccount = Query.define('ReadAntasphereAccount', {
  payload: Schema.Struct({}),
  success: AntasphereAccountStatusView
})

/**
 * `antasphere-account:sign-in`: start a login, or, while one waits on the
 * browser, answer that same login's handoff again. The answer is the status
 * once the authorization page is built, and the handoff, or null when the
 * login ended before the page was ready. A server with no account behind it
 * answers `CapabilityUnavailable`.
 */
export const SignInWithAntasphere = Command.define('SignInWithAntasphere', {
  payload: Schema.Struct({}),
  success: Schema.Struct({
    status: AntasphereAccountStatusView,
    handoff: Schema.NullOr(AntasphereHandoffView)
  }),
  failure: RefusedOrUnavailable
})

/**
 * `antasphere-account:confirm-handoff`: whether a handoff is the one issued
 * for the login in flight, URL and generation exactly, as the manager that
 * issued it sees it now. A read: it starts, reopens and changes nothing.
 * The shell asks it right before opening the browser, so a cancel, a
 * sign-out or a new login between the sign-in's answer and the open leaves
 * a link that opens nothing. The URL travels redacted: it belongs in no log.
 */
export const ConfirmAntasphereHandoff = Command.define('ConfirmAntasphereHandoff', {
  payload: Schema.Struct({
    url: Schema.Redacted(Schema.String),
    generation: Schema.Number
  }),
  success: Schema.Struct({ current: Schema.Boolean }),
  failure: RefusedOrUnavailable
})

/** `antasphere-account:cancel`: stop the login in flight. */
export const CancelAntasphereSignIn = Command.define('CancelAntasphereSignIn', {
  payload: Schema.Struct({}),
  success: AntasphereAccountStatusView,
  failure: RefusedOrUnavailable
})

/** `antasphere-account:sign-out`: forget the login here; the hub's own session is not touched. */
export const SignOutOfAntasphere = Command.define('SignOutOfAntasphere', {
  payload: Schema.Struct({}),
  success: AntasphereAccountStatusView,
  failure: RefusedOrUnavailable
})

/** `antasphere-account:dismiss`: clear the failure the status shows. */
export const DismissAntasphereFailure = Command.define('DismissAntasphereFailure', {
  payload: Schema.Struct({}),
  success: AntasphereAccountStatusView,
  failure: RefusedOrUnavailable
})

/** `antasphere-account:changed`: the status, whoever changed it; never the handoff. */
export const AntasphereAccountChanged = Schema.TaggedStruct('accounts.antasphere_changed', {
  status: AntasphereAccountStatusView
})
