/**
 * An artefact's deck and its links (PRDCT-4266): « Create link » pushes the
 * session's artefact to its deck on a Slideless site with Clave's own copy
 * of the command line, then makes a link to it with the settings the person
 * chose; the server records the deck and the links it made
 * (`artefact-decks.ts`), so a later push goes to the same deck and a link
 * can be revoked.
 *
 * A FOLDER is pushed in place (its link file `.slideless.json` is the
 * folder's own, as `slideless push` writes it). A single `.html` FILE is
 * pushed from a copy the server stages in its data folder, one folder per
 * file (`slideless/staged/<first 16 hex of sha256(target)>/<file name>`),
 * copied afresh before every push: two files of one folder never share a
 * link file, and nothing is ever written in the folder they share.
 *
 * Which deck a share goes to: a new one when the person asks (`newDeck`, on
 * the site named); else the deck recorded, on its own site (a deck stays on
 * its site); else the deck a folder's link file names, made outside Clave,
 * when its site is one of the machine's (Clave never signs in at a site only
 * a link file names: that share is refused before anything reaches a site);
 * else a new deck on the site named. A push to a deck the site no longer has
 * answers `deck_gone` and records nothing: a new deck is the person's call.
 *
 * `--api-url` names the site first on every call that reaches it; `open`,
 * which reads the folder's link file with no network, has none. A password
 * goes to the command on its input, never on its command line. A link's URL
 * is a bearer: never logged, it travels only in the answer to the call that
 * asked, and `unshare` always names the one link it revokes (with no
 * `--token`, the command revokes every link of the deck).
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type {
  Artefact,
  ArtefactDeck,
  ArtefactShareLink,
  ArtefactShareRequest,
  ArtefactShareResult,
  SlidelessAccounts
} from '@clave/contract/artefacts'
import type { ArtefactDecks, DeckRecord } from './artefact-decks'
import { ArtefactRefusal } from './refusal'
import { supportsAccounts, tooOldFor, type ResolvedCli } from './slideless-cli'
import { firstLine, isGone, parseJsonOutput, parsePush, parseSharedLink } from './slideless-json'
import {
  runFailure,
  withoutSecret,
  type SlidelessRun,
  type SlidelessRunOptions
} from './slideless-run'
import { normalOrigin } from './slideless-settings'

export const OPEN_TIMEOUT_MS = 10_000
export const PUSH_TIMEOUT_MS = 120_000
export const SHARE_TIMEOUT_MS = 60_000
export const UNSHARE_TIMEOUT_MS = 30_000
/** A link's owner-facing label when the person gives none. */
export const DEFAULT_LINK_NAME = 'Clave'

export const FOREIGN_LINK = 'This link is not one Clave made for this artefact.'
export const CHOOSE_SITE = "Choose the site for this artefact's first link."
export const CHOOSE_SITE_FOR_NEW_DECK = "Choose the site for this artefact's new deck."
export const deckStays = (site: string): string =>
  `This artefact's deck is on ${site}; a deck stays on its own site.`
/** A folder whose link file names a site the machine does not list: Clave never signs in there. */
export const linkedElsewhere = (site: string): string =>
  `This folder is linked to a deck on ${site}, which is not one of this machine's Slideless sites: add it with « Add a site » in Settings › Slideless first.`

export interface ShareDeps {
  readonly dataDir: string
  readonly decks: ArtefactDecks
  /** One of the session's artefacts; throws the refusal when the session has none at `target`. */
  readonly artefact: (sessionId: string, target: string) => Artefact
  /** Clave's own copy when it is ready; throws the refusal that says why not. */
  readonly cli: () => ResolvedCli
  /** One run of it (`runSlideless` over the service's own dependencies). */
  readonly run: (args: readonly string[], options: SlidelessRunOptions) => Promise<SlidelessRun>
  /** A fresh plain listing, or the refusal with the sentence why it cannot be made. */
  readonly listed: () => Promise<SlidelessAccounts>
  readonly now: () => number
}

/** A share, with the artefact it names. */
export type ShareRequest = ArtefactShareRequest & {
  readonly sessionId: string
  readonly target: string
}

export interface ArtefactShare {
  deck(sessionId: string, target: string): Promise<ArtefactDeck>
  share(request: ShareRequest): Promise<ArtefactShareResult>
  revoke(sessionId: string, target: string, tokenId: string): Promise<ArtefactDeck>
}

/** Where a single-file artefact is staged for its pushes: a folder of its own. */
export function stagedPath(dataDir: string, target: string): string {
  const key = createHash('sha256').update(target).digest('hex').slice(0, 16)
  return join(dataDir, 'slideless', 'staged', key, basename(target))
}

/** A single `.html` file, not a folder: its page is the target itself. */
const isFile = (artefact: Artefact): boolean => artefact.page === artefact.target

/** The deck a folder's link file names, made outside Clave. */
type LinkedFolder = { readonly deckId: string; readonly site: string }

const view = (
  artefact: Artefact,
  record: DeckRecord | undefined,
  linkedFolder: LinkedFolder | null
): ArtefactDeck => ({
  target: artefact.target,
  site: record?.site ?? null,
  deckId: record?.deckId ?? null,
  title: record?.title ?? null,
  version: record?.version ?? null,
  pushedAt: record?.pushedAt ?? null,
  links: record ? [...record.links] : [],
  linkedFolder: record ? null : linkedFolder,
  staged: isFile(artefact)
})

export function createArtefactShare(deps: ShareDeps): ArtefactShare {
  /** Clave's copy makes links, or the call is refused with the sentence why not. */
  const linksReady = (): void => {
    const cli = deps.cli()
    if (!supportsAccounts(cli.version)) throw new ArtefactRefusal(tooOldFor('links', cli.version))
  }

  // One share or revocation of an artefact at a time: two pushes never race
  // for its deck, nor two writes for its record.
  const chains = new Map<string, Promise<unknown>>()
  const serially = <A>(target: string, run: () => Promise<A>): Promise<A> => {
    const previous = chains.get(target) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(run)
    const settled = next.catch(() => undefined)
    chains.set(target, settled)
    void settled.then(() => {
      if (chains.get(target) === settled) chains.delete(target)
    })
    return next
  }

  /** `open <folder> --json`: the deck its link file names, read with no network; null on any failure. */
  const linkedFolderOf = async (folder: string): Promise<LinkedFolder | null> => {
    try {
      const run = await deps.run(['--json', 'open', folder], { timeoutMs: OPEN_TIMEOUT_MS })
      if (run.code !== 0) return null
      const answer = parseJsonOutput(run.stdout)
      const deckId = answer?.presentationId
      const site = answer?.baseUrl
      if (typeof deckId !== 'string' || !deckId || typeof site !== 'string' || !site) return null
      return { deckId, site: normalOrigin(site) }
    } catch {
      return null
    }
  }

  const deck = async (sessionId: string, target: string): Promise<ArtefactDeck> => {
    const artefact = deps.artefact(sessionId, target)
    linksReady()
    const record = deps.decks.get(artefact.target)
    const linked = record || isFile(artefact) ? null : await linkedFolderOf(artefact.target)
    return view(artefact, record, linked)
  }

  /** The path pushed and where the command runs: the folder itself, or a file's fresh staged copy. */
  const pushedFrom = (artefact: Artefact): { path: string; cwd: string } => {
    if (!existsSync(artefact.target))
      throw new ArtefactRefusal(`No such file or folder: ${artefact.target}`)
    if (!isFile(artefact)) return { path: artefact.target, cwd: artefact.target }
    const path = stagedPath(deps.dataDir, artefact.target)
    mkdirSync(dirname(path), { recursive: true })
    copyFileSync(artefact.target, path)
    return { path, cwd: dirname(path) }
  }

  const shareNow = async (
    artefact: Artefact,
    request: ShareRequest
  ): Promise<ArtefactShareResult> => {
    // The record first, before anything runs: a record that cannot be read
    // refuses the share, so no page is pushed whose deck could not be recorded.
    const record = deps.decks.get(artefact.target)
    // The machine's sites, listed once: a site named, and the site a folder's
    // link file names, must be one of them before anything reaches a site.
    let listing: SlidelessAccounts | null = null
    const machineSite = async (origin: string): Promise<boolean> => {
      listing ??= await deps.listed()
      return listing.profiles.some((profile) => normalOrigin(profile.site.origin) === origin)
    }
    const named = request.site?.trim() ? normalOrigin(request.site) : null
    if (named !== null && !(await machineSite(named)))
      throw new ArtefactRefusal(`${named} is not one of this machine's Slideless sites.`)
    // Which deck, and on which site.
    let site: string
    let deckId: string | null
    let linked: LinkedFolder | null = null
    if (request.newDeck === true) {
      if (named === null) throw new ArtefactRefusal(CHOOSE_SITE_FOR_NEW_DECK)
      site = named
      deckId = null
    } else if (record) {
      if (named !== null && named !== record.site) throw new ArtefactRefusal(deckStays(record.site))
      site = record.site
      deckId = record.deckId
    } else {
      linked = isFile(artefact) ? null : await linkedFolderOf(artefact.target)
      if (linked) {
        // A site only a link file names is never reached: with its own
        // `--api-url` the command would sign in at whatever hub it names.
        if (!(await machineSite(linked.site)))
          throw new ArtefactRefusal(linkedElsewhere(linked.site))
        if (named !== null && named !== linked.site)
          throw new ArtefactRefusal(deckStays(linked.site))
        site = linked.site
        deckId = linked.deckId
      } else {
        if (named === null) throw new ArtefactRefusal(CHOOSE_SITE)
        site = named
        deckId = null
      }
    }

    // The push: a new version of the deck, or a new deck.
    const title = request.title?.trim() || record?.title || artefact.title
    const { path, cwd } = pushedFrom(artefact)
    const pushed = await deps.run(
      [
        '--api-url',
        site,
        '--json',
        'push',
        path,
        '--title',
        title,
        '--no-open',
        ...(deckId !== null ? ['--id', deckId] : ['--new'])
      ],
      { cwd, timeoutMs: PUSH_TIMEOUT_MS }
    )
    if (pushed.code !== 0) {
      if (deckId !== null && isGone(pushed))
        return { _tag: 'deck_gone', deck: view(artefact, record, linked) }
      throw new ArtefactRefusal(`Slideless did not push the page: ${runFailure(pushed)}`)
    }
    const version = parsePush(pushed.stdout)
    if (!version)
      throw new ArtefactRefusal(
        `Slideless did not push the page: ${firstLine(pushed.stdout) || 'its answer named no deck.'}`
      )
    const recorded = deps.decks.pushed(artefact.target, {
      site,
      deckId: version.deckId,
      title,
      version: version.version,
      pushedAt: new Date(deps.now()).toISOString()
    })

    // The link, with the person's settings; the switches off are the command's `--no-…`.
    const settings = request.link
    const name = settings.name?.trim() || DEFAULT_LINK_NAME
    const password = settings.password || undefined
    const shared = await deps.run(
      [
        '--api-url',
        site,
        '--json',
        'share',
        version.deckId,
        '--name',
        name,
        ...(settings.annotator ? ['--annotator'] : []),
        ...(settings.forms ? [] : ['--no-forms']),
        ...(settings.download ? [] : ['--no-download']),
        ...(settings.bar ? [] : ['--no-bar']),
        ...(settings.pdf ? [] : ['--no-pdf']),
        ...(settings.expiresAt ? ['--expires', settings.expiresAt] : []),
        ...(settings.pinVersion ? ['--to-version', String(version.version)] : []),
        ...(password !== undefined ? ['--password-stdin'] : [])
      ],
      { timeoutMs: SHARE_TIMEOUT_MS, ...(password !== undefined && { input: `${password}\n` }) }
    )
    const notMade = `The page is on the site as version ${version.version}, but the link was not made`
    if (shared.code !== 0)
      throw new ArtefactRefusal(`${notMade}: ${withoutSecret(runFailure(shared), password)}`)
    const answer = parseSharedLink(shared.stdout)
    if (!answer) throw new ArtefactRefusal(`${notMade}: Slideless answered no link.`)
    // What the command says of the link; what was asked where it says nothing.
    const link: ArtefactShareLink = {
      tokenId: answer.tokenId,
      name: answer.name ?? name,
      url: answer.url,
      createdAt: answer.createdAt ?? new Date(deps.now()).toISOString(),
      expiresAt: answer.expiresAt === undefined ? (settings.expiresAt ?? null) : answer.expiresAt,
      pinnedVersion:
        answer.pinnedVersion === undefined
          ? settings.pinVersion
            ? version.version
            : null
          : answer.pinnedVersion,
      hasPassword: answer.hasPassword ?? password !== undefined
    }
    const withLink = deps.decks.addLink(artefact.target, link) ?? recorded
    return { _tag: 'shared', deck: view(artefact, withLink, null), link }
  }

  return {
    deck,
    share: async (request) => {
      const artefact = deps.artefact(request.sessionId, request.target)
      linksReady()
      return serially(artefact.target, () => shareNow(artefact, request))
    },
    revoke: async (sessionId, target, tokenId) => {
      const artefact = deps.artefact(sessionId, target)
      return serially(artefact.target, async () => {
        // Only a link Clave made, and always that one: refused before anything runs.
        const record = deps.decks.get(artefact.target)
        if (!tokenId || !record?.links.some((link) => link.tokenId === tokenId))
          throw new ArtefactRefusal(FOREIGN_LINK)
        linksReady()
        const run = await deps.run(
          ['--api-url', record.site, '--json', 'unshare', record.deckId, '--token', tokenId],
          { timeoutMs: UNSHARE_TIMEOUT_MS }
        )
        // A link the site no longer has (revoked on Slideless, or its deck deleted)
        // is gone either way: it leaves the record rather than stay as a dead row.
        if (run.code !== 0 && !isGone(run))
          throw new ArtefactRefusal(`Slideless did not revoke the link: ${runFailure(run)}`)
        return view(artefact, deps.decks.removeLink(artefact.target, tokenId) ?? record, null)
      })
    }
  }
}
