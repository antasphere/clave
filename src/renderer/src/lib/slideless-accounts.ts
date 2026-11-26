/**
 * The words of Settings › Slideless and of « Create link » (PRDCT-4266): what
 * a machine's Slideless listing says of each site, read for the screens. One
 * plain module, so the page, the dialog and their test read the same rule.
 *
 * The listing is the command's own (`profiles --json`, `packages/contract/src/
 * artefacts/model.ts`): a value the command chooses from a set of its own (a
 * state, a fix's kind, a check's answer) is a plain string, and a value these
 * readers do not know says nothing rather than something wrong.
 */
import type {
  ArtefactShareSettings,
  SlidelessAccounts,
  SlidelessLogin,
  SlidelessProfile,
  SlidelessProfileFix
} from '@clave/contract/artefacts/model'

/**
 * A site's origin in the one form it is compared in, the server's own
 * (`src/main/artefacts/slideless-settings.ts`): the scheme and the host
 * lowercased, the default port dropped, no trailing slash. A value that is no
 * http(s) address is only trimmed of its spaces and its trailing slashes.
 */
export function normalOrigin(value: string): string {
  const text = value.trim()
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return text.replace(/\/+$/, '')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return text.replace(/\/+$/, '')
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`
}

export const sameOrigin = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && normalOrigin(a) === normalOrigin(b)

/** The host of a site or a hub (`decks.example.test`, `127.0.0.1:3400`); the text when it is no address. */
export function hostOf(origin: string): string {
  try {
    const url = new URL(origin.trim())
    return url.host || origin
  } catch {
    return origin
  }
}

/** What a profile is called on screen: its site's name, else its host. */
export const profileTitle = (profile: SlidelessProfile): string =>
  profile.site.name ?? hostOf(profile.site.origin)

/** The profile of a site, the origins compared in normal form. */
export const profileAt = (
  accounts: SlidelessAccounts | null,
  origin: string | null | undefined
): SlidelessProfile | undefined =>
  origin ? accounts?.profiles.find((p) => sameOrigin(p.site.origin, origin)) : undefined

/** A site as a sentence names it: the profile's title when it is a site of the listing, else its host. */
export const siteLabel = (accounts: SlidelessAccounts | null, origin: string): string => {
  const profile = profileAt(accounts, origin)
  return profile ? profileTitle(profile) : hostOf(origin)
}

/** Who signs the site in, in one line; only what is known. */
export function signInLine(profile: SlidelessProfile): string {
  const { state, via, email, hub, staleKeys } = profile.signIn
  if (state === 'unknown' || staleKeys === null) return 'Not checked yet'
  if (state === 'will_sign_in')
    return email
      ? `Signs in by itself at its first use, as ${email}`
      : 'Signs in by itself at its first use'
  if (state === 'needs_login') return 'Not signed in'
  // A state this window does not know says nothing rather than something wrong.
  if (state !== 'signed_in') return ''
  if (via === 'key')
    return email ? `Signed in with its own key as ${email}` : 'Signed in with its own key'
  if (via === 'login') {
    const as = email ? ` as ${email}` : ''
    const through = hub ? ` through ${hostOf(hub)}` : ''
    return `Signed in${as}${through}`
  }
  return 'Signed in'
}

/** What the check said of the site, in one line; null before a check, or for an answer not known here. */
export function checkLine(profile: SlidelessProfile, checked: boolean): string | null {
  if (!checked) return null
  const { person } = profile.signIn
  switch (profile.signIn.checked) {
    case 'ok':
      return person ? `Answers as ${person.name ?? person.email}` : 'The site took the key'
    case 'key_refused':
      return 'The site refused the key'
    case 'unreachable':
      return 'The site did not answer'
    case 'no_key':
      return 'No key to check'
    default:
      return null
  }
}

/** Clave's command older than the site, in one line; null when it is not. */
export function behindLine(profile: SlidelessProfile, cliVersion: string | null): string | null {
  if (profile.cliBehind !== true) return null
  const ours = cliVersion ? `Clave's Slideless ${cliVersion}` : "Clave's Slideless"
  const theirs = profile.site.cliVersion ? `this site's ${profile.site.cliVersion}` : 'this site'
  return `${ours} is older than ${theirs}`
}

/** What each variable of the environment does to the site here, one line each. */
export function environmentLines(profile: SlidelessProfile): string[] {
  return profile.environment.flatMap(({ variable, effect }) =>
    effect === 'replaces'
      ? [`${variable} replaces this account's key here`]
      : effect === 'refuses'
        ? [`${variable} refuses this site here`]
        : []
  )
}

/** The tone of a sign-in state as `.status-text`'s `data-status` takes it: the
 *  green of a site that signs in, the amber of one that needs a sign-in, quiet
 *  otherwise. */
export type StatusTone = 'connected' | 'connecting' | undefined

export function signInStatus(state: string): { label: string; tone: StatusTone } {
  switch (state) {
    case 'signed_in':
      return { label: 'Signed in', tone: 'connected' }
    case 'will_sign_in':
      return { label: 'Will sign in', tone: 'connected' }
    case 'needs_login':
      return { label: 'Sign-in needed', tone: 'connecting' }
    case 'unknown':
      return { label: 'Unknown', tone: undefined }
    default:
      return { label: state.replace(/_/g, ' '), tone: undefined }
  }
}

/** The fixes that sign in with an e-mail code (the server's `SIGN_IN_KINDS`). */
export const SIGN_IN_KINDS: readonly string[] = [
  'hub_login',
  'email_code',
  'pick_hub',
  'pick_login'
]

/** The one action a row offers, from its fix: a sign-in (asking a hub, an
 *  address, or nothing more), a key to paste, a check, a removal; none for a
 *  kind this window does not know. */
export type ProfileAction =
  | { kind: 'sign_in'; asks: 'nothing' | 'hub' | 'address' }
  | { kind: 'paste_key' }
  | { kind: 'check' }
  | { kind: 'remove' }

export function actionOf(fix: SlidelessProfileFix | null): ProfileAction | null {
  switch (fix?.kind) {
    case 'hub_login':
    case 'email_code':
      return { kind: 'sign_in', asks: 'nothing' }
    case 'pick_hub':
      return { kind: 'sign_in', asks: 'hub' }
    case 'pick_login':
      return { kind: 'sign_in', asks: 'address' }
    case 'paste_key':
      return { kind: 'paste_key' }
    case 'check':
      return { kind: 'check' }
    case 'remove_profile':
      return { kind: 'remove' }
    default:
      return null
  }
}

/** « Paste a key » as a quiet second action: on every row whose fix is a sign-in (Amendment 1). */
export const offersPastedKey = (fix: SlidelessProfileFix | null): boolean =>
  !!fix && SIGN_IN_KINDS.includes(fix.kind)

/** The address a sign-in form starts with: the profile's own, else the one of the login at its hub. */
export function prefilledAddress(
  profile: SlidelessProfile,
  logins: readonly SlidelessLogin[]
): string {
  if (profile.signIn.email) return profile.signIn.email
  const hub = profile.site.hub
  return (hub && logins.find((login) => sameOrigin(login.hub, hub))?.email) || ''
}

/** The hub a `pick_hub` form starts with: the site's own when the machine holds a login there, else the first login's. */
export function prefilledHub(profile: SlidelessProfile, logins: readonly SlidelessLogin[]): string {
  const hub = profile.site.hub
  const own = hub ? logins.find((login) => sameOrigin(login.hub, hub)) : undefined
  return (own ?? logins[0])?.hub ?? ''
}

/** The site « Create link » offers first: « New links go to » when it is a site of the listing, else the first. */
export function defaultSite(accounts: SlidelessAccounts | null): string {
  if (!accounts) return ''
  const chosen = profileAt(accounts, accounts.newLinksSite)
  return normalOrigin((chosen ?? accounts.profiles[0])?.site.origin ?? '')
}

export const PASSWORD_MIN = 4
export const PASSWORD_TOO_SHORT = 'A password is at least 4 characters long.'

/** What the dialog's fields say: the switches as they are, the rest as typed. */
export interface LinkFields {
  name: string
  /** A day (`yyyy-mm-dd`) the link stops working at its end, or null: never. */
  expires: string | null
  password: string
  annotator: boolean
  forms: boolean
  download: boolean
  bar: boolean
  pdf: boolean
  pinVersion: boolean
}

export const DEFAULT_LINK_FIELDS: LinkFields = {
  name: '',
  expires: null,
  password: '',
  annotator: false,
  forms: true,
  download: true,
  bar: true,
  pdf: true,
  pinVersion: false
}

/** The end of a day, this machine's time, as an ISO time; null for no day. */
export function endOfDay(day: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!match) return null
  const at = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 59, 999)
  return Number.isNaN(at.getTime()) ? null : at.toISOString()
}

/** A day `days` after `now`, as a date input writes it (`yyyy-mm-dd`). */
export function dayAfter(now: Date, days: number): string {
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

/** Why the fields cannot make a link, or null. */
export function linkFieldsProblem(fields: LinkFields): string | null {
  if (fields.password !== '' && fields.password.length < PASSWORD_MIN) return PASSWORD_TOO_SHORT
  return null
}

/** The link's settings as the server takes them: an empty name, day or
 *  password is left out (a password's key is absent, never undefined: the
 *  contract refuses an undefined one). */
export function linkSettings(fields: LinkFields): ArtefactShareSettings {
  const name = fields.name.trim()
  const expiresAt = fields.expires ? endOfDay(fields.expires) : null
  return {
    ...(name !== '' && { name }),
    ...(expiresAt !== null && { expiresAt }),
    ...(fields.password !== '' && { password: fields.password }),
    annotator: fields.annotator,
    forms: fields.forms,
    download: fields.download,
    bar: fields.bar,
    pdf: fields.pdf,
    pinVersion: fields.pinVersion
  }
}

/**
 * The sentence of a call the server refused, in its own words. It reaches the
 * window as the contract's error (its `message`), as a plain tagged object,
 * or as main's IPC error, whose message Electron prefixes with the channel
 * and the error's name.
 */
export function refusalText(error: unknown, fallback = 'Slideless did not answer.'): string {
  const message =
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { message?: unknown }).message === 'string'
      ? (error as { message: string }).message
      : typeof error === 'string'
        ? error
        : ''
  return (
    message
      .replace(/^Error invoking remote method '[^']+': /, '')
      .replace(/^(?:\w*Error|\w+Refused|\w+Unavailable): /, '')
      .trim() || fallback
  )
}

/** A day as a link's row says it (`26 Nov 2026`), this machine's way. */
export function shortDate(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  return at.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}
