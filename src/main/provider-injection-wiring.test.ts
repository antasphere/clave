import { afterEach, describe, expect, it, vi } from 'vitest'

// The spawn module reaches pty-backend (the login shell's environment), which
// pulls node-pty and electron at import; neither is needed here.
vi.mock('node-pty', () => ({ spawn: vi.fn() }))
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('./mcp/mcp-runtime', () => ({
  getMcpRuntime: () => null,
  writeSessionMcpConfig: () => null,
  deleteSessionMcpConfig: () => undefined
}))

import type { ProviderConnectionView } from '@clave/contract/settings/connections'
import {
  connectionForSpawn,
  endpointForSpawn,
  wireProviderConnections,
  type ProviderConnectionsSource
} from './provider-injection-wiring'
import {
  providerConnectionsForListing,
  providerInjectionForSpawn,
  setConnectionListingSource,
  setConnectionSource
} from './provider-injection-spawn'
import {
  providerUsageView,
  setConnectionRefSource,
  setConnectionValueSource
} from './provider-usage'

/**
 * Lane B's store plugged into lane C's sources (PRDCT-4496), against a fake
 * manager: the description a spawn reads, the key opened once per spawn and
 * kept nowhere, the listing, the usage line's two sources, and the cached
 * lines dropped when a key moves. Made-up values only.
 */

const KEY = 'e2e-made-up-wiring-0001'

function view(over: Partial<ProviderConnectionView> & { id: string }): ProviderConnectionView {
  return {
    label: over.id,
    company: 'moonshot',
    kind: 'key',
    pool: over.company ?? 'moonshot',
    endpoints: [
      { wireFormat: 'anthropic-messages', baseUrl: 'https://made-up.invalid/anthropic' },
      { wireFormat: 'openai-chat', baseUrl: 'https://made-up.invalid/v1' }
    ],
    needsKey: true,
    hasKey: true,
    keySetAt: 1,
    createdAt: 1,
    ...over
  }
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- the fakes' own types are what the tests read
function fakeManager(views: ProviderConnectionView[]) {
  let listener: ((list: ProviderConnectionView[]) => void) | null = null
  const openKey = vi.fn(async (id: string | undefined) =>
    views.find((v) => v.id === id)?.hasKey ? KEY : undefined
  )
  const manager: ProviderConnectionsSource = {
    get: (id) => views.find((v) => v.id === id),
    forHarness: () => views,
    openKey,
    onChange: (fn) => {
      listener = fn
      return () => (listener = null)
    }
  }
  return { manager, openKey, emit: (list: ProviderConnectionView[]) => listener?.(list) }
}

const spawnDeps = {
  sync: () => '/made-up/pi-connections/x',
  catalog: async () => [],
  root: () => '/made-up/pi-connections',
  loginEnv: () => ({}),
  homedir: () => '/made-up/home'
}

afterEach(() => {
  setConnectionSource(async () => null)
  setConnectionListingSource(null)
  setConnectionRefSource(async () => null)
  setConnectionValueSource(async () => null)
})

describe('connectionForSpawn', () => {
  it('describes a connection with its key opened, and the chat endpoint first', async () => {
    const { manager } = fakeManager([view({ id: 'k', label: 'Kimi work' })])
    expect(await connectionForSpawn(manager, 'k')).toEqual({
      id: 'k',
      label: 'Kimi work',
      company: 'moonshot',
      endpoint: { wireFormat: 'openai-chat', baseUrl: 'https://made-up.invalid/v1' },
      value: KEY
    })
  })

  it('a connection that needs no key is described with no value, its key never asked for', async () => {
    const { manager, openKey } = fakeManager([
      view({
        id: 'o',
        company: 'ollama',
        needsKey: false,
        hasKey: false,
        keySetAt: null,
        endpoints: [{ wireFormat: 'openai-chat', baseUrl: 'http://10.0.0.9:11434/v1' }]
      })
    ])
    const described = await connectionForSpawn(manager, 'o')
    expect(described).toMatchObject({ company: 'ollama', value: null })
    expect(described?.endpoint?.baseUrl).toBe('http://10.0.0.9:11434/v1')
    expect(openKey).not.toHaveBeenCalled()
  })

  it('a connection that needs a key and has none: a null value, and the spawn refuses it', async () => {
    const { manager } = fakeManager([view({ id: 'k', hasKey: false, keySetAt: null })])
    expect(await connectionForSpawn(manager, 'k')).toMatchObject({ value: null })
    wireProviderConnections(manager, { invalidate: () => undefined })
    await expect(providerInjectionForSpawn('pi', { connectionId: 'k' }, spawnDeps)).rejects.toThrow(
      'The connection has no key yet.'
    )
  })

  it('an unknown id is no connection', async () => {
    const { manager } = fakeManager([])
    expect(await connectionForSpawn(manager, 'gone')).toBeNull()
  })

  it('picks the endpoint by preference: chat, then Anthropic, then responses; none of none', () => {
    expect(
      endpointForSpawn([
        { wireFormat: 'openai-responses', baseUrl: 'r' },
        { wireFormat: 'anthropic-messages', baseUrl: 'a' }
      ])
    ).toEqual({ wireFormat: 'anthropic-messages', baseUrl: 'a' })
    expect(endpointForSpawn([{ wireFormat: 'openai-responses', baseUrl: 'r' }])).toEqual({
      wireFormat: 'openai-responses',
      baseUrl: 'r'
    })
    expect(endpointForSpawn([])).toBeNull()
  })
})

describe('wireProviderConnections', () => {
  it('a spawn on a road opens the key once, and a second spawn opens it again', async () => {
    const { manager, openKey } = fakeManager([view({ id: 'k' })])
    wireProviderConnections(manager, { invalidate: () => undefined })
    const first = await providerInjectionForSpawn('pi', { connectionId: 'k' }, spawnDeps)
    expect(first.providerEnv?.KIMI_API_KEY).toBe(KEY)
    expect(first.piProvider).toBe('kimi-coding')
    expect(openKey).toHaveBeenCalledTimes(1)
    await providerInjectionForSpawn('pi', { connectionId: 'k' }, spawnDeps)
    // Never cached in the wiring: each spawn asks the store.
    expect(openKey).toHaveBeenCalledTimes(2)
  })

  it('a generic connection on a null road is declared at its endpoint', async () => {
    const { manager } = fakeManager([
      view({
        id: 'g',
        company: 'generic',
        endpoints: [{ wireFormat: 'openai-responses', baseUrl: 'https://made-up.invalid/v9' }]
      })
    ])
    wireProviderConnections(manager, { invalidate: () => undefined })
    const out = await providerInjectionForSpawn('opencode', { connectionId: 'g' }, spawnDeps)
    expect(out.providerEnv?.CLAVE_CONNECTION_API_KEY).toBe(KEY)
    const config = JSON.parse(out.providerEnv!.OPENCODE_CONFIG_CONTENT) as {
      providers: Record<string, { package: string; settings: { baseURL: string } }>
    }
    expect(config.providers['clave-generic']).toMatchObject({
      package: '@ai-sdk/openai',
      settings: { baseURL: 'https://made-up.invalid/v9' }
    })
  })

  it('lists the connections that hold their key or need none, never a key', () => {
    const { manager } = fakeManager([
      view({ id: 'k', label: 'Kimi' }),
      view({ id: 'nokey', hasKey: false, keySetAt: null }),
      view({ id: 'o', company: 'ollama', needsKey: false, hasKey: false, keySetAt: null })
    ])
    wireProviderConnections(manager, { invalidate: () => undefined })
    expect(providerConnectionsForListing('pi')).toEqual([
      { id: 'k', label: 'Kimi', company: 'moonshot' },
      { id: 'o', label: 'o', company: 'ollama' }
    ])
  })

  it('the usage line finds the connection by id and opens its key for the read', async () => {
    const { manager, openKey } = fakeManager([view({ id: 'm', company: 'minimax' })])
    wireProviderConnections(manager, { invalidate: () => undefined })
    // MiniMax's line is fixed: found by its id, no request.
    expect(await providerUsageView({ connectionId: 'm' })).toEqual({ kind: 'plan' })
    expect(await providerUsageView({ connectionId: 'gone' })).toEqual({
      kind: 'unknown',
      reason: 'The connection is not known here.'
    })
    expect(openKey).not.toHaveBeenCalled()
  })

  it('the value source opens the key, null without one', async () => {
    const { manager } = fakeManager([
      view({ id: 'd', company: 'deepseek' }),
      view({ id: 'n', company: 'deepseek', hasKey: false, keySetAt: null })
    ])
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>).Authorization
      return new Response(
        JSON.stringify({
          balance_infos: [{ currency: 'USD', total_balance: auth === `Bearer ${KEY}` ? '3' : '0' }]
        }),
        { status: 200 }
      )
    })
    vi.stubGlobal('fetch', fetch)
    try {
      wireProviderConnections(manager, { invalidate: () => undefined })
      expect(await providerUsageView({ connectionId: 'd', force: true })).toEqual({
        kind: 'balance',
        left: '3.00',
        currency: 'USD'
      })
      expect(await providerUsageView({ connectionId: 'n', force: true })).toEqual({
        kind: 'unknown',
        reason: 'The connection has no key.'
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('drops the cached usage line of every connection whose key moved, or that left', () => {
    const a = view({ id: 'a', keySetAt: 1 })
    const b = view({ id: 'b', keySetAt: 1 })
    const { manager, emit } = fakeManager([a, b])
    const invalidate = vi.fn()
    wireProviderConnections(manager, { invalidate })
    // The first change has nothing to compare to: every line goes.
    emit([a, b])
    expect(invalidate.mock.calls.map((c) => c[0]).sort()).toEqual(['a', 'b'])
    invalidate.mockClear()
    // A rename: no key moved.
    emit([{ ...a, label: 'renamed' }, b])
    expect(invalidate).not.toHaveBeenCalled()
    // b's key replaced.
    emit([a, { ...b, keySetAt: 2 }])
    expect(invalidate.mock.calls).toEqual([['b']])
    invalidate.mockClear()
    // a removed.
    emit([{ ...b, keySetAt: 2 }])
    expect(invalidate.mock.calls).toEqual([['a']])
  })
})
