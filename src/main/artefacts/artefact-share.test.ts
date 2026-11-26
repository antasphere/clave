import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Artefact, ArtefactShareSettings } from '@clave/contract/artefacts'
import {
  ArtefactDecks,
  DECKS_FILE,
  fileDecksStorage,
  MAX_LINKS_PER_DECK,
  recordUnreadable
} from './artefact-decks'
import {
  CHOOSE_SITE,
  CHOOSE_SITE_FOR_NEW_DECK,
  createArtefactShare,
  deckStays,
  FOREIGN_LINK,
  linkedElsewhere,
  stagedPath,
  tooManyLinks,
  type ArtefactShare
} from './artefact-share'
import type { LinksStorage } from './links'
import { ArtefactRefusal } from './refusal'
import { createSlidelessAccounts } from './slideless-accounts'
import { SlidelessSettings } from './slideless-settings'
import {
  answer,
  CLOUD,
  DECKS,
  fakeSlideless,
  isListing,
  listedProfile,
  listingJson,
  LOCAL,
  type FakeCall,
  type FakeChild,
  type FakeSlideless
} from './slideless.test-support'

/**
 * « Create link » on the server (PRDCT-4266), over a fake copy of the
 * command line and real artefacts on disk: a folder pushed in place, a
 * single file pushed from a copy staged in the data folder (two files of one
 * folder never share a link file, and nothing is written beside them), the
 * deck a share goes to, the push to a deck that is gone, each setting's
 * flag, a password only on the input, the failure after the push, and the
 * revocation of a link Clave made, refused for any other before anything
 * runs.
 */
const NOW = Date.UTC(2026, 10, 26, 10)
const defaults: ArtefactShareSettings = {
  annotator: false,
  forms: true,
  download: true,
  bar: true,
  pdf: true,
  pinVersion: false
}

/** A « not found » the command looked for in the one workspace, or the one
 *  organization, a selection named: the deck is still there, in its own. */
const LOOKED_ELSEWHERE: Array<[string, string]> = [
  ['workspace', 'Not found (looked in the workspace "acme", selected by SLIDELESS_WORKSPACE)'],
  ['organization', 'Not found (looked in the organization "acme", selected by SLIDELESS_ORG)']
]

const memory = (): LinksStorage & { text: string | null } => {
  const store = {
    text: null as string | null,
    read: () => store.text,
    write: (text: string) => {
      store.text = text
    }
  }
  return store
}

/** The subcommand a call runs, after its global options. */
const subcommandOf = (args: string[]): string | undefined =>
  args.find((arg) => ['push', 'share', 'unshare', 'open', 'profiles'].includes(arg))
const after = (args: string[], option: string): string | undefined =>
  args.includes(option) ? args[args.indexOf(option) + 1] : undefined

interface Setup {
  share: ArtefactShare
  slideless: FakeSlideless
  decks: ArtefactDecks
  dataDir: string
  /** The record of the decks, a real file of the data folder. */
  decksFile: string
  /** A folder artefact, and two single-file artefacts of one folder. */
  folder: string
  pages: string
  fileA: string
  fileB: string
  /** What each push saw of the page it pushed. */
  pushedContent: string[]
  /** The calls that are not the listing. */
  commands: () => FakeCall[]
}

function setup(
  options: {
    version?: string
    profiles?: unknown[]
    /** Answers a call before the defaults; return true when it answered. */
    override?: (args: string[], child: FakeChild) => boolean
  } = {}
): Setup {
  const root = mkdtempSync(join(tmpdir(), 'clave-artefact-share-'))
  dirs.push(root)
  const dataDir = join(root, 'data')
  const folder = join(root, 'work', 'deck')
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'index.html'), '<h1>deck</h1>')
  const pages = join(root, 'work', 'pages')
  mkdirSync(pages)
  const fileA = join(pages, 'a.html')
  const fileB = join(pages, 'b.html')
  writeFileSync(fileA, '<p>a</p>')
  writeFileSync(fileB, '<p>b</p>')
  const linked: Record<string, Artefact> = {}
  for (const [target, page, title] of [
    [folder, join(folder, 'index.html'), 'deck'],
    [fileA, fileA, 'a.html'],
    [fileB, fileB, 'b.html']
  ] as const)
    linked[target] = { sessionId: 's1', target, page, title, openedAt: '2026-11-26T09:00:00.000Z' }
  const profiles = options.profiles ?? [listedProfile(DECKS), listedProfile(LOCAL, null, 'local')]
  const pushedContent: string[] = []
  let decksMade = 0
  let versions = 0
  let tokens = 0
  const slideless = fakeSlideless(
    (args, child) => {
      if (options.override?.(args, child)) return
      if (isListing(args)) return answer(listingJson(profiles))(child)
      switch (subcommandOf(args)) {
        case 'open':
          return answer('', 1, 'Error: this folder has no link file\n')(child)
        case 'push': {
          const path = args[args.indexOf('push') + 1]!
          pushedContent.push(
            readFileSync(path.endsWith('.html') ? path : join(path, 'index.html'), 'utf8')
          )
          const deckId = after(args, '--id') ?? `d${++decksMade}`
          return answer(
            JSON.stringify({
              presentation: { id: deckId },
              version: { version: ++versions },
              url: `${DECKS}/d/${deckId}`
            })
          )(child)
        }
        case 'share': {
          const tokenId = `t${++tokens}`
          const pinned = after(args, '--to-version')
          return answer(
            JSON.stringify({
              url: `${DECKS}/s/secret-${tokenId}`,
              shareToken: {
                id: tokenId,
                name: after(args, '--name'),
                createdAt: '2026-11-26T10:00:01.000Z',
                expiresAt: after(args, '--expires') ?? null,
                pinnedVersion: pinned === undefined ? null : Number(pinned),
                hasPassword: args.includes('--password-stdin')
              },
              embed: {}
            })
          )(child)
        }
        case 'unshare':
          return answer(JSON.stringify({ id: after(args, '--token') }))(child)
      }
      answer('', 9, 'Error: unexpected command\n')(child)
    },
    options.version === undefined ? {} : { version: options.version }
  )
  const accounts = createSlidelessAccounts({
    cli: slideless.deps.cli,
    run: slideless.run,
    settings: new SlidelessSettings(memory(), () => {})
  })
  const decksFile = join(dataDir, DECKS_FILE)
  const decks = new ArtefactDecks(fileDecksStorage(decksFile))
  const share = createArtefactShare({
    dataDir,
    decks,
    artefact: (sessionId, target) => {
      const artefact = sessionId === 's1' ? linked[target] : undefined
      if (!artefact) throw new ArtefactRefusal('This session has no artefact open.')
      return artefact
    },
    cli: slideless.deps.cli,
    run: slideless.run,
    listed: accounts.listed,
    now: () => NOW
  })
  return {
    share,
    slideless,
    decks,
    dataDir,
    decksFile,
    folder,
    pages,
    fileA,
    fileB,
    pushedContent,
    commands: () => slideless.calls.filter((call) => !isListing(call.args))
  }
}

const refusal = (run: Promise<unknown>): Promise<string> =>
  run.then(
    () => 'no refusal',
    (error: Error) => `${error.name}: ${error.message}`
  )

const dirs: string[] = []
afterEach(() => {
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
  vi.restoreAllMocks()
})

describe('making a link', () => {
  it('pushes a folder in place to a new deck on the site named, then makes the link', async () => {
    const s = setup()
    const shared = await s.share.share({
      sessionId: 's1',
      target: s.folder,
      site: `${DECKS}/`,
      link: defaults
    })
    expect(s.slideless.argv()).toEqual([
      ['--json', 'profiles'],
      ['--json', 'open', s.folder],
      ['--api-url', DECKS, '--json', 'push', s.folder, '--title', 'deck', '--no-open', '--new'],
      ['--api-url', DECKS, '--json', 'share', 'd1', '--name', 'Clave']
    ])
    expect(s.slideless.calls[2]!.options.cwd).toBe(s.folder)
    const link = {
      tokenId: 't1',
      name: 'Clave',
      url: `${DECKS}/s/secret-t1`,
      createdAt: '2026-11-26T10:00:01.000Z',
      expiresAt: null,
      pinnedVersion: null,
      hasPassword: false
    }
    const deck = {
      target: s.folder,
      site: DECKS,
      deckId: 'd1',
      title: 'deck',
      version: 1,
      pushedAt: new Date(NOW).toISOString(),
      links: [link],
      linkedFolder: null,
      staged: false
    }
    expect(shared).toEqual({ _tag: 'shared', deck, link })
    expect(await s.share.deck('s1', s.folder)).toEqual(deck)
    // A second link goes to the same deck, on its own site: no site needed.
    await s.share.share({ sessionId: 's1', target: s.folder, link: { ...defaults, name: 'Two' } })
    expect(s.slideless.argv().slice(4)).toEqual([
      [
        '--api-url',
        DECKS,
        '--json',
        'push',
        s.folder,
        '--title',
        'deck',
        '--no-open',
        '--id',
        'd1'
      ],
      ['--api-url', DECKS, '--json', 'share', 'd1', '--name', 'Two']
    ])
    expect((await s.share.deck('s1', s.folder)).links.map((l) => l.tokenId)).toEqual(['t1', 't2'])
  })

  it('pushes a single file from its own staged copy, made afresh before every push', async () => {
    const s = setup()
    await s.share.share({ sessionId: 's1', target: s.fileA, site: DECKS, link: defaults })
    const staged = stagedPath(s.dataDir, s.fileA)
    expect(staged).toMatch(/slideless\/staged\/[0-9a-f]{16}\/a\.html$/)
    const [push] = s.commands().filter((call) => call.args.includes('push'))
    expect(push!.args).toEqual([
      '--api-url',
      DECKS,
      '--json',
      'push',
      staged,
      '--title',
      'a.html',
      '--no-open',
      '--new'
    ])
    expect(push!.options.cwd).toBe(dirname(staged))
    // No open for a file: its deck is never a folder's link file.
    expect(s.commands().some((call) => call.args.includes('open'))).toBe(false)
    writeFileSync(s.fileA, '<p>a, edited</p>')
    await s.share.share({ sessionId: 's1', target: s.fileA, link: defaults })
    expect(s.pushedContent).toEqual(['<p>a</p>', '<p>a, edited</p>'])
    expect((await s.share.deck('s1', s.fileA)).staged).toBe(true)
  })

  it('gives two files of one folder two new decks from two staged folders, and writes nothing beside them', async () => {
    const s = setup()
    await s.share.share({ sessionId: 's1', target: s.fileA, site: DECKS, link: defaults })
    await s.share.share({ sessionId: 's1', target: s.fileB, site: DECKS, link: defaults })
    const pushes = s.commands().filter((call) => call.args.includes('push'))
    expect(pushes.map((call) => call.args.at(-1))).toEqual(['--new', '--new'])
    const [a, b] = pushes.map((call) => call.options.cwd as string)
    expect(a).not.toBe(b)
    expect(dirname(a!)).toBe(dirname(b!))
    expect(readdirSync(s.pages).sort()).toEqual(['a.html', 'b.html'])
    expect((await s.share.deck('s1', s.fileA)).deckId).toBe('d1')
    expect((await s.share.deck('s1', s.fileB)).deckId).toBe('d2')
  })

  it('keeps a deck on its own site: another site named is refused before anything runs', async () => {
    const s = setup()
    await s.share.share({ sessionId: 's1', target: s.folder, site: DECKS, link: defaults })
    const before = s.commands().length
    expect(
      await refusal(
        s.share.share({ sessionId: 's1', target: s.folder, site: LOCAL, link: defaults })
      )
    ).toBe(`ArtefactRefusal: ${deckStays(DECKS)}`)
    expect(s.commands()).toHaveLength(before)
  })

  it('makes a new deck when asked, on the site named, the record starting over with its link', async () => {
    const s = setup()
    await s.share.share({ sessionId: 's1', target: s.folder, site: DECKS, link: defaults })
    expect(
      await refusal(
        s.share.share({ sessionId: 's1', target: s.folder, newDeck: true, link: defaults })
      )
    ).toBe(`ArtefactRefusal: ${CHOOSE_SITE_FOR_NEW_DECK}`)
    const shared = await s.share.share({
      sessionId: 's1',
      target: s.folder,
      site: LOCAL,
      newDeck: true,
      link: defaults
    })
    expect(s.commands().at(-2)!.args).toEqual([
      '--api-url',
      LOCAL,
      '--json',
      'push',
      s.folder,
      '--title',
      'deck',
      '--no-open',
      '--new'
    ])
    expect(shared).toMatchObject({
      _tag: 'shared',
      deck: { site: LOCAL, deckId: 'd2', links: [{ tokenId: 't2' }] }
    })
  })

  it('adopts the deck a folder’s link file names, read with no network and no site', async () => {
    const s = setup({
      override: (args, child) => {
        if (!args.includes('open')) return false
        answer(
          JSON.stringify({
            presentationId: 'd9',
            baseUrl: 'HTTPS://Decks.Example.test/',
            url: `${DECKS}/d/d9`
          })
        )(child)
        return true
      }
    })
    const deck = await s.share.deck('s1', s.folder)
    expect(deck).toMatchObject({ deckId: null, linkedFolder: { deckId: 'd9', site: DECKS } })
    expect(s.slideless.argv()).toEqual([['--json', 'open', s.folder]])
    await s.share.share({ sessionId: 's1', target: s.folder, link: defaults })
    expect(s.commands().map((call) => call.args)).toContainEqual([
      '--api-url',
      DECKS,
      '--json',
      'push',
      s.folder,
      '--title',
      'deck',
      '--no-open',
      '--id',
      'd9'
    ])
    expect(await s.share.deck('s1', s.folder)).toMatchObject({ deckId: 'd9', linkedFolder: null })
  })

  it('keeps a folder’s linked deck on its own site: another site of the machine named is refused, nothing pushed', async () => {
    const s = setup({
      override: (args, child) => {
        if (!args.includes('open')) return false
        answer(
          JSON.stringify({ presentationId: 'd9', baseUrl: `${DECKS}/`, url: `${DECKS}/d/d9` })
        )(child)
        return true
      }
    })
    // Both sites are the machine's; the folder is a deck on the first, the second is named.
    expect(
      await refusal(
        s.share.share({ sessionId: 's1', target: s.folder, site: LOCAL, link: defaults })
      )
    ).toBe(`ArtefactRefusal: ${deckStays(DECKS)}`)
    expect(s.commands().filter((call) => call.args.includes('push'))).toEqual([])
    expect(s.slideless.argv()).toEqual([
      ['--json', 'profiles'],
      ['--json', 'open', s.folder]
    ])
  })

  it('refuses a folder whose link file names a site the machine does not list: only open and the listing run', async () => {
    const elsewhere = 'https://elsewhere.example.test'
    const s = setup({
      override: (args, child) => {
        if (!args.includes('open')) return false
        answer(
          JSON.stringify({
            presentationId: 'd9',
            baseUrl: `${elsewhere}/`,
            url: `${elsewhere}/d/d9`
          })
        )(child)
        return true
      }
    })
    expect(linkedElsewhere(elsewhere)).toBe(
      "This folder is linked to a deck on https://elsewhere.example.test, which is not one of this machine's Slideless sites: add it with « Add a site » in Settings › Slideless first."
    )
    expect(
      await refusal(s.share.share({ sessionId: 's1', target: s.folder, link: defaults }))
    ).toBe(`ArtefactRefusal: ${linkedElsewhere(elsewhere)}`)
    // The local read of the link file, then the machine's listing: nothing reached a site.
    expect(s.slideless.argv()).toEqual([
      ['--json', 'open', s.folder],
      ['--json', 'profiles']
    ])
    // A site of the machine named beside it changes nothing: the listing is read once.
    const before = s.slideless.calls.length
    expect(
      await refusal(
        s.share.share({ sessionId: 's1', target: s.folder, site: DECKS, link: defaults })
      )
    ).toBe(`ArtefactRefusal: ${linkedElsewhere(elsewhere)}`)
    expect(s.slideless.argv().slice(before)).toEqual([
      ['--json', 'profiles'],
      ['--json', 'open', s.folder]
    ])
    expect(await s.share.deck('s1', s.folder)).toMatchObject({ deckId: null, links: [] })
  })

  it('answers deck_gone for a deck the site no longer has, makes no link and records nothing', async () => {
    let gone = false
    const s = setup({
      override: (args, child) => {
        if (!gone || !args.includes('push')) return false
        answer('', 1, 'Error: not_found: no such presentation\n')(child)
        return true
      }
    })
    await s.share.share({ sessionId: 's1', target: s.folder, site: DECKS, link: defaults })
    const recorded = await s.share.deck('s1', s.folder)
    gone = true
    const answered = await s.share.share({ sessionId: 's1', target: s.folder, link: defaults })
    expect(answered).toEqual({ _tag: 'deck_gone', deck: recorded })
    expect(s.commands().filter((call) => call.args.includes('share'))).toHaveLength(1)
    expect(await s.share.deck('s1', s.folder)).toEqual(recorded)
  })

  it('refuses a link past the fifty a deck keeps before anything runs; a revoke makes room, and a new deck starts with none', async () => {
    const s = setup()
    await s.share.share({ sessionId: 's1', target: s.folder, site: DECKS, link: defaults })
    for (let n = 2; n <= MAX_LINKS_PER_DECK; n++)
      s.decks.addLink(s.folder, {
        tokenId: `kept-${n}`,
        name: 'Clave',
        url: `${DECKS}/s/secret-kept-${n}`,
        createdAt: '2026-11-26T10:00:00.000Z',
        expiresAt: null,
        pinnedVersion: null,
        hasPassword: false
      })
    expect((await s.share.deck('s1', s.folder)).links).toHaveLength(MAX_LINKS_PER_DECK)
    const ran = s.slideless.calls.length
    expect(
      await refusal(s.share.share({ sessionId: 's1', target: s.folder, link: defaults }))
    ).toBe(`ArtefactRefusal: ${tooManyLinks(MAX_LINKS_PER_DECK)}`)
    expect(tooManyLinks(MAX_LINKS_PER_DECK)).toBe(
      'This page already has 50 links made from Clave: revoke one before making another.'
    )
    // Nothing ran, and the oldest link is still there to revoke.
    expect(s.slideless.calls).toHaveLength(ran)
    expect((await s.share.deck('s1', s.folder)).links[0]!.tokenId).toBe('t1')
    await s.share.revoke('s1', s.folder, 't1')
    const again = await s.share.share({ sessionId: 's1', target: s.folder, link: defaults })
    expect(again.deck.links).toHaveLength(MAX_LINKS_PER_DECK)
    expect(again.deck.links[0]!.tokenId).toBe('kept-2')
    // A new deck (the old one gone from its site) starts with none: never refused for the old one's links.
    const remade = await s.share.share({
      sessionId: 's1',
      target: s.folder,
      site: LOCAL,
      newDeck: true,
      link: defaults
    })
    expect(remade).toMatchObject({ _tag: 'shared', deck: { site: LOCAL } })
    expect(remade.deck.links).toHaveLength(1)
  })

  it('answers a recorded deck’s push refused for another reason with the refusal, never deck_gone', async () => {
    const stale =
      'Error: The key of profile "decks" was refused by https://decks.example.test: it is stale, sign in again.\n'
    let refuse = false
    const s = setup({
      override: (args, child) => {
        if (!refuse || !args.includes('push')) return false
        answer('', 1, stale)(child)
        return true
      }
    })
    await s.share.share({ sessionId: 's1', target: s.folder, site: DECKS, link: defaults })
    const recorded = await s.share.deck('s1', s.folder)
    refuse = true
    expect(
      await refusal(s.share.share({ sessionId: 's1', target: s.folder, link: defaults }))
    ).toBe(
      'ArtefactRefusal: Slideless did not push the page: The key of profile "decks" was refused by https://decks.example.test: it is stale, sign in again.'
    )
    // The push went to the recorded deck, and nothing after it: no link, the record as it was.
    const pushes = s.commands().filter((call) => call.args.includes('push'))
    expect(pushes.at(-1)!.args.slice(-2)).toEqual(['--id', 'd1'])
    expect(s.commands().filter((call) => call.args.includes('share'))).toHaveLength(1)
    expect(await s.share.deck('s1', s.folder)).toEqual(recorded)
  })

  it.each(LOOKED_ELSEWHERE)(
    'answers a push refused in another %s with its refusal, never deck_gone',
    async (_where, said) => {
      let refuse = false
      const s = setup({
        override: (args, child) => {
          if (!refuse || !args.includes('push')) return false
          answer('', 1, `Error: ${said}\n`)(child)
          return true
        }
      })
      await s.share.share({ sessionId: 's1', target: s.folder, site: DECKS, link: defaults })
      const recorded = await s.share.deck('s1', s.folder)
      refuse = true
      expect(
        await refusal(s.share.share({ sessionId: 's1', target: s.folder, link: defaults }))
      ).toBe(`ArtefactRefusal: Slideless did not push the page: ${said}`)
      expect(await s.share.deck('s1', s.folder)).toEqual(recorded)
    }
  )

  it('says why the push failed, in the command’s words', async () => {
    const s = setup({
      override: (args, child) => {
        if (!args.includes('push')) return false
        answer('', 1, 'Error: the key was refused\n')(child)
        return true
      }
    })
    expect(
      await refusal(
        s.share.share({ sessionId: 's1', target: s.folder, site: DECKS, link: defaults })
      )
    ).toBe('ArtefactRefusal: Slideless did not push the page: the key was refused')
    expect(await s.share.deck('s1', s.folder)).toMatchObject({ deckId: null, links: [] })
  })

  it('gives each setting its flag, pins the version just pushed, and a password only on the input', async () => {
    const s = setup()
    await s.share.share({ sessionId: 's1', target: s.folder, site: DECKS, link: defaults })
    const shared = await s.share.share({
      sessionId: 's1',
      target: s.folder,
      title: 'Quarterly review',
      link: {
        name: 'For a client',
        expiresAt: '2026-12-31T23:59:59Z',
        password: 'open sesame',
        annotator: true,
        forms: false,
        download: false,
        bar: false,
        pdf: false,
        pinVersion: true
      }
    })
    const [push, made] = s.commands().slice(-2)
    expect(push!.args).toContain('Quarterly review')
    expect(made!.args).toEqual([
      '--api-url',
      DECKS,
      '--json',
      'share',
      'd1',
      '--name',
      'For a client',
      '--annotator',
      '--no-forms',
      '--no-download',
      '--no-bar',
      '--no-pdf',
      '--expires',
      '2026-12-31T23:59:59Z',
      '--to-version',
      '2',
      '--password-stdin'
    ])
    expect(made!.child.stdin.written).toBe('open sesame\n')
    expect(made!.child.stdin.ended).toBe(true)
    for (const call of s.slideless.calls) expect(call.args.join(' ')).not.toContain('sesame')
    expect(shared).toMatchObject({
      _tag: 'shared',
      deck: { title: 'Quarterly review', version: 2 },
      link: {
        name: 'For a client',
        expiresAt: '2026-12-31T23:59:59Z',
        pinnedVersion: 2,
        hasPassword: true
      }
    })
  })

  it('says the page is on the site when the link fails after the push, never with its password', async () => {
    const s = setup({
      override: (args, child) => {
        if (!args.includes('share')) return false
        answer('', 1, 'Error: the password open sesame is too common\n')(child)
        return true
      }
    })
    const refused = await refusal(
      s.share.share({
        sessionId: 's1',
        target: s.folder,
        site: DECKS,
        link: { ...defaults, password: 'open sesame' }
      })
    )
    expect(refused).toBe(
      'ArtefactRefusal: The page is on the site as version 1, but the link was not made: the password [hidden] is too common'
    )
    // The push is recorded; no link is.
    expect(await s.share.deck('s1', s.folder)).toMatchObject({
      deckId: 'd1',
      version: 1,
      links: []
    })
  })

  it('refuses a site that is not the machine’s, and a first link with no site', async () => {
    const s = setup()
    expect(
      await refusal(
        s.share.share({ sessionId: 's1', target: s.folder, site: CLOUD, link: defaults })
      )
    ).toBe(`ArtefactRefusal: ${CLOUD} is not one of this machine's Slideless sites.`)
    expect(await refusal(s.share.share({ sessionId: 's1', target: s.fileA, link: defaults }))).toBe(
      `ArtefactRefusal: ${CHOOSE_SITE}`
    )
    expect(s.commands().filter((call) => call.args.includes('push'))).toEqual([])
  })

  it('never logs a link’s address', async () => {
    const said = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')]
    const s = setup()
    await s.share.share({ sessionId: 's1', target: s.folder, site: DECKS, link: defaults })
    await s.share.revoke('s1', s.folder, 't1')
    for (const spy of said) expect(spy).not.toHaveBeenCalled()
  })
})

describe('revoking a link', () => {
  it('runs `unshare` with the one token, then lets the link go from the record', async () => {
    const s = setup()
    await s.share.share({ sessionId: 's1', target: s.folder, site: DECKS, link: defaults })
    await s.share.share({ sessionId: 's1', target: s.folder, link: defaults })
    const deck = await s.share.revoke('s1', s.folder, 't1')
    expect(s.commands().at(-1)!.args).toEqual([
      '--api-url',
      DECKS,
      '--json',
      'unshare',
      'd1',
      '--token',
      't1'
    ])
    expect(deck.links.map((link) => link.tokenId)).toEqual(['t2'])
    expect((await s.share.deck('s1', s.folder)).links.map((link) => link.tokenId)).toEqual(['t2'])
  })

  it('refuses no token, or a link Clave did not make, before anything runs', async () => {
    const s = setup()
    expect(await refusal(s.share.revoke('s1', s.folder, 't1'))).toBe(
      `ArtefactRefusal: ${FOREIGN_LINK}`
    )
    await s.share.share({ sessionId: 's1', target: s.folder, site: DECKS, link: defaults })
    const before = s.slideless.calls.length
    for (const tokenId of ['', 't-of-someone-else'])
      expect(await refusal(s.share.revoke('s1', s.folder, tokenId))).toBe(
        `ArtefactRefusal: ${FOREIGN_LINK}`
      )
    expect(s.slideless.calls).toHaveLength(before)
  })

  it('says why the command did not revoke it, and keeps the link', async () => {
    let refuse = false
    const s = setup({
      override: (args, child) => {
        if (!refuse || !args.includes('unshare')) return false
        answer('', 1, 'Error: the site is not reachable\n')(child)
        return true
      }
    })
    await s.share.share({ sessionId: 's1', target: s.folder, site: DECKS, link: defaults })
    refuse = true
    expect(await refusal(s.share.revoke('s1', s.folder, 't1'))).toBe(
      'ArtefactRefusal: Slideless did not revoke the link: the site is not reachable'
    )
    expect((await s.share.deck('s1', s.folder)).links).toHaveLength(1)
  })

  it.each(LOOKED_ELSEWHERE)(
    'keeps a link whose revocation was not found in another %s, and says why',
    async (_where, said) => {
      let refuse = false
      const s = setup({
        override: (args, child) => {
          if (!refuse || !args.includes('unshare')) return false
          answer('', 1, `Error: ${said}\n`)(child)
          return true
        }
      })
      await s.share.share({ sessionId: 's1', target: s.folder, site: DECKS, link: defaults })
      refuse = true
      expect(await refusal(s.share.revoke('s1', s.folder, 't1'))).toBe(
        `ArtefactRefusal: Slideless did not revoke the link: ${said}`
      )
      expect((await s.share.deck('s1', s.folder)).links.map((link) => link.tokenId)).toEqual(['t1'])
    }
  )

  it('lets go of a link the site no longer has: revoked on Slideless, or its deck deleted', async () => {
    let gone = false
    const s = setup({
      override: (args, child) => {
        if (!gone || !args.includes('unshare')) return false
        answer('', 1, 'Error: not_found: no such share token\n')(child)
        return true
      }
    })
    await s.share.share({ sessionId: 's1', target: s.folder, site: DECKS, link: defaults })
    gone = true
    const deck = await s.share.revoke('s1', s.folder, 't1')
    expect(deck.links).toEqual([])
    expect((await s.share.deck('s1', s.folder)).links).toEqual([])
  })
})

describe('an artefact’s deck', () => {
  it('is the record’s view, a folder’s link file when nothing is recorded, or nothing', async () => {
    const s = setup()
    expect(await s.share.deck('s1', s.folder)).toEqual({
      target: s.folder,
      site: null,
      deckId: null,
      title: null,
      version: null,
      pushedAt: null,
      links: [],
      linkedFolder: null,
      staged: false
    })
    expect(await s.share.deck('s1', s.fileA)).toMatchObject({ staged: true, linkedFolder: null })
    // The folder was asked once (its link file failed to read), the file never.
    expect(s.slideless.argv()).toEqual([['--json', 'open', s.folder]])
  })

  it('is refused for a session with no such artefact', async () => {
    const s = setup()
    expect(await refusal(s.share.deck('s2', s.folder))).toBe(
      'ArtefactRefusal: This session has no artefact open.'
    )
    expect(
      await refusal(
        s.share.share({ sessionId: 's1', target: '/elsewhere', site: DECKS, link: defaults })
      )
    ).toBe('ArtefactRefusal: This session has no artefact open.')
  })

  it('and its links are refused by a copy older than 0.15.0, before anything runs', async () => {
    const s = setup({ version: '0.14.1' })
    const sentence = `ArtefactRefusal: Clave's Slideless is 0.14.1; links need 0.15.0 or later: Settings › Software Update installs it.`
    expect(await refusal(s.share.deck('s1', s.folder))).toBe(sentence)
    expect(
      await refusal(
        s.share.share({ sessionId: 's1', target: s.folder, site: DECKS, link: defaults })
      )
    ).toBe(sentence)
    expect(s.slideless.calls).toEqual([])
  })
})

describe('a record of the decks that cannot be read', () => {
  it('refuses the deck view, a share and a revoke with its sentence before anything runs, and changes nothing', async () => {
    const s = setup()
    await s.share.share({ sessionId: 's1', target: s.folder, site: DECKS, link: defaults })
    const before = readFileSync(s.decksFile)
    const ran = s.slideless.calls.length
    const sentence = `ArtefactRefusal: ${recordUnreadable(
      s.decksFile,
      `EACCES: permission denied, open '${s.decksFile}'`
    )}`
    chmodSync(s.decksFile, 0o000)
    try {
      for (const call of [
        () => s.share.deck('s1', s.folder),
        () => s.share.share({ sessionId: 's1', target: s.folder, link: defaults }),
        () => s.share.share({ sessionId: 's1', target: s.fileA, site: DECKS, link: defaults }),
        () => s.share.revoke('s1', s.folder, 't1')
      ])
        expect(await refusal(call())).toBe(sentence)
    } finally {
      chmodSync(s.decksFile, 0o600)
    }
    // No listing, no link file read, no push: nothing ran, and the record is as it was.
    expect(s.slideless.calls).toHaveLength(ran)
    expect(readFileSync(s.decksFile).equals(before)).toBe(true)
    expect((await s.share.deck('s1', s.folder)).links.map((link) => link.tokenId)).toEqual(['t1'])
  })
})
