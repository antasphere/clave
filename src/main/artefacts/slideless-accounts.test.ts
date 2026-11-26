import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LinksStorage } from './links'
import { ArtefactRefusal } from './refusal'
import {
  CHECK_TIMEOUT_MS,
  createSlidelessAccounts,
  LIST_TIMEOUT_MS,
  NO_LISTING,
  parseListing,
  SITE_ADDRESS,
  type SlidelessAccountsService
} from './slideless-accounts'
import { SlidelessSettings } from './slideless-settings'
import {
  answer,
  CLOUD,
  DECKS,
  fakeSlideless,
  isListing,
  listedProfile as profile,
  listingJson as listing,
  LOCAL,
  type FakeChild,
  type FakeSlideless
} from './slideless.test-support'

/**
 * The Slideless accounts of the machine (PRDCT-4266), over a fake copy of
 * the command line: the arguments of each call (global options first,
 * `--api-url` only on a call that reaches a site), the listing read
 * tolerantly, the sentence of a listing that cannot be made, and the calls
 * that change something refused before anything runs.
 */
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

interface Setup {
  accounts: SlidelessAccountsService
  slideless: FakeSlideless
  settings: SlidelessSettings
  storage: ReturnType<typeof memory>
}

/** The accounts over a fake copy that lists `profiles` and answers every other call with `other`. */
function setup(
  options: {
    profiles?: unknown[]
    other?: (args: string[], child: FakeChild) => void
    version?: string
    cli?: () => never
  } = {}
): Setup {
  const profiles = options.profiles ?? [profile(DECKS)]
  const slideless = fakeSlideless(
    (args, child) => {
      if (isListing(args)) return answer(listing(profiles))(child)
      if (options.other) return options.other(args, child)
      answer('{}')(child)
    },
    {
      ...(options.version !== undefined && { version: options.version }),
      ...(options.cli !== undefined && { cli: options.cli })
    }
  )
  const storage = memory()
  const settings = new SlidelessSettings(storage, () => {})
  const accounts = createSlidelessAccounts({
    cli: slideless.deps.cli,
    run: slideless.run,
    settings
  })
  return { accounts, slideless, settings, storage }
}

const refusal = (run: Promise<unknown>): Promise<string> =>
  run.then(
    () => 'no refusal',
    (error: Error) => `${error.name}: ${error.message}`
  )

afterEach(() => vi.restoreAllMocks())

describe('the listing', () => {
  it('runs `--json profiles` (15 s) or `--json profiles --check` (60 s), never with --api-url', async () => {
    const { accounts, slideless } = setup()
    const plain = await accounts.list({ check: false })
    const checked = await accounts.list({ check: true })
    expect(slideless.argv()).toEqual([
      ['--json', 'profiles'],
      ['--json', 'profiles', '--check']
    ])
    expect(plain.checked).toBe(false)
    expect(checked.checked).toBe(true)
    expect(plain.error).toBeNull()
    expect(plain.profiles.map((p) => p.site.origin)).toEqual([DECKS])
    expect([LIST_TIMEOUT_MS, CHECK_TIMEOUT_MS]).toEqual([15_000, 60_000])
  })

  it('reads every nullable field null, a value it does not know as it came, and drops a profile with no site', () => {
    const read = parseListing(
      JSON.stringify({
        machine: null,
        cliVersion: null,
        defaultSite: null,
        environment: { url: null, key: false, hubUrl: null },
        logins: [{ hub: 'https://hub.example.test', email: null, name: 'hub' }, { email: 'x' }],
        profiles: [
          {
            name: 'local',
            default: false,
            saved: false,
            site: {
              origin: LOCAL,
              name: null,
              hub: null,
              federated: null,
              cliVersion: null,
              seenAt: null
            },
            cliBehind: null,
            signIn: {
              state: 'a_state_of_a_newer_command',
              via: null,
              hub: null,
              email: null,
              staleKeys: null,
              fix: { kind: 'a_kind_of_a_newer_command', argv: ['slideless', 'fix-it'] },
              checked: 'unreachable',
              person: null
            },
            environment: [{ variable: 'SLIDELESS_URL', effect: 'refuses' }, { variable: 7 }]
          },
          { name: 'no site', site: { name: 'x' }, signIn: {} },
          { name: 'blank site', site: { origin: '  ' } }
        ]
      })
    )
    expect(read).toEqual({
      machine: null,
      cliVersion: null,
      defaultSite: null,
      environment: { url: null, key: false, hubUrl: null },
      logins: [{ hub: 'https://hub.example.test', email: null, name: 'hub' }],
      profiles: [
        {
          name: 'local',
          default: false,
          saved: false,
          site: {
            origin: LOCAL,
            name: null,
            hub: null,
            federated: null,
            cliVersion: null,
            seenAt: null
          },
          cliBehind: null,
          signIn: {
            state: 'a_state_of_a_newer_command',
            via: null,
            hub: null,
            email: null,
            staleKeys: null,
            fix: { kind: 'a_kind_of_a_newer_command', argv: ['slideless', 'fix-it'] },
            checked: 'unreachable',
            person: null
          },
          environment: [{ variable: 'SLIDELESS_URL', effect: 'refuses' }]
        }
      ]
    })
    // A profile missing its fields reads with each one empty.
    expect(parseListing(JSON.stringify({ profiles: [{ site: { origin: CLOUD } }] }))).toEqual({
      machine: null,
      cliVersion: null,
      defaultSite: null,
      environment: { url: null, key: false, hubUrl: null },
      logins: [],
      profiles: [
        {
          name: '',
          default: false,
          saved: false,
          site: {
            origin: CLOUD,
            name: null,
            hub: null,
            federated: null,
            cliVersion: null,
            seenAt: null
          },
          cliBehind: null,
          signIn: {
            state: 'unknown',
            via: null,
            hub: null,
            email: null,
            staleKeys: null,
            fix: null
          },
          environment: []
        }
      ]
    })
    expect(parseListing('Error: not a listing')).toBeNull()
  })

  it('carries the machine’s « New links go to »', async () => {
    const { accounts, settings } = setup()
    settings.setNewLinksSite(DECKS)
    expect((await accounts.list({ check: false })).newLinksSite).toBe(DECKS)
  })

  it('says why it cannot be listed, every other field empty, and runs nothing for a copy that cannot', async () => {
    const missing = setup({
      cli: () => {
        throw new ArtefactRefusal('Slideless is not installed on this server.')
      }
    })
    expect(await missing.accounts.list({ check: false })).toEqual({
      machine: null,
      cliVersion: null,
      defaultSite: null,
      environment: { url: null, key: false, hubUrl: null },
      logins: [],
      profiles: [],
      newLinksSite: null,
      checked: false,
      error: 'Slideless is not installed on this server.',
      needsUpdate: false
    })
    const old = setup({ version: '0.14.1' })
    expect(await old.accounts.list({ check: true })).toMatchObject({
      error:
        "Clave's Slideless is 0.14.1; accounts need 0.15.0 or later: Settings › Software Update installs it.",
      needsUpdate: true,
      profiles: []
    })
    expect([...missing.slideless.calls, ...old.slideless.calls]).toEqual([])
    // The override is recent enough, whatever it is.
    const override = setup({ version: 'override' })
    expect((await override.accounts.list({ check: false })).error).toBeNull()
  })

  it('says the command’s first error line when it fails, and when it prints no listing', async () => {
    const failing = fakeSlideless((_args, child) =>
      answer('', 1, 'Error: the configuration cannot be read\nat line 2\n')(child)
    )
    const settings = new SlidelessSettings(memory(), () => {})
    const accounts = createSlidelessAccounts({
      cli: failing.deps.cli,
      run: failing.run,
      settings
    })
    expect(await accounts.list({ check: false })).toMatchObject({
      error: 'the configuration cannot be read',
      needsUpdate: false,
      profiles: []
    })
    const silent = fakeSlideless((_args, child) => answer('not a listing')(child))
    const unread = createSlidelessAccounts({ cli: silent.deps.cli, run: silent.run, settings })
    expect((await unread.list({ check: false })).error).toBe(NO_LISTING)
  })
})

describe('adding a site', () => {
  it('runs `--json profiles add <url>` (its site is its argument), then lists', async () => {
    const s = setup({ other: (_args, child) => answer('{}')(child) })
    const answered = await s.accounts.addSite(` ${CLOUD} `)
    expect(s.slideless.argv()).toEqual([
      ['--json', 'profiles', 'add', CLOUD],
      ['--json', 'profiles']
    ])
    expect(answered.error).toBeNull()
  })

  it('is refused with the command’s first error line, or before anything runs on a copy too old', async () => {
    const s = setup({
      other: (_args, child) => answer('', 1, 'Error: that address is no Slideless site\n')(child)
    })
    expect(await refusal(s.accounts.addSite('https://nowhere.example.test'))).toBe(
      'ArtefactRefusal: that address is no Slideless site'
    )
    const old = setup({ version: '0.14.1' })
    expect(await refusal(old.accounts.addSite(CLOUD))).toContain('accounts need 0.15.0')
    expect(old.slideless.calls).toEqual([])
  })

  it('takes an http(s) address only: an option or a word is refused before anything runs', async () => {
    const s = setup()
    for (const url of [
      '--help',
      '--api-url=https://x.example.test',
      'decks.example.test',
      'file:///etc'
    ])
      expect(await refusal(s.accounts.addSite(url))).toBe(`ArtefactRefusal: ${SITE_ADDRESS}`)
    expect(s.slideless.calls).toEqual([])
  })
})

describe('the site new links go to', () => {
  it('is one of the listing’s sites, stored in normal form, and answered with the listing', async () => {
    const s = setup({ profiles: [profile(DECKS), profile(LOCAL, null, 'local')] })
    const answered = await s.accounts.setNewLinksSite('HTTP://127.0.0.1:3400/')
    expect(answered.newLinksSite).toBe(LOCAL)
    expect(answered.profiles).toHaveLength(2)
    expect(s.settings.newLinksSite()).toBe(LOCAL)
    expect(s.slideless.argv()).toEqual([['--json', 'profiles']])
  })

  it('is refused for a site that is not the machine’s, and nothing is written', async () => {
    const s = setup()
    expect(await refusal(s.accounts.setNewLinksSite(`${CLOUD}/`))).toBe(
      `ArtefactRefusal: ${CLOUD} is not one of this machine's Slideless sites.`
    )
    expect(s.storage.text).toBeNull()
  })

  it('is cleared with null, then listed', async () => {
    const s = setup()
    s.settings.setNewLinksSite(DECKS)
    expect((await s.accounts.setNewLinksSite(null)).newLinksSite).toBeNull()
    expect(s.settings.newLinksSite()).toBeNull()
  })
})

describe('a fix', () => {
  const remove = { kind: 'remove_profile', argv: ['slideless', 'profiles', 'remove', 'local'] }
  const check = { kind: 'check', argv: ['slideless', 'profiles', '--check'] }
  const login = { kind: 'hub_login', argv: ['slideless', '--profile', 'local', 'login'] }
  const key = { kind: 'paste_key', argv: ['slideless', '--api-url', LOCAL, 'login', '--api-key'] }

  it('removes a profile with the listing’s own command line, after the global options, then lists', async () => {
    const s = setup({ profiles: [profile(LOCAL, remove, 'local')] })
    await s.accounts.runFix(`${LOCAL}/`, 'remove_profile')
    expect(s.slideless.argv()).toEqual([
      ['--json', 'profiles'],
      ['--api-url', LOCAL, '--json', 'profiles', 'remove', 'local'],
      ['--json', 'profiles']
    ])
  })

  it('checks with the checked listing', async () => {
    const s = setup({ profiles: [profile(DECKS, check)] })
    expect((await s.accounts.runFix(DECKS, 'check')).checked).toBe(true)
    expect(s.slideless.argv()).toEqual([
      ['--json', 'profiles'],
      ['--json', 'profiles', '--check']
    ])
  })

  it('refuses a kind the listing did not give, a sign-in, a key or a site not listed, and runs no fix', async () => {
    const s = setup({ profiles: [profile(LOCAL, login, 'local'), profile(DECKS, key)] })
    expect(await refusal(s.accounts.runFix(LOCAL, 'remove_profile'))).toBe(
      `ArtefactRefusal: Slideless does not offer this fix for ${LOCAL} now: list the accounts again.`
    )
    expect(await refusal(s.accounts.runFix(LOCAL, 'hub_login'))).toBe(
      `ArtefactRefusal: ${LOCAL} signs in with a code: start its sign-in.`
    )
    expect(await refusal(s.accounts.runFix(DECKS, 'paste_key'))).toBe(
      `ArtefactRefusal: ${DECKS} signs in with a key: paste it.`
    )
    expect(await refusal(s.accounts.runFix(CLOUD, 'check'))).toBe(
      `ArtefactRefusal: ${CLOUD} is not one of this machine's Slideless sites.`
    )
    // Each was refused after its fresh listing, and nothing else ran.
    expect(s.slideless.argv()).toEqual([
      ['--json', 'profiles'],
      ['--json', 'profiles'],
      ['--json', 'profiles'],
      ['--json', 'profiles']
    ])
  })

  it('says the command’s error line when the removal fails, past a notice that the command is older than its site', async () => {
    const s = setup({
      profiles: [profile(LOCAL, remove, 'local')],
      other: (_args, child) =>
        answer(
          '',
          2,
          'This slideless (0.15.0) is older than http://127.0.0.1:3400 (0.15.1).\nError: the profile is in use\n'
        )(child)
    })
    expect(await refusal(s.accounts.runFix(LOCAL, 'remove_profile'))).toBe(
      'ArtefactRefusal: the profile is in use'
    )
  })

  it('refuses a fix that names another site than its own row, and runs nothing', async () => {
    const elsewhere = {
      kind: 'remove_profile',
      argv: [
        'slideless',
        '--api-url',
        'https://elsewhere.example.test',
        'profiles',
        'remove',
        'local'
      ]
    }
    const s = setup({ profiles: [profile(LOCAL, elsewhere, 'local')] })
    expect(await refusal(s.accounts.runFix(LOCAL, 'remove_profile'))).toBe(
      `ArtefactRefusal: Slideless offers ${LOCAL} a fix that names another site.`
    )
    expect(s.slideless.argv()).toEqual([['--json', 'profiles']])
  })
})

describe('a pasted key', () => {
  it('goes to `login --api-key-stdin` on its input, never on its command line, then lists', async () => {
    const s = setup({ profiles: [profile(DECKS), profile(LOCAL, null, 'local')] })
    await s.accounts.pasteKey(`${LOCAL}/`, 'slk_pasted_secret')
    const [listing, login, after] = s.slideless.calls
    expect(listing!.args).toEqual(['--json', 'profiles'])
    expect(login!.args).toEqual(['--api-url', LOCAL, '--json', 'login', '--api-key-stdin'])
    expect(login!.child.stdin.written).toBe('slk_pasted_secret\n')
    expect(login!.child.stdin.ended).toBe(true)
    expect(after!.args).toEqual(['--json', 'profiles'])
    for (const call of s.slideless.calls) expect(call.args.join(' ')).not.toContain('slk_pasted')
  })

  it('goes only to a site of the machine: another origin is refused before the key goes anywhere', async () => {
    const s = setup({ profiles: [profile(DECKS)] })
    expect(await refusal(s.accounts.pasteKey(LOCAL, 'slk_pasted_secret'))).toBe(
      `ArtefactRefusal: ${LOCAL} is not one of this machine's Slideless sites.`
    )
    expect(s.slideless.argv()).toEqual([['--json', 'profiles']])
    expect(s.slideless.calls[0]!.child.stdin.written).toBe('')
  })

  it('is refused with the command’s words, never with the key, and logs nothing', async () => {
    const said = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')]
    const s = setup({
      profiles: [profile(DECKS), profile(LOCAL, null, 'local')],
      other: (_args, child) =>
        answer('', 1, 'Error: slk_pasted_secret is not a key of this site\n')(child)
    })
    const refused = await refusal(s.accounts.pasteKey(LOCAL, 'slk_pasted_secret'))
    expect(refused).toBe(
      'ArtefactRefusal: Slideless did not take the key: [hidden] is not a key of this site'
    )
    expect(refused).not.toContain('slk_pasted_secret')
    for (const spy of said) expect(spy).not.toHaveBeenCalled()
    const old = setup({ version: '0.14.1' })
    expect(await refusal(old.accounts.pasteKey(LOCAL, 'slk_x1234'))).toContain(
      'accounts need 0.15.0'
    )
    expect(old.slideless.calls).toEqual([])
  })
})
