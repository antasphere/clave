import fs from 'fs'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  throw new Error('the models catalogue imported electron')
})

import { standaloneTestPorts } from './ports/testing'
import {
  MODELS_CATALOG_FILE,
  MODELS_CATALOG_TTL_MS,
  MODELS_DEV_URL,
  ModelsCatalog,
  pruneModelsDev,
  type ModelsCatalogSnapshot
} from './models-catalog'

// The models.dev catalogue (PRDCT-4496): read from a stubbed fetch, never the
// network, cached a day under the test's own data directory. Every provider
// and model here is invented.

const API = {
  'acme-ai': {
    id: 'acme-ai',
    name: 'Acme AI',
    env: ['ACME_API_KEY'],
    api: 'https://api.acme.test/v1',
    npm: '@ai-sdk/openai-compatible',
    doc: 'https://acme.test/docs',
    models: {
      'zeta-2': {
        id: 'zeta-2',
        name: 'Zeta 2',
        reasoning: true,
        tool_call: true,
        attachment: false,
        limit: { context: 200000, output: 32000 },
        release_date: '2026-10-01',
        cost: { input: 0.5, output: 2, cache_read: 0.1 }
      },
      'alpha-1': {
        id: 'alpha-1',
        name: 'Alpha 1',
        reasoning: false,
        tool_call: true,
        status: 'deprecated'
      },
      'beta-x': { id: 'beta-x', name: 'Beta X', status: 'beta' }
    }
  },
  'bolt-lab': {
    id: 'bolt-lab',
    name: 'Bolt Lab',
    env: ['BOLT_KEY'],
    models: { one: { id: 'one', name: 'One', reasoning: true, tool_call: false } }
  }
}

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>
const okFetch = (body: unknown = API): FetchMock =>
  vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status: 200 }))

const snapshotOnDisk = (dir: string, snapshot: ModelsCatalogSnapshot): void =>
  fs.writeFileSync(path.join(dir, MODELS_CATALOG_FILE), JSON.stringify(snapshot))
const readDisk = (dir: string): ModelsCatalogSnapshot =>
  JSON.parse(fs.readFileSync(path.join(dir, MODELS_CATALOG_FILE), 'utf-8')) as ModelsCatalogSnapshot

const T0 = 1_800_000_000_000

let ports: ReturnType<typeof standaloneTestPorts>
let clock: number
const now = (): number => clock
const make = (fetchImpl: typeof fetch, timeoutMs?: number): ModelsCatalog =>
  new ModelsCatalog({ ports: () => ports, fetch: fetchImpl, now, timeoutMs })

beforeEach(() => {
  ports = standaloneTestPorts()
  clock = T0
})
afterEach(() => {
  vi.useRealTimers()
})

describe('pruneModelsDev', () => {
  it('keeps the used fields, drops the rest, tolerates garbage, sorts by id', () => {
    const providers = pruneModelsDev({
      ...API,
      'no-models': { id: 'no-models', name: 'No Models' },
      'no-id': { name: 'Nameless', models: {} },
      junk: 'a string',
      nothing: null,
      'bad-models': {
        id: 'bad-models',
        env: 'NOT_AN_ARRAY',
        models: { a: { name: 'no id' }, b: null, c: 'x', d: { id: 'd' } }
      }
    })
    expect(providers.map((p) => p.id)).toEqual(['acme-ai', 'bad-models', 'bolt-lab', 'no-models'])
    const acme = providers[0]
    expect(acme).toEqual({
      id: 'acme-ai',
      name: 'Acme AI',
      env: ['ACME_API_KEY'],
      api: 'https://api.acme.test/v1',
      npm: '@ai-sdk/openai-compatible',
      models: [
        {
          id: 'alpha-1',
          name: 'Alpha 1',
          reasoning: false,
          toolCall: true,
          status: 'deprecated'
        },
        { id: 'beta-x', name: 'Beta X', reasoning: false, toolCall: false, status: 'beta' },
        {
          id: 'zeta-2',
          name: 'Zeta 2',
          reasoning: true,
          toolCall: true,
          contextLimit: 200000,
          outputLimit: 32000,
          releaseDate: '2026-10-01',
          cost: { input: 0.5, output: 2 }
        }
      ]
    })
    expect(acme).not.toHaveProperty('doc')
    expect(providers[1]).toEqual({
      id: 'bad-models',
      name: 'bad-models',
      env: [],
      models: [{ id: 'd', name: 'd', reasoning: false, toolCall: false }]
    })
    expect(providers[3]).toEqual({ id: 'no-models', name: 'No Models', env: [], models: [] })
    for (const garbage of ['a string', null, undefined, 42, [API]])
      expect(pruneModelsDev(garbage)).toEqual([])
  })
})

describe('ModelsCatalog', () => {
  it('fetches once, writes the document, and a second read within the day fetches nothing', async () => {
    const fetchMock = okFetch()
    const catalog = make(fetchMock)
    const first = await catalog.read()
    expect(first.stale).toBe(false)
    expect(first.error).toBeUndefined()
    expect(first.snapshot?.fetchedAt).toBe(T0)
    expect(first.snapshot?.providers.map((p) => p.id)).toEqual(['acme-ai', 'bolt-lab'])
    expect(readDisk(ports.dir)).toEqual(first.snapshot)
    clock = T0 + MODELS_CATALOG_TTL_MS - 1
    const second = await catalog.read()
    expect(second).toEqual({ snapshot: first.snapshot, stale: false })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('fetches again once the day has passed', async () => {
    const fetchMock = okFetch()
    const catalog = make(fetchMock)
    await catalog.read()
    clock = T0 + MODELS_CATALOG_TTL_MS + 1
    const again = await catalog.read()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(again.snapshot?.fetchedAt).toBe(clock)
    expect(readDisk(ports.dir).fetchedAt).toBe(clock)
  })

  it('a fresh instance with a document on disk younger than the day fetches nothing', async () => {
    snapshotOnDisk(ports.dir, { fetchedAt: T0 - 1000, providers: pruneModelsDev(API) })
    const fetchMock = okFetch()
    const read = await make(fetchMock).read()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(read.stale).toBe(false)
    expect(read.snapshot?.fetchedAt).toBe(T0 - 1000)
  })

  it('a fresh instance with a document older than the day fetches', async () => {
    snapshotOnDisk(ports.dir, {
      fetchedAt: T0 - MODELS_CATALOG_TTL_MS - 1,
      providers: pruneModelsDev(API)
    })
    const fetchMock = okFetch()
    const read = await make(fetchMock).read()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(read.snapshot?.fetchedAt).toBe(T0)
  })

  const failures: [string, () => typeof fetch][] = [
    [
      'a network error',
      () => vi.fn<typeof fetch>(async () => Promise.reject(new TypeError('fetch failed')))
    ],
    [
      'a non-200 answer',
      () => vi.fn<typeof fetch>(async () => new Response('secret upstream text', { status: 503 }))
    ],
    [
      'invalid JSON',
      () => vi.fn<typeof fetch>(async () => new Response('{not json secret', { status: 200 }))
    ]
  ]

  describe.each(failures)('on %s', (_name, failing) => {
    it('serves the stale document on disk with an error', async () => {
      const old = { fetchedAt: T0 - 2 * MODELS_CATALOG_TTL_MS, providers: pruneModelsDev(API) }
      snapshotOnDisk(ports.dir, old)
      const read = await make(failing()).read()
      expect(read.stale).toBe(true)
      expect(read.snapshot).toEqual(old)
      expect(read.error).toMatch(/models\.dev/)
      expect(read.error).not.toMatch(/secret/)
    })

    it('answers no snapshot when nothing is on disk', async () => {
      const read = await make(failing()).read()
      expect(read.snapshot).toBeNull()
      expect(read.stale).toBe(true)
      expect(read.error).toMatch(/models\.dev/)
      expect(fs.existsSync(path.join(ports.dir, MODELS_CATALOG_FILE))).toBe(false)
    })
  })

  it('a forced read that fails falls back on the snapshot it had', async () => {
    const fetchMock = okFetch()
    const catalog = make(fetchMock)
    const first = await catalog.read()
    fetchMock.mockImplementation(async () => Promise.reject(new TypeError('fetch failed')))
    const forced = await catalog.read({ force: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(forced.stale).toBe(true)
    expect(forced.snapshot).toEqual(first.snapshot)
  })

  it('two concurrent reads share one fetch', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const fetchMock = vi.fn<typeof fetch>(async () => {
      await gate
      return new Response(JSON.stringify(API), { status: 200 })
    })
    const catalog = make(fetchMock)
    const a = catalog.read()
    const b = catalog.read()
    release()
    const [ra, rb] = await Promise.all([a, b])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(ra).toBe(rb)
    expect(ra.snapshot?.providers).toHaveLength(2)
  })

  it('modelsOf hides deprecated models; providers(ids) keeps the order and omits unknown ids', async () => {
    const catalog = make(okFetch())
    expect((await catalog.modelsOf('acme-ai')).map((m) => m.id)).toEqual(['beta-x', 'zeta-2'])
    expect(await catalog.modelsOf('nobody')).toEqual([])
    expect((await catalog.providers(['bolt-lab', 'nobody', 'acme-ai'])).map((p) => p.id)).toEqual([
      'bolt-lab',
      'acme-ai'
    ])
  })

  it('fetches MODELS_DEV_URL exactly and aborts at timeoutMs', async () => {
    vi.useFakeTimers()
    const seen: { url: string; method?: string }[] = []
    const hanging = vi.fn<typeof fetch>(
      (input, init) =>
        new Promise<Response>((_resolve, reject) => {
          seen.push({ url: String(input), method: init?.method })
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError'))
          )
        })
    )
    const pending = make(hanging, 5_000).read()
    await vi.advanceTimersByTimeAsync(4_999)
    let settled = false
    void pending.then(() => (settled = true))
    await Promise.resolve()
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const read = await pending
    expect(seen).toEqual([{ url: MODELS_DEV_URL, method: 'GET' }])
    expect(MODELS_DEV_URL).toBe('https://models.dev/api.json')
    expect(read).toEqual({ snapshot: null, stale: true, error: expect.any(String) })
  })
})

// Lane C of the harness wave (PRDCT-4496): the catalogue as a window reads it.
describe('ModelsCatalog.view', () => {
  it('maps every provider to the window’s fields only, the deprecated model kept with its status', async () => {
    const view = await make(okFetch()).view()
    expect(view).toEqual({
      fetchedAt: T0,
      stale: false,
      providers: [
        {
          id: 'acme-ai',
          name: 'Acme AI',
          models: [
            {
              id: 'alpha-1',
              name: 'Alpha 1',
              reasoning: false,
              toolCall: true,
              status: 'deprecated'
            },
            { id: 'beta-x', name: 'Beta X', reasoning: false, toolCall: false, status: 'beta' },
            {
              id: 'zeta-2',
              name: 'Zeta 2',
              reasoning: true,
              toolCall: true,
              contextLimit: 200000,
              outputLimit: 32000
            }
          ]
        },
        {
          id: 'bolt-lab',
          name: 'Bolt Lab',
          models: [{ id: 'one', name: 'One', reasoning: true, toolCall: false }]
        }
      ]
    })
    expect(view).not.toHaveProperty('error')
  })

  it('filters to the ids asked for, in their order, an unknown id omitted; an empty list names none', async () => {
    const catalog = make(okFetch())
    const some = await catalog.view({ providerIds: ['bolt-lab', 'nobody', 'acme-ai'] })
    expect(some.providers.map((p) => p.id)).toEqual(['bolt-lab', 'acme-ai'])
    const none = await catalog.view({ providerIds: [] })
    expect(none.providers.map((p) => p.id)).toEqual(['acme-ai', 'bolt-lab'])
  })

  it('a null snapshot gives no provider, a null date, and the failure', async () => {
    const view = await make(
      vi.fn<typeof fetch>(async () => Promise.reject(new TypeError('fetch failed')))
    ).view({ providerIds: ['acme-ai'] })
    expect(view).toEqual({ fetchedAt: null, stale: true, error: expect.any(String), providers: [] })
    expect(view.error).toMatch(/models\.dev/)
  })

  it('a forced view fetches again', async () => {
    const fetchMock = okFetch()
    const catalog = make(fetchMock)
    await catalog.view()
    await catalog.view({ force: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
