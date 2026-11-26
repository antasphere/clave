import { afterEach, describe, expect, it } from 'vitest'
import type {
  Artefact,
  ArtefactDeck,
  ArtefactEvent,
  SlidelessAccounts,
  SlidelessState
} from '@clave/contract/artefacts'
import { startEmbedded, type EmbeddedServer } from '../embedded'
import { FakeSource, Peer } from '../test-support'
import { ArtefactRefusal, type ArtefactsService } from './port'

/**
 * The artefacts domain over HTTP (PRDCT-4472): each endpoint reaches its
 * method with its payload, behind the bearer token; the implementation's
 * refusal is `ArtefactRefused` with its sentence; a server with nothing
 * behind the port says so; the three events reach a push client.
 */
let server: EmbeddedServer | undefined
afterEach(async () => {
  await server?.stop()
  server = undefined
})

const headers = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/json'
})
const post = (path: string, body: unknown, token = server!.token): Promise<Response> =>
  fetch(`${server!.url}${path}`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify(body)
  })
const get = (path: string, token = server!.token): Promise<Response> =>
  fetch(`${server!.url}${path}`, { headers: headers(token) })

const artefact: Artefact = {
  sessionId: 's1',
  target: '/work/deck',
  page: '/work/deck/index.html',
  title: 'deck',
  openedAt: '2026-11-12T10:00:00.000Z'
}
const ready: SlidelessState = { phase: 'ready', version: '0.14.1', error: null, override: false }
const LEASE = '0123456789abcdef0123456789abcdef'
const accounts: SlidelessAccounts = {
  machine: null,
  cliVersion: '0.15.0',
  defaultSite: null,
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
  site: 'https://decks.example.test',
  deckId: 'd1',
  title: 'deck',
  version: 2,
  pushedAt: '2026-11-26T10:00:00.000Z',
  links: [],
  linkedFolder: null,
  staged: false
}
const settings = {
  annotator: false,
  forms: true,
  download: true,
  bar: true,
  pdf: true,
  pinVersion: false
}

function fakePort(): {
  port: ArtefactsService
  asked: unknown[]
  emit: (event: ArtefactEvent) => void
} {
  const asked: unknown[] = []
  const listeners = new Set<(event: ArtefactEvent) => void>()
  const port: ArtefactsService = {
    open: async (sessionId, path, present) => {
      asked.push(
        present === undefined ? ['open', sessionId, path] : ['open', sessionId, path, present]
      )
      if (path === '/nowhere') throw new ArtefactRefusal('No such file or folder: /nowhere')
      return { ...artefact, sessionId, target: path }
    },
    close: async (sessionId) => {
      asked.push(['close', sessionId])
    },
    hold: async (sessionId, holdId) => {
      asked.push(['hold', sessionId, holdId])
      if (sessionId === 'bare') throw new ArtefactRefusal('This session has no artefact open.')
      return { holdId: holdId ?? 'h1', lease: LEASE, url: 'http://127.0.0.1:4100/', ttlMs: 90_000 }
    },
    release: async (sessionId, holdId) => {
      asked.push(['release', sessionId, holdId])
    },
    saveVersion: async (sessionId) => {
      asked.push(['saveVersion', sessionId])
      if (sessionId === 'broken') throw new Error('the disk is full')
      return { version: 2, created: true }
    },
    versions: async (sessionId) => {
      asked.push(['versions', sessionId])
      return { versions: [{ version: 2, createdAt: '2026-11-13T10:58:30.951Z', fileCount: 3 }] }
    },
    list: async () => {
      asked.push(['list'])
      return [artefact]
    },
    slidelessState: async () => {
      asked.push(['slidelessState'])
      return ready
    },
    installSlideless: async () => {
      asked.push(['installSlideless'])
      return ready
    },
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
      if (url === 'nowhere') throw new ArtefactRefusal('Error: nowhere is not a site.')
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
      return { id: 'i1', origin, phase: 'code_asked', email: options.email ?? null, message: null }
    },
    answerSlidelessSignIn: async (id, code) => {
      asked.push(['answerSlidelessSignIn', id, code])
      return { id, origin: 'https://decks.example.test', phase: 'done', email: null, message: null }
    },
    cancelSlidelessSignIn: async (id) => {
      asked.push(['cancelSlidelessSignIn', id])
    },
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
      return { _tag: 'deck_gone', deck }
    },
    revokeArtefactLink: async (sessionId, target, tokenId) => {
      asked.push(['revokeArtefactLink', sessionId, target, tokenId])
      return deck
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  return { port, asked, emit: (event) => listeners.forEach((l) => l(event)) }
}

describe('the artefacts over HTTP', () => {
  it('reaches each method with its payload and answers its result', async () => {
    const { port, asked } = fakePort()
    server = await startEmbedded({ ports: { sessions: new FakeSource(), artefacts: port } })
    const opened = await post('/artefacts/open', { sessionId: 's1', path: '/work/deck' })
    expect(opened.status).toBe(200)
    expect(await opened.json()).toEqual(artefact)
    expect((await post('/artefacts/close', { sessionId: 's1' })).status).toBeLessThan(300)
    const held = await post('/artefacts/hold', { sessionId: 's1' })
    expect(await held.json()).toEqual({
      holdId: 'h1',
      lease: LEASE,
      url: 'http://127.0.0.1:4100/',
      ttlMs: 90_000
    })
    expect((await post('/artefacts/hold', { sessionId: 's1', holdId: 'h7' })).status).toBe(200)
    expect(
      (await post('/artefacts/release', { sessionId: 's1', holdId: 'h7' })).status
    ).toBeLessThan(300)
    expect(await (await post('/artefacts/save-version', { sessionId: 's1' })).json()).toEqual({
      version: 2,
      created: true
    })
    expect(await (await get('/artefacts/versions?sessionId=s1')).json()).toEqual({
      versions: [{ version: 2, createdAt: '2026-11-13T10:58:30.951Z', fileCount: 3 }]
    })
    expect(await (await get('/artefacts')).json()).toEqual([artefact])
    expect(await (await get('/artefacts/slideless')).json()).toEqual(ready)
    expect(await (await post('/artefacts/slideless/install', {})).json()).toEqual(ready)
    expect(asked).toEqual([
      ['open', 's1', '/work/deck'],
      ['close', 's1'],
      ['hold', 's1', undefined],
      ['hold', 's1', 'h7'],
      ['release', 's1', 'h7'],
      ['saveVersion', 's1'],
      ['versions', 's1'],
      ['list'],
      ['slidelessState'],
      ['installSlideless']
    ])
  })

  it('answers a refusal as ArtefactRefused with its sentence, anything else as unavailable', async () => {
    const { port } = fakePort()
    server = await startEmbedded({ ports: { sessions: new FakeSource(), artefacts: port } })
    const refused = await post('/artefacts/open', { sessionId: 's1', path: '/nowhere' })
    expect(refused.status).toBe(422)
    expect(await refused.json()).toMatchObject({
      _tag: 'ArtefactRefused',
      message: 'No such file or folder: /nowhere'
    })
    const bare = await post('/artefacts/hold', { sessionId: 'bare' })
    expect(await bare.json()).toMatchObject({
      _tag: 'ArtefactRefused',
      message: 'This session has no artefact open.'
    })
    const broken = await post('/artefacts/save-version', { sessionId: 'broken' })
    expect(broken.status).toBe(422)
    expect(await broken.json()).toMatchObject({
      _tag: 'CapabilityUnavailable',
      capability: 'artefacts',
      message: 'the disk is full'
    })
  })

  it('refuses without the token, and says so on a server with no artefacts', async () => {
    server = await startEmbedded({ ports: { sessions: new FakeSource() } })
    expect((await post('/artefacts/open', { sessionId: 's1', path: '/x' }, 'wrong')).status).toBe(
      401
    )
    expect((await get('/artefacts', 'wrong')).status).toBe(401)
    const answers = [
      await post('/artefacts/open', { sessionId: 's1', path: '/x' }),
      await post('/artefacts/close', { sessionId: 's1' }),
      await post('/artefacts/hold', { sessionId: 's1' }),
      await post('/artefacts/release', { sessionId: 's1', holdId: 'h1' }),
      await post('/artefacts/save-version', { sessionId: 's1' }),
      await post('/artefacts/slideless/install', {}),
      await get('/artefacts'),
      await get('/artefacts/slideless'),
      // PRDCT-4266
      await get('/artefacts/slideless/accounts'),
      await post('/artefacts/slideless/accounts/check', {}),
      await post('/artefacts/slideless/accounts/sites', { url: 'https://decks.example.test' }),
      await post('/artefacts/slideless/accounts/new-links-site', { origin: null }),
      await post('/artefacts/slideless/accounts/fix', { origin: 'o', kind: 'check' }),
      await post('/artefacts/slideless/accounts/sign-in', { origin: 'o' }),
      await post('/artefacts/slideless/accounts/sign-in/answer', { id: 'i1', code: '123456' }),
      await post('/artefacts/slideless/accounts/sign-in/cancel', { id: 'i1' }),
      await post('/artefacts/slideless/accounts/key', { origin: 'o', key: 'slk_x' }),
      await get('/artefacts/deck?sessionId=s1&target=%2Fwork%2Fdeck'),
      await post('/artefacts/deck/share', { sessionId: 's1', target: '/t', link: settings }),
      await post('/artefacts/deck/revoke', { sessionId: 's1', target: '/t', tokenId: 't1' })
    ]
    for (const answer of answers) {
      expect(answer.status).toBe(422)
      expect(await answer.json()).toMatchObject({
        _tag: 'CapabilityUnavailable',
        capability: 'artefacts',
        message: 'This server shows no artefacts.'
      })
    }
  })

  it('passes present on to the port only when it is asked (PRDCT-4980)', async () => {
    const { port, asked } = fakePort()
    server = await startEmbedded({ ports: { sessions: new FakeSource(), artefacts: port } })
    expect(
      (await post('/artefacts/open', { sessionId: 's1', path: '/a', present: true })).status
    ).toBe(200)
    expect(
      (await post('/artefacts/open', { sessionId: 's1', path: '/b', present: false })).status
    ).toBe(200)
    expect((await post('/artefacts/open', { sessionId: 's1', path: '/c' })).status).toBe(200)
    expect(
      (await post('/artefacts/open', { sessionId: 's1', path: '/d', present: 'yes' })).status
    ).toBe(400)
    expect(asked).toEqual([
      ['open', 's1', '/a', true],
      ['open', 's1', '/b'],
      ['open', 's1', '/c']
    ])
  })

  it('passes a target on to the port only when it is named (PRDCT-5022)', async () => {
    const asked: unknown[] = []
    const { port } = fakePort()
    const record =
      (name: string) =>
      (...args: unknown[]): never => {
        asked.push([name, ...args])
        throw new ArtefactRefusal('recorded')
      }
    server = await startEmbedded({
      ports: {
        sessions: new FakeSource(),
        artefacts: {
          ...port,
          hold: record('hold'),
          saveVersion: record('saveVersion'),
          versions: record('versions'),
          close: async (...args: unknown[]) => void asked.push(['close', ...args])
        }
      }
    })
    await post('/artefacts/hold', { sessionId: 's1', target: '/work/talk' })
    await post('/artefacts/hold', { sessionId: 's1', holdId: 'h1' })
    await post('/artefacts/save-version', { sessionId: 's1', target: '/work/talk' })
    await get('/artefacts/versions?sessionId=s1&target=%2Fwork%2Ftalk')
    await post('/artefacts/close', { sessionId: 's1', target: '/work/talk' })
    await post('/artefacts/close', { sessionId: 's1' })
    expect(asked).toEqual([
      ['hold', 's1', undefined, '/work/talk'],
      ['hold', 's1', 'h1'],
      ['saveVersion', 's1', '/work/talk'],
      ['versions', 's1', '/work/talk'],
      ['close', 's1', '/work/talk'],
      ['close', 's1']
    ])
  })

  it('reaches each Slideless accounts and links method with its payload (PRDCT-4266)', async () => {
    const { port, asked } = fakePort()
    server = await startEmbedded({ ports: { sessions: new FakeSource(), artefacts: port } })
    expect(await (await get('/artefacts/slideless/accounts')).json()).toEqual(accounts)
    expect(await (await post('/artefacts/slideless/accounts/check', {})).json()).toMatchObject({
      checked: true
    })
    const site = 'https://decks.example.test'
    expect((await post('/artefacts/slideless/accounts/sites', { url: site })).status).toBe(200)
    expect(
      await (await post('/artefacts/slideless/accounts/new-links-site', { origin: site })).json()
    ).toMatchObject({ newLinksSite: site })
    await post('/artefacts/slideless/accounts/new-links-site', { origin: null })
    await post('/artefacts/slideless/accounts/fix', { origin: site, kind: 'remove_profile' })
    expect(
      await (await post('/artefacts/slideless/accounts/sign-in', { origin: site })).json()
    ).toMatchObject({ id: 'i1', phase: 'code_asked' })
    await post('/artefacts/slideless/accounts/sign-in', {
      origin: site,
      email: 'someone@example.test',
      hub: 'https://hub.example.test'
    })
    expect(
      await (
        await post('/artefacts/slideless/accounts/sign-in/answer', { id: 'i1', code: '123456' })
      ).json()
    ).toMatchObject({ phase: 'done' })
    expect(
      (await post('/artefacts/slideless/accounts/sign-in/cancel', { id: 'i1' })).status
    ).toBeLessThan(300)
    await post('/artefacts/slideless/accounts/key', { origin: site, key: 'slk_x' })
    expect(await (await get('/artefacts/deck?sessionId=s1&target=%2Fwork%2Fdeck')).json()).toEqual(
      deck
    )
    expect(
      await (
        await post('/artefacts/deck/share', {
          sessionId: 's1',
          target: '/work/deck',
          link: settings
        })
      ).json()
    ).toEqual({ _tag: 'deck_gone', deck })
    const asking = {
      site,
      newDeck: true,
      title: 'Deck',
      link: { ...settings, name: 'For a client', password: 'four', pinVersion: true }
    }
    await post('/artefacts/deck/share', { sessionId: 's1', target: '/work/deck', ...asking })
    expect(
      await (
        await post('/artefacts/deck/revoke', {
          sessionId: 's1',
          target: '/work/deck',
          tokenId: 't1'
        })
      ).json()
    ).toEqual(deck)
    expect(asked).toEqual([
      ['slidelessAccounts'],
      ['checkSlidelessAccounts'],
      ['addSlidelessSite', site],
      ['setNewLinksSite', site],
      ['setNewLinksSite', null],
      ['runSlidelessFix', site, 'remove_profile'],
      ['startSlidelessSignIn', site, {}],
      [
        'startSlidelessSignIn',
        site,
        { email: 'someone@example.test', hub: 'https://hub.example.test' }
      ],
      ['answerSlidelessSignIn', 'i1', '123456'],
      ['cancelSlidelessSignIn', 'i1'],
      ['pasteSlidelessKey', site, 'slk_x'],
      ['artefactDeck', 's1', '/work/deck'],
      ['shareArtefact', 's1', '/work/deck', { link: settings }],
      ['shareArtefact', 's1', '/work/deck', asking],
      ['revokeArtefactLink', 's1', '/work/deck', 't1']
    ])
  })

  it('answers a Slideless refusal with its sentence, and a short secret without repeating it (PRDCT-4266)', async () => {
    const { port, asked } = fakePort()
    server = await startEmbedded({ ports: { sessions: new FakeSource(), artefacts: port } })
    const refused = await post('/artefacts/slideless/accounts/sites', { url: 'nowhere' })
    expect(refused.status).toBe(422)
    expect(await refused.json()).toMatchObject({
      _tag: 'ArtefactRefused',
      message: 'Error: nowhere is not a site.'
    })
    asked.length = 0
    for (const [path, body, secret] of [
      [
        '/artefacts/deck/share',
        { sessionId: 's1', target: '/t', link: { ...settings, password: 'pw7' } },
        'pw7'
      ],
      ['/artefacts/slideless/accounts/sign-in/answer', { id: 'i1', code: 'c'.repeat(65) }, 'ccc'],
      ['/artefacts/slideless/accounts/key', { origin: 'o', key: 'k'.repeat(513) }, 'kkk']
    ] as const) {
      const answer = await post(path, body)
      expect(answer.status).toBe(400)
      expect(await answer.text()).not.toContain(secret)
    }
    expect(asked).toEqual([])
  })

  it('tells a push client each of its events', async () => {
    const { port, emit } = fakePort()
    server = await startEmbedded({ ports: { sessions: new FakeSource(), artefacts: port } })
    const peer = new Peer(server.url.replace('http', 'ws') + '/push')
    await peer.opened
    peer.send({ _tag: 'hello', token: server.token, client: 'test' })
    expect(await peer.next()).toMatchObject({ _tag: 'welcome' })
    const events: ArtefactEvent[] = [
      { _tag: 'artefact.changed', sessionId: 's1', artefact },
      { _tag: 'artefact.changed', sessionId: 's1', artefact: null },
      { _tag: 'artefact.changed', sessionId: 's1', artefact, artefacts: [artefact] },
      { _tag: 'artefact.preview_exited', sessionId: 's1' },
      { _tag: 'artefact.present_requested', sessionId: 's1' },
      { _tag: 'slideless.state_changed', state: ready }
    ]
    for (const event of events) {
      emit(event)
      expect(await peer.next()).toMatchObject({ _tag: 'event', event })
    }
    peer.ws.close()
  })
})
