/**
 * The Antasphere account as the windows see it (PRDCT-3259): a read model
 * with nothing in it that could sign a request. The main process owns the
 * login (`src/main/antasphere-account.ts`); what crosses IPC is this shape
 * and only this shape. No token, no authorization URL, no callback query,
 * no error text from the authorization server: a failure crosses as one of
 * the codes below and the renderer puts words on it.
 */

/** Why the last login did not land, as a closed vocabulary. */
export type AntasphereLoginFailure =
  /** The user cancelled from Clave. */
  | 'cancelled'
  /** Nobody finished in the browser before the login's deadline. */
  | 'timeout'
  /** The user refused at the authorization server. */
  | 'denied'
  /** The server could not be reached, answered too slowly, or sent too much. */
  | 'network'
  /** An answer did not validate: metadata, callback, tokens or their signatures. */
  | 'invalid-response'
  /** The server would not register Clave as a public native client. */
  | 'registration'
  /** OS encryption is unavailable, so a login could not be kept safely. */
  | 'storage'
  /** The issuer configured for this process is not acceptable. */
  | 'configuration'
  /** The login lasted as long as its identity did, and could not be renewed. */
  | 'expired'

/** What the ID token said about the person, after validation. */
export interface AntasphereAccountView {
  /** The subject at the issuer: stable, opaque. */
  subject: string
  name: string | null
  email: string | null
  emailVerified: boolean
}

export type AntasphereAccountPhase = 'signed-out' | 'signing-in' | 'signed-in'

export interface AntasphereAccountStatus {
  phase: AntasphereAccountPhase
  /** The person signed in, in the `signed-in` phase only. */
  account: AntasphereAccountView | null
  /** The issuer's host, for the words on screen ("account.antasphere.com"). */
  issuerHost: string
  /** When the current login landed, or null. */
  signedInAt: number | null
  /** When the login session lapses unless renewed, or null. */
  expiresAt: number | null
  /** Whether the session can renew itself without the browser. */
  renewable: boolean
  /** When the login in flight was started, in the `signing-in` phase only. */
  loginStartedAt: number | null
  /** Why the last login did not land, until the next start or dismissal. */
  lastFailure: AntasphereLoginFailure | null
  /** Whether a login could be kept at all on this machine. */
  secureStorage: boolean
}

/**
 * The browser handoff a sign-in answers to the client that asked, and to
 * nobody else: the authorization URL the user's browser is to be sent to,
 * bound to the login generation it belongs to. It rides in the direct answer
 * of the sign-in command (over IPC, or the authenticated HTTP response),
 * never in an event, a push frame, a status, a log line or a file, and the
 * preload hands it to main to open and passes the page the status without
 * it. A handoff whose generation is no longer the login in flight opens
 * nothing.
 */
export interface AntasphereHandoff {
  url: string
  generation: number
}

/** What a sign-in answers: the status as it is once the browser can be
 *  asked, and the handoff, or null when there is no browser to send (the
 *  login failed or was cancelled before its page was built). */
export interface AntasphereSignInResult {
  status: AntasphereAccountStatus
  handoff: AntasphereHandoff | null
}

/** The keys a status may carry: the IPC boundary test asserts nothing else does. */
export const ANTASPHERE_STATUS_KEYS: ReadonlyArray<keyof AntasphereAccountStatus> = [
  'phase',
  'account',
  'issuerHost',
  'signedInAt',
  'expiresAt',
  'renewable',
  'loginStartedAt',
  'lastFailure',
  'secureStorage'
]
