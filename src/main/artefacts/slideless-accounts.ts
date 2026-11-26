/**
 * The Slideless accounts of a server's machine (PRDCT-4266), as Clave's own
 * copy of the command line lists them (`profiles --json`, Slideless 0.15.0):
 * the sites, how each signs in, and the fix the command offers when one does
 * not. The listing is read tolerantly: a value the command chooses from a
 * set of its own is kept as it came, a field missing is empty, and only a
 * profile with no site origin is dropped, so a newer command's listing still
 * reads. The machine's own « New links go to » (`slidelessSettings`) rides
 * on every listing.
 *
 * A listing never throws: when it cannot be made (no copy installed, a copy
 * older than `MIN_ACCOUNTS_VERSION`, the command failed) its `error` says
 * why. A call that changes something refuses instead, before it spawns
 * anything when it cannot be made. Global options always come first, before
 * the subcommand, and `--api-url` names the site on every call that reaches
 * one, never on the listing nor on `profiles add` (its site is its
 * argument). A key goes to the command on its input, never on its command
 * line, in a log line or in a sentence.
 */
import type {
  SlidelessAccounts,
  SlidelessPerson,
  SlidelessProfile,
  SlidelessProfileFix
} from '@clave/contract/artefacts'
import { ArtefactRefusal } from './refusal'
import { supportsAccounts, tooOldFor, type ResolvedCli } from './slideless-cli'
import { parseJsonOutput } from './slideless-json'
import {
  runFailure,
  withoutSecret,
  type SlidelessRun,
  type SlidelessRunOptions
} from './slideless-run'
import { normalOrigin, type SlidelessSettings } from './slideless-settings'

export const LIST_TIMEOUT_MS = 15_000
export const CHECK_TIMEOUT_MS = 60_000
export const ADD_SITE_TIMEOUT_MS = 20_000
export const FIX_TIMEOUT_MS = 30_000
export const KEY_TIMEOUT_MS = 30_000

/** The fixes that sign in with an e-mail code: they run through the sign-in (`slideless-sign-in.ts`). */
export const SIGN_IN_KINDS: readonly string[] = [
  'hub_login',
  'email_code',
  'pick_hub',
  'pick_login'
]

export const NO_LISTING = 'Slideless answered with no listing Clave can read.'
export const SITE_ADDRESS = "A site's address starts with https://."

/** An http(s) address: what a site is, and never a command line option. */
const isSiteAddress = (value: string): boolean => {
  try {
    const url = new URL(value.trim())
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}
export const notASite = (origin: string): string =>
  `${normalOrigin(origin)} is not one of this machine's Slideless sites.`

export interface AccountsDeps {
  /** Clave's own copy when it is ready; throws the refusal that says why not. */
  readonly cli: () => ResolvedCli
  /** One run of it (`runSlideless` over the service's own dependencies). */
  readonly run: (args: readonly string[], options: SlidelessRunOptions) => Promise<SlidelessRun>
  readonly settings: SlidelessSettings
}

export interface SlidelessAccountsService {
  /** The accounts; `check` tries each sign-in on its site. Never throws a refusal. */
  list(options: { readonly check: boolean }): Promise<SlidelessAccounts>
  /** A fresh plain listing, or the refusal with its `error` when it cannot be made. */
  listed(): Promise<SlidelessAccounts>
  addSite(url: string): Promise<SlidelessAccounts>
  setNewLinksSite(origin: string | null): Promise<SlidelessAccounts>
  runFix(origin: string, kind: string): Promise<SlidelessAccounts>
  pasteKey(origin: string, key: string): Promise<SlidelessAccounts>
}

/** The accounts when they cannot be listed: the sentence why, every other field empty. */
export const unlisted = (error: string, needsUpdate = false): SlidelessAccounts => ({
  machine: null,
  cliVersion: null,
  defaultSite: null,
  environment: { url: null, key: false, hubUrl: null },
  logins: [],
  profiles: [],
  newLinksSite: null,
  checked: false,
  error,
  needsUpdate
})

/**
 * A fix's command line as the listing wrote it, after Clave's global options
 * (`--api-url <site>`, `--json`), its binary dropped. Null when the fix names
 * another site than its own row's: the command takes the last `--api-url`,
 * so a fix naming another one would run there.
 */
export function fixArgs(fix: SlidelessProfileFix, site: string): string[] | null {
  const rest = fix.argv.slice(1)
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!
    const named =
      arg === '--api-url'
        ? (rest[i + 1] ?? '')
        : arg.startsWith('--api-url=')
          ? arg.slice('--api-url='.length)
          : undefined
    if (named !== undefined && normalOrigin(named) !== normalOrigin(site)) return null
  }
  return ['--api-url', normalOrigin(site), '--json', ...rest]
}

/** The profile of a site, its origins compared in normal form. */
export const profileAt = (
  accounts: SlidelessAccounts,
  origin: string
): SlidelessProfile | undefined => {
  const wanted = normalOrigin(origin)
  return accounts.profiles.find((profile) => normalOrigin(profile.site.origin) === wanted)
}

// ── The listing, read tolerantly ──

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const flag = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null)
const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null
const fields = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const items = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

const fixOf = (value: unknown): SlidelessProfileFix | null => {
  const fix = fields(value)
  if (typeof fix.kind !== 'string' || !Array.isArray(fix.argv)) return null
  if (!fix.argv.every((arg) => typeof arg === 'string')) return null
  return { kind: fix.kind, argv: [...(fix.argv as string[])] }
}

const personOf = (value: unknown): SlidelessPerson | null => {
  const person = fields(value)
  if (typeof person.email !== 'string') return null
  return { name: text(person.name), email: person.email, workspace: text(person.workspace) }
}

/** A profile of the listing, or none when it names no site. */
const profileOf = (value: unknown): SlidelessProfile[] => {
  const profile = fields(value)
  const site = fields(profile.site)
  if (typeof site.origin !== 'string' || site.origin.trim() === '') return []
  const signIn = fields(profile.signIn)
  return [
    {
      name: text(profile.name) ?? '',
      default: profile.default === true,
      saved: profile.saved === true,
      site: {
        origin: site.origin,
        name: text(site.name),
        hub: text(site.hub),
        federated: flag(site.federated),
        cliVersion: text(site.cliVersion),
        seenAt: text(site.seenAt)
      },
      cliBehind: flag(profile.cliBehind),
      signIn: {
        state: text(signIn.state) ?? 'unknown',
        via: text(signIn.via),
        hub: text(signIn.hub),
        email: text(signIn.email),
        staleKeys: count(signIn.staleKeys),
        fix: fixOf(signIn.fix),
        ...(typeof signIn.checked === 'string' && { checked: signIn.checked }),
        ...('person' in signIn && { person: personOf(signIn.person) })
      },
      environment: items(profile.environment).flatMap((entry) => {
        const effect = fields(entry)
        return typeof effect.variable === 'string' && typeof effect.effect === 'string'
          ? [{ variable: effect.variable, effect: effect.effect }]
          : []
      })
    }
  ]
}

/** What `profiles --json` printed, or null when it printed no listing. */
export function parseListing(
  stdout: string
): Omit<SlidelessAccounts, 'newLinksSite' | 'checked' | 'error' | 'needsUpdate'> | null {
  const raw = parseJsonOutput(stdout)
  if (!raw) return null
  const environment = fields(raw.environment)
  return {
    machine: text(raw.machine),
    cliVersion: text(raw.cliVersion),
    defaultSite: text(raw.defaultSite),
    environment: {
      url: text(environment.url),
      key: environment.key === true,
      hubUrl: text(environment.hubUrl)
    },
    logins: items(raw.logins).flatMap((entry) => {
      const login = fields(entry)
      return typeof login.hub === 'string'
        ? [{ hub: login.hub, email: text(login.email), name: text(login.name) ?? '' }]
        : []
    }),
    profiles: items(raw.profiles).flatMap(profileOf)
  }
}

export function createSlidelessAccounts(deps: AccountsDeps): SlidelessAccountsService {
  /** Why Clave's copy cannot run the accounts, and whether an update is the cure; null when it can. */
  const unable = (): { error: string; needsUpdate: boolean } | null => {
    let cli: ResolvedCli
    try {
      cli = deps.cli()
    } catch (error) {
      if (error instanceof ArtefactRefusal) return { error: error.message, needsUpdate: false }
      throw error
    }
    return supportsAccounts(cli.version)
      ? null
      : { error: tooOldFor('accounts', cli.version), needsUpdate: true }
  }
  /** A call that changes something is refused, before anything runs, by a copy that cannot. */
  const gate = (): void => {
    const why = unable()
    if (why) throw new ArtefactRefusal(why.error)
  }

  const list = async ({ check }: { readonly check: boolean }): Promise<SlidelessAccounts> => {
    const why = unable()
    if (why) return unlisted(why.error, why.needsUpdate)
    let run: SlidelessRun
    try {
      run = await deps.run(check ? ['--json', 'profiles', '--check'] : ['--json', 'profiles'], {
        timeoutMs: check ? CHECK_TIMEOUT_MS : LIST_TIMEOUT_MS
      })
    } catch (error) {
      // The copy went away between the two looks (an install started).
      if (error instanceof ArtefactRefusal) return unlisted(error.message)
      throw error
    }
    if (run.code !== 0) return unlisted(runFailure(run))
    const listing = parseListing(run.stdout)
    if (!listing) return unlisted(NO_LISTING)
    return {
      ...listing,
      newLinksSite: deps.settings.newLinksSite(),
      checked: check,
      error: null,
      needsUpdate: false
    }
  }

  const listed = async (): Promise<SlidelessAccounts> => {
    const accounts = await list({ check: false })
    if (accounts.error !== null) throw new ArtefactRefusal(accounts.error)
    return accounts
  }

  return {
    list,
    listed,
    addSite: async (url) => {
      // An http(s) address, never an option of the command: refused before anything runs.
      if (!isSiteAddress(url)) throw new ArtefactRefusal(SITE_ADDRESS)
      gate()
      // Its site is its argument: no --api-url.
      const run = await deps.run(['--json', 'profiles', 'add', url.trim()], {
        timeoutMs: ADD_SITE_TIMEOUT_MS
      })
      if (run.code !== 0) throw new ArtefactRefusal(runFailure(run))
      return list({ check: false })
    },
    setNewLinksSite: async (origin) => {
      if (origin === null) {
        deps.settings.setNewLinksSite(null)
        return list({ check: false })
      }
      // The listing that says it is a site of the machine is the answer once it is written.
      const accounts = await listed()
      const profile = profileAt(accounts, origin)
      if (!profile) throw new ArtefactRefusal(notASite(origin))
      const site = normalOrigin(profile.site.origin)
      deps.settings.setNewLinksSite(site)
      return { ...accounts, newLinksSite: site }
    },
    runFix: async (origin, kind) => {
      // What the command offers NOW: a fix is run only as a fresh listing gives it.
      const accounts = await listed()
      const profile = profileAt(accounts, origin)
      if (!profile) throw new ArtefactRefusal(notASite(origin))
      const site = normalOrigin(profile.site.origin)
      const fix = profile.signIn.fix
      if (!fix || fix.kind !== kind)
        throw new ArtefactRefusal(
          `Slideless does not offer this fix for ${site} now: list the accounts again.`
        )
      if (kind === 'check') return list({ check: true })
      if (SIGN_IN_KINDS.includes(kind))
        throw new ArtefactRefusal(`${site} signs in with a code: start its sign-in.`)
      if (kind === 'paste_key') throw new ArtefactRefusal(`${site} signs in with a key: paste it.`)
      if (kind !== 'remove_profile' || fix.argv.length < 2)
        throw new ArtefactRefusal(`Clave does not run this fix (${kind}).`)
      // The fix's own command line, as the listing wrote it, after the global options.
      const args = fixArgs(fix, site)
      if (args === null)
        throw new ArtefactRefusal(`Slideless offers ${site} a fix that names another site.`)
      const run = await deps.run(args, { timeoutMs: FIX_TIMEOUT_MS })
      if (run.code !== 0) throw new ArtefactRefusal(runFailure(run))
      return list({ check: false })
    },
    pasteKey: async (origin, key) => {
      gate()
      // A key goes only to a site of this machine, as a fresh listing names it.
      const profile = profileAt(await listed(), origin)
      if (!profile) throw new ArtefactRefusal(notASite(origin))
      const run = await deps.run(
        ['--api-url', normalOrigin(profile.site.origin), '--json', 'login', '--api-key-stdin'],
        { input: `${key}\n`, timeoutMs: KEY_TIMEOUT_MS }
      )
      if (run.code !== 0)
        throw new ArtefactRefusal(
          `Slideless did not take the key: ${withoutSecret(runFailure(run), key)}`
        )
      return list({ check: false })
    }
  }
}
