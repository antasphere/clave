/**
 * A routine's deck on Slideless (PRDCT-4149): the server that runs a routine
 * whose report says `publish: true` pushes every run's deck folder as a new
 * version of ONE deck per routine, through the server's OWN copy of Slideless
 * (one run of it each, `runSlideless`: never a `slideless` found on a path,
 * PRDCT-4266), signed in as the server's own user. Every call names its site
 * first (`--api-url <site> --json …`): the site the routine's record names; for
 * a deck kept before records named a site, the one site of the machine that
 * knows the deck by its id, written into the record before the push; for a new
 * deck, the machine's « New links go to ». A deck stays on its site: one the
 * site no longer has is replaced on the same site. The first push creates the
 * deck and the service keeps its id and its site; the first push also mints ONE
 * named share link for the routine (follow-latest, forms, downloads and
 * uploads off), whose URL is a bearer: it lives in the server's own
 * `routines.json` and is shown to the person in the panel, never written on a
 * record. A push that fails never fails the run: the reason lands on the run
 * as `publishError`.
 *
 * Pure over an injected `run`, `newLinksSite` and `sites`, so the arguments,
 * the site, the parsing and every failure have tests of their own without a
 * command line on the machine.
 */
import { firstLine, isGone, parsePush, parseShare } from '../artefacts/slideless-json'
import { runFailure, type SlidelessRun } from '../artefacts/slideless-run'
import { normalOrigin } from '../artefacts/slideless-settings'
import type { RoutinePublishState } from './store'

// The readers of the command's answers live beside an artefact's links,
// which read them too (PRDCT-4266); exported here as they always were.
export { isGone, parseJsonOutput, parsePush, parseShare } from '../artefacts/slideless-json'

export const PUSH_TIMEOUT_MS = 120_000
/** Each look for a kept deck on one site, by its id. */
export const VERSIONS_TIMEOUT_MS = 30_000
/** The share link's owner-facing label: the person sees it in Slideless, never the recipient. */
export const SHARE_NAME_PREFIX = 'Clave routine'

/** One finished run of the copy: its code (null when a signal ended it), what it
 *  printed, and whether it was killed at its time. */
export type ExecResult = SlidelessRun

export interface PublisherOptions {
  /** One run of the server's own copy (`runSlideless` over the server's data
   *  folder, its Node and its environment); rejects when the copy is not ready. */
  run: (args: string[], options: { cwd: string; timeoutMs: number }) => Promise<ExecResult>
  /** The machine's « New links go to » (`slideless-settings.ts`): where a new deck goes; null when none is chosen. */
  newLinksSite: () => Promise<string | null>
  /** The origins of the machine's saved profiles (the plain listing): where a deck kept with no site is looked for. */
  sites: () => Promise<string[]>
  timeoutMs?: number
  log?: (level: 'info' | 'warn', message: string) => void
}

export interface PublishInput {
  /** The run's deck folder on disk, as `writeDeck` left it. */
  folder: string
  /** The deck's title on Slideless: the routine's name. */
  title: string
  /** What the routine already has on Slideless, null before its first push. */
  state: RoutinePublishState | null
  /** The share link's owner-facing label. */
  shareName: string
  /** Writes what the routine has on Slideless, before the push: the site a
   *  look by id found for a deck kept with none. */
  save: (state: RoutinePublishState) => void
}

export interface PublishOutcome {
  deckId: string
  version: number
  /** The routine's share link, null when none could be minted (the reason in `shareError`). */
  url: string | null
  /** What the service keeps for the next push, the deck's site with it. */
  state: RoutinePublishState
  shareError: string | null
}

/** The CLI did not publish; the message is what the run carries as `publishError`. */
export class PublishFailure extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PublishFailure'
  }
}

export interface RoutinePublisher {
  publish(input: PublishInput): Promise<PublishOutcome>
}

/** The sentence of a copy that is not ready. */
export const notInstalled = (what: 'pushed' | 'shared'): string =>
  `Clave's Slideless is not installed on this server, so the deck was not ${what}`
/** The sentence of a new deck with no site to go to. */
export const NO_SITE_CHOSEN =
  'no site is chosen for new links on this server (Settings › Slideless), so the deck was not pushed'
/** The sentence of a kept deck more than one site knows. */
export const onSeveralSites = (deckId: string, origins: readonly string[]): string =>
  `the routine's deck ${deckId} is on several sites of this server (${origins.join(', ')}); its site was not guessed`

/** The push arguments, the site first: a new version of the routine's deck, or a new deck the first time. */
export function pushArgs(
  site: string,
  folder: string,
  title: string,
  deckId: string | null
): string[] {
  return [
    '--api-url',
    site,
    '--json',
    'push',
    folder,
    '--title',
    title,
    '--no-open',
    ...(deckId ? ['--id', deckId] : ['--new'])
  ]
}

/** The share arguments, the site first: one named link that follows the latest
 *  version and lets the recipient submit nothing, download nothing and upload nothing. */
export function shareArgs(site: string, deckId: string, name: string): string[] {
  return [
    '--api-url',
    site,
    '--json',
    'share',
    deckId,
    '--name',
    name,
    '--no-forms',
    '--no-download',
    '--no-uploads'
  ]
}

/** The look for a deck on one site, by its id. */
export function versionsArgs(site: string, deckId: string): string[] {
  return ['--api-url', site, '--json', 'versions', deckId]
}

export class SlidelessPublisher implements RoutinePublisher {
  private readonly timeoutMs: number
  private readonly log: (level: 'info' | 'warn', message: string) => void
  constructor(private readonly options: PublisherOptions) {
    this.timeoutMs = options.timeoutMs ?? PUSH_TIMEOUT_MS
    this.log = options.log ?? ((): void => {})
  }

  /** One run of the copy; a copy not ready is the failure that says so. */
  private async run(
    args: string[],
    cwd: string,
    timeoutMs: number,
    what: 'pushed' | 'shared'
  ): Promise<ExecResult> {
    try {
      return await this.options.run(args, { cwd, timeoutMs })
    } catch {
      throw new PublishFailure(notInstalled(what))
    }
  }

  /** Why a run failed, in the words the run carries: the command's `Error:` line. */
  private failure(what: string, result: ExecResult): PublishFailure {
    return new PublishFailure(`the deck was not ${what}: ${runFailure(result)}`)
  }

  /** Where a new deck goes: the machine's « New links go to », or the failure that none is chosen. */
  private async newDeckSite(): Promise<string> {
    const site = await this.options.newLinksSite()
    if (site === null || site.trim() === '') throw new PublishFailure(NO_SITE_CHOSEN)
    return normalOrigin(site)
  }

  /** The sites of the machine that know a deck by its id: every saved site
   *  asked, in order, each once. */
  private async sitesOf(deckId: string, folder: string): Promise<string[]> {
    const origins = [...new Set((await this.options.sites()).map(normalOrigin))]
    const found: string[] = []
    for (const origin of origins) {
      const looked = await this.run(
        versionsArgs(origin, deckId),
        folder,
        VERSIONS_TIMEOUT_MS,
        'pushed'
      )
      if (looked.code === 0) found.push(origin)
    }
    return found
  }

  async publish(input: PublishInput): Promise<PublishOutcome> {
    const kept = input.state?.deckId ? input.state : null
    // Which site, and which deck on it.
    let site: string
    let deckId: string | null = kept?.deckId ?? null
    if (kept && typeof kept.site === 'string' && kept.site.trim() !== '') {
      site = normalOrigin(kept.site)
    } else if (kept) {
      // A deck kept before records named their site: the one site that knows it.
      const found = await this.sitesOf(kept.deckId, input.folder)
      if (found.length > 1) throw new PublishFailure(onSeveralSites(kept.deckId, found))
      if (found.length === 1) {
        site = found[0]!
        input.save({ ...kept, site })
      } else {
        // On none of them: gone, as a push refused under its id would say.
        site = await this.newDeckSite()
        this.log(
          'warn',
          `publish: the routine's deck ${kept.deckId} is on none of this server's sites; making a new deck on ${site}`
        )
        deckId = null
      }
    } else {
      site = await this.newDeckSite()
    }

    let pushed = await this.run(
      pushArgs(site, input.folder, input.title, deckId),
      input.folder,
      this.timeoutMs,
      'pushed'
    )
    // A kept deck the site no longer has (deleted on Slideless): the push
    // under its id is refused, and the routine would fail on every run after
    // (round 1, Note 2). One new deck is made instead, on the SAME site, and
    // the state follows it; a copy missing or silent is not that case and
    // stays a failure.
    if (pushed.code !== 0 && deckId !== null && isGone(pushed)) {
      this.log(
        'warn',
        `publish: the push to the kept deck ${deckId} was refused (${runFailure(pushed)}); making a new deck on ${site}`
      )
      pushed = await this.run(
        pushArgs(site, input.folder, input.title, null),
        input.folder,
        this.timeoutMs,
        'pushed'
      )
    }
    if (pushed.code !== 0) throw this.failure('pushed', pushed)
    const parsed = parsePush(pushed.stdout)
    if (!parsed)
      throw new PublishFailure(
        `the deck was pushed but the CLI's answer named no deck (${firstLine(pushed.stdout) || 'empty'})`
      )
    // A deck pushed under another id than kept (a new one) is the deck from
    // now on: the share link, if any, belonged to the old one.
    const sameDeck = input.state?.deckId === parsed.deckId
    let share = sameDeck ? (input.state?.share ?? null) : null
    let shareError: string | null = null
    if (!share) {
      try {
        const shared = await this.run(
          shareArgs(site, parsed.deckId, input.shareName),
          input.folder,
          this.timeoutMs,
          'shared'
        )
        if (shared.code !== 0) shareError = this.failure('shared', shared).message
        else {
          share = parseShare(shared.stdout)
          if (!share)
            shareError = `the link was minted but the CLI's answer named no URL (${firstLine(shared.stdout) || 'empty'})`
        }
      } catch (error) {
        if (!(error instanceof PublishFailure)) throw error
        shareError = error.message
      }
      if (shareError) this.log('warn', `publish: ${shareError}`)
    }
    return {
      deckId: parsed.deckId,
      version: parsed.version,
      url: share?.url ?? null,
      state: { deckId: parsed.deckId, share, site },
      shareError
    }
  }
}
