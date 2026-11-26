import { afterEach, describe, expect, it } from 'vitest'
import {
  ArtefactRefused,
  type ArtefactDeck,
  type ArtefactShareLink,
  type SlidelessAccounts
} from '@clave/contract/artefacts'
import { CapabilityUnavailable } from '@clave/contract/errors'
import {
  ArtefactRefusal,
  startEmbedded,
  type ArtefactsService,
  type EmbeddedServer
} from '@clave/server'
import { FakeSource } from '@clave/server/test-support'
import { type ClaveApiClient, createApiClient } from './api'

/**
 * The artefacts through the typed client (PRDCT-4472): each call reaches the
 * server's port, a refusal is thrown as `ArtefactRefused` with its sentence,
 * a server that shows no artefacts as `CapabilityUnavailable`.
 */
let server: EmbeddedServer | undefined
let api: ClaveApiClient | undefined
afterEach(async () => {
  await api?.dispose()
  await server?.stop()
  api = server = undefined
})

const state = { phase: 'ready', version: '0.14.1', error: null } as const
const SITE = 'https://decks.example.test'
const accounts: SlidelessAccounts = {
  machine: null,
  cliVersion: '0.15.0',
  defaultSite: SITE,
  environment: { url: null, key: false, hubUrl: null },
  logins: [],
  profiles: [],
  newLinksSite: null,
  checked: false,
  error: null,
  needsUpdate: false
}
const deck: ArtefactDeck = {
  target: '/work/deck',
  site: SITE,
  deckId: 'd1',
  title: 'deck',
  version: 4,
  pushedAt: '2026-11-26T10:00:00.000Z',
  links: [],
  linkedFolder: null,
  staged: false
}
const link: ArtefactShareLink = {
  tokenId: 't1',
  name: 'Clave',
  url: `${SITE}/s/secret`,
  createdAt: '2026-11-26T10:00:00.000Z',
  expiresAt: null,
  pinnedVersion: 4,
  hasPassword: true
}
const settings = {
  annotator: true,
  forms: false,
  download: false,
  bar: true,
  pdf: false,
  pinVersion: true
}
const port = (asked: unknown[]): ArtefactsService => ({
  open: async (sessionId, path, present) => {
    asked.push(
      present === undefined ? ['open', sessionId, path] : ['open', sessionId, path, present]
    )
    if (path === '/nowhere') throw new ArtefactRefusal('No such file or folder: /nowhere')
    return { sessionId, target: path, page: `${path}/index.html`, title: 'deck', openedAt: 'now' }
  },
  close: async (sessionId) => void asked.push(['close', sessionId]),
  hold: async (sessionId, holdId, target) => {
    asked.push(
      target === undefined ? ['hold', sessionId, holdId] : ['hold', sessionId, holdId, target]
    )
    return {
      holdId: holdId ?? 'h1',
      lease: 'ab'.repeat(16),
      url: 'http://127.0.0.1:4100/',
      ttlMs: 90_000
    }
  },
  release: async (sessionId, holdId) => void asked.push(['release', sessionId, holdId]),
  saveVersion: async () => ({ version: 1, created: true }),
  versions: async () => ({
    versions: [{ version: 1, createdAt: '2026-11-13T10:44:40.854Z', fileCount: 1 }]
  }),
  list: async () => [],
  slidelessState: async () => state,
  installSlideless: async () => state,
  slidelessAccounts: async () => {
    asked.push(['slidelessAccounts'])
    return accounts
  },
  checkSlidelessAccounts: async () => {
    asked.push(['checkSlidelessAccounts'])
    return { ...accounts, checked: true }
  },
  addSlidelessSite: async (url) => {
    asked.push(['addSlidelessSite', url])
    return accounts
  },
  setNewLinksSite: async (origin) => {
    asked.push(['setNewLinksSite', origin])
    return { ...accounts, newLinksSite: origin }
  },
  runSlidelessFix: async (origin, kind) => {
    asked.push(['runSlidelessFix', origin, kind])
    return accounts
  },
  startSlidelessSignIn: async (origin, options) => {
    asked.push(['startSlidelessSignIn', origin, options])
    if (origin === 'elsewhere')
      throw new ArtefactRefusal("elsewhere is not one of this machine's Slideless sites.")
    return { id: 'i1', origin, phase: 'code_asked', email: options.email ?? null, message: null }
  },
  answerSlidelessSignIn: async (id, code) => {
    asked.push(['answerSlidelessSignIn', id, code])
    return { id, origin: SITE, phase: 'done', email: null, message: null }
  },
  cancelSlidelessSignIn: async (id) => void asked.push(['cancelSlidelessSignIn', id]),
  pasteSlidelessKey: async (origin, key) => {
    asked.push(['pasteSlidelessKey', origin, key])
    return accounts
  },
  artefactDeck: async (sessionId, target) => {
    asked.push(['artefactDeck', sessionId, target])
    return deck
  },
  shareArtefact: async (sessionId, target, request) => {
    asked.push(['shareArtefact', sessionId, target, request])
    return { _tag: 'shared', deck: { ...deck, links: [link] }, link }
  },
  revokeArtefactLink: async (sessionId, target, tokenId) => {
    asked.push(['revokeArtefactLink', sessionId, target, tokenId])
    return deck
  },
  subscribe: () => () => {}
})

describe('the artefacts of the client', () => {
  it('reaches the port with each call and answers what it answered', async () => {
    const asked: unknown[] = []
    server = await startEmbedded({ ports: { sessions: new FakeSource(), artefacts: port(asked) } })
    api = createApiClient({ url: server.url, token: server.token })
    expect((await api.artefacts.open('s1', '/work/deck')).page).toBe('/work/deck/index.html')
    expect((await api.artefacts.open('s1', '/work/talk', true)).page).toBe('/work/talk/index.html')
    expect((await api.artefacts.open('s1', '/work/notes', false)).page).toBe(
      '/work/notes/index.html'
    )
    expect((await api.artefacts.hold('s1')).holdId).toBe('h1')
    expect((await api.artefacts.hold('s1', 'h2')).holdId).toBe('h2')
    expect((await api.artefacts.hold('s1', undefined, '/work/talk')).holdId).toBe('h1')
    await api.artefacts.release('s1', 'h2')
    await api.artefacts.close('s1')
    expect(await api.artefacts.saveVersion('s1')).toEqual({ version: 1, created: true })
    expect(await api.artefacts.versions('s1')).toEqual({
      versions: [{ version: 1, createdAt: '2026-11-13T10:44:40.854Z', fileCount: 1 }]
    })
    expect(await api.artefacts.list()).toEqual([])
    expect(await api.artefacts.slidelessState()).toEqual(state)
    expect(await api.artefacts.installSlideless()).toEqual(state)
    expect(asked).toEqual([
      ['open', 's1', '/work/deck'],
      ['open', 's1', '/work/talk', true],
      ['open', 's1', '/work/notes'],
      ['hold', 's1', undefined],
      ['hold', 's1', 'h2'],
      ['hold', 's1', undefined, '/work/talk'],
      ['release', 's1', 'h2'],
      ['close', 's1']
    ])
    const refused = await api.artefacts.open('s1', '/nowhere').catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(ArtefactRefused)
    expect((refused as ArtefactRefused).message).toBe('No such file or folder: /nowhere')
  })

  it('throws CapabilityUnavailable from a server that shows no artefacts', async () => {
    server = await startEmbedded({ ports: { sessions: new FakeSource() } })
    api = createApiClient({ url: server.url, token: server.token })
    await expect(api.artefacts.list()).rejects.toBeInstanceOf(CapabilityUnavailable)
    await expect(api.artefacts.hold('s1')).rejects.toBeInstanceOf(CapabilityUnavailable)
    await expect(api.artefacts.slidelessAccounts()).rejects.toBeInstanceOf(CapabilityUnavailable)
    await expect(api.artefacts.artefactDeck('s1', '/work/deck')).rejects.toBeInstanceOf(
      CapabilityUnavailable
    )
  })
})

describe('the Slideless accounts and the links of the client (PRDCT-4266)', () => {
  it('reaches the port with each call and answers what it answered', async () => {
    const asked: unknown[] = []
    server = await startEmbedded({ ports: { sessions: new FakeSource(), artefacts: port(asked) } })
    api = createApiClient({ url: server.url, token: server.token })
    expect(await api.artefacts.slidelessAccounts()).toEqual(accounts)
    expect((await api.artefacts.checkSlidelessAccounts()).checked).toBe(true)
    expect(await api.artefacts.addSlidelessSite(SITE)).toEqual(accounts)
    expect((await api.artefacts.setNewLinksSite(SITE)).newLinksSite).toBe(SITE)
    expect((await api.artefacts.setNewLinksSite(null)).newLinksSite).toBeNull()
    await api.artefacts.runSlidelessFix(SITE, 'check')
    expect((await api.artefacts.startSlidelessSignIn(SITE)).phase).toBe('code_asked')
    await api.artefacts.startSlidelessSignIn(SITE, { email: 'someone@example.test' })
    await api.artefacts.startSlidelessSignIn(SITE, { hub: 'https://hub.example.test' })
    expect((await api.artefacts.answerSlidelessSignIn('i1', '123456')).phase).toBe('done')
    await api.artefacts.cancelSlidelessSignIn('i1')
    await api.artefacts.pasteSlidelessKey(SITE, 'slk_x')
    expect(await api.artefacts.artefactDeck('s1', '/work/deck')).toEqual(deck)
    const shared = await api.artefacts.shareArtefact('s1', '/work/deck', {
      site: SITE,
      link: { ...settings, password: 'four' }
    })
    expect(shared).toEqual({ _tag: 'shared', deck: { ...deck, links: [link] }, link })
    expect(await api.artefacts.revokeArtefactLink('s1', '/work/deck', 't1')).toEqual(deck)
    expect(asked).toEqual([
      ['slidelessAccounts'],
      ['checkSlidelessAccounts'],
      ['addSlidelessSite', SITE],
      ['setNewLinksSite', SITE],
      ['setNewLinksSite', null],
      ['runSlidelessFix', SITE, 'check'],
      ['startSlidelessSignIn', SITE, {}],
      ['startSlidelessSignIn', SITE, { email: 'someone@example.test' }],
      ['startSlidelessSignIn', SITE, { hub: 'https://hub.example.test' }],
      ['answerSlidelessSignIn', 'i1', '123456'],
      ['cancelSlidelessSignIn', 'i1'],
      ['pasteSlidelessKey', SITE, 'slk_x'],
      ['artefactDeck', 's1', '/work/deck'],
      [
        'shareArtefact',
        's1',
        '/work/deck',
        { site: SITE, link: { ...settings, password: 'four' } }
      ],
      ['revokeArtefactLink', 's1', '/work/deck', 't1']
    ])
    const refused = await api.artefacts
      .startSlidelessSignIn('elsewhere')
      .catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(ArtefactRefused)
    expect((refused as ArtefactRefused).message).toBe(
      "elsewhere is not one of this machine's Slideless sites."
    )
  })

  it('waits on the patient deadline exactly for the calls that wait on a site', async () => {
    // Every call takes 300 ms on this server; the plain deadline is 150 ms.
    const asked: unknown[] = []
    const fast = port(asked)
    const slow = Object.fromEntries(
      Object.entries(fast).map(([name, method]) => [
        name,
        name === 'subscribe'
          ? method
          : async (...args: unknown[]) => {
              await new Promise((resolve) => setTimeout(resolve, 300))
              return (method as (...a: unknown[]) => unknown)(...args)
            }
      ])
    ) as unknown as ArtefactsService
    server = await startEmbedded({ ports: { sessions: new FakeSource(), artefacts: slow } })
    api = createApiClient({
      url: server.url,
      token: server.token,
      timeoutMs: 150,
      patientTimeoutMs: 10_000
    })
    const a = api.artefacts
    const patient: Array<() => Promise<unknown>> = [
      () => a.checkSlidelessAccounts(),
      () => a.addSlidelessSite(SITE),
      () => a.runSlidelessFix(SITE, 'check'),
      () => a.startSlidelessSignIn(SITE),
      () => a.answerSlidelessSignIn('i1', '123456'),
      () => a.pasteSlidelessKey(SITE, 'slk_x'),
      () => a.shareArtefact('s1', '/work/deck', { link: settings }),
      () => a.revokeArtefactLink('s1', '/work/deck', 't1')
    ]
    const plain: Array<() => Promise<unknown>> = [
      () => a.slidelessAccounts(),
      () => a.setNewLinksSite(null),
      () => a.cancelSlidelessSignIn('i1'),
      () => a.artefactDeck('s1', '/work/deck')
    ]
    const settled = async (run: () => Promise<unknown>): Promise<boolean> =>
      run().then(
        () => true,
        () => false
      )
    expect(await Promise.all(patient.map(settled))).toEqual(patient.map(() => true))
    expect(await Promise.all(plain.map(settled))).toEqual(plain.map(() => false))
  })
})
