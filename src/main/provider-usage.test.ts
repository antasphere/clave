// The usage line of a provider connection: the parsers on documented samples
// with made-up figures, and the reader on an injected fetch — never the
// network, never a real key.
import { describe, expect, it, vi } from 'vitest'
import {
  PROVIDER_USAGE_ROADS,
  ProviderUsage,
  parseDeepSeekBalance,
  parseOpenRouterKey,
  parseVercelCredits,
  usageLineText,
  type ProviderUsageLine
} from './provider-usage'

const VALUE = 'sk-made-up-0123456789abcdef'
const MALFORMED: unknown[] = [null, 'not a body', { something: 'else' }]

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

function deepSeekSample(): unknown {
  return {
    is_available: true,
    balance_infos: [
      {
        currency: 'CNY',
        total_balance: '70.00',
        granted_balance: '0.00',
        topped_up_balance: '70.00'
      },
      {
        currency: 'USD',
        total_balance: '12.5',
        granted_balance: '2.50',
        topped_up_balance: '10.00'
      }
    ]
  }
}

describe('the parsers', () => {
  it('DeepSeek: the USD entry, else the first', () => {
    expect(parseDeepSeekBalance(deepSeekSample())).toEqual({
      kind: 'balance',
      left: '12.50',
      currency: 'USD'
    })
    expect(
      parseDeepSeekBalance({
        is_available: true,
        balance_infos: [
          {
            currency: 'CNY',
            total_balance: '33.333',
            granted_balance: '0',
            topped_up_balance: '33.333'
          }
        ]
      })
    ).toEqual({ kind: 'balance', left: '33.33', currency: 'CNY' })
  })

  it('DeepSeek: an unavailable account with nothing left is still a balance', () => {
    expect(
      parseDeepSeekBalance({
        is_available: false,
        balance_infos: [
          {
            currency: 'USD',
            total_balance: '0.00',
            granted_balance: '0.00',
            topped_up_balance: '0.00'
          }
        ]
      })
    ).toEqual({ kind: 'balance', left: '0.00', currency: 'USD' })
  })

  it('OpenRouter: a limit when the key has one, else the usage', () => {
    expect(
      parseOpenRouterKey({
        data: { label: 'x', limit: 50, limit_remaining: 41.237, usage: 8.763, is_free_tier: false }
      })
    ).toEqual({ kind: 'limit', left: '41.24', of: '50.00', currency: 'USD' })
    expect(
      parseOpenRouterKey({
        data: { label: 'x', limit: null, limit_remaining: null, usage: 1234.5, is_free_tier: false }
      })
    ).toEqual({ kind: 'used', used: '1234.50', currency: 'USD' })
  })

  it('Vercel: the balance', () => {
    expect(parseVercelCredits({ balance: '95.5', total_used: '4.50' })).toEqual({
      kind: 'balance',
      left: '95.50',
      currency: 'USD'
    })
  })

  for (const [name, parse] of [
    ['DeepSeek', parseDeepSeekBalance],
    ['OpenRouter', parseOpenRouterKey],
    ['Vercel', parseVercelCredits]
  ] as const) {
    it(`${name}: a malformed body is unknown with a reason, never a throw`, () => {
      for (const body of MALFORMED) {
        const line = parse(body)
        expect(line.kind).toBe('unknown')
        if (line.kind === 'unknown') expect(line.reason).toMatch(/^[A-Z].*\.$/)
      }
    })
  }
})

describe('usageLineText', () => {
  it('words every kind', () => {
    const cases: [ProviderUsageLine, string][] = [
      [{ kind: 'balance', left: '12.50', currency: 'USD' }, '12.50 USD left'],
      [{ kind: 'limit', left: '41.24', of: '50.00', currency: 'USD' }, '41.24 of 50.00 USD left'],
      [{ kind: 'used', used: '1234.50', currency: 'USD' }, 'Pay per use · 1234.50 USD used'],
      [{ kind: 'payPerUse' }, 'Pay per use'],
      [{ kind: 'plan' }, 'Coding plan'],
      [{ kind: 'local' }, 'Local'],
      [{ kind: 'unknown', reason: 'Anything.' }, 'Usage unknown']
    ]
    for (const [line, text] of cases) expect(usageLineText(line)).toBe(text)
  })
})

describe('the roads', () => {
  it('fetch only where the provider documents what is left', () => {
    const roads = Object.entries(PROVIDER_USAGE_ROADS)
      .filter(([, entry]) => 'url' in entry)
      .map(([id]) => id)
      .sort()
    expect(roads).toEqual(['deepseek', 'openrouter', 'vercel'])
    expect(PROVIDER_USAGE_ROADS.minimax).toEqual({ kind: 'plan' })
    expect(PROVIDER_USAGE_ROADS.mistral).toEqual({ kind: 'payPerUse' })
    expect(PROVIDER_USAGE_ROADS.ollama).toEqual({ kind: 'local' })
  })
})

describe('ProviderUsage.read', () => {
  type FetchStub = (url: string, init?: RequestInit) => Promise<Response>
  interface Setup {
    usage: ProviderUsage
    fetch: ReturnType<typeof vi.fn<FetchStub>>
    openValue: ReturnType<typeof vi.fn<(id: string) => Promise<string | null>>>
    advance: (ms: number) => number
  }
  function setup(answer: () => Promise<Response> = async () => json(deepSeekSample())): Setup {
    let clock = 1_000_000
    const fetch = vi.fn<FetchStub>(async () => answer())
    const openValue = vi.fn<(id: string) => Promise<string | null>>(async () => VALUE)
    const usage = new ProviderUsage({
      openValue,
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => clock,
      cacheMs: 60_000
    })
    return { usage, fetch, openValue, advance: (ms: number) => (clock += ms) }
  }
  const deepseek = { id: 'conn-1', company: 'deepseek' as const }

  it('a fixed line calls neither the fetch nor the value', async () => {
    const { usage, fetch, openValue } = setup()
    expect(await usage.read({ id: 'k', company: 'moonshot' })).toEqual({ kind: 'plan' })
    expect(await usage.read({ id: 'o', company: 'ollama' })).toEqual({ kind: 'local' })
    expect(await usage.read({ id: 'c', company: 'custom' })).toEqual({ kind: 'payPerUse' })
    expect(fetch).not.toHaveBeenCalled()
    expect(openValue).not.toHaveBeenCalled()
  })

  it('sends one GET to the documented URL, the value in the bearer header only', async () => {
    const { usage, fetch } = setup()
    expect(await usage.read(deepseek)).toEqual({ kind: 'balance', left: '12.50', currency: 'USD' })
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe('https://api.deepseek.com/user/balance')
    expect(url).not.toContain(VALUE)
    expect(init?.method).toBe('GET')
    const headers = init?.headers as Record<string, string>
    expect(headers.Authorization).toBe(`Bearer ${VALUE}`)
    const elsewhere = Object.entries(headers).filter(([name]) => name !== 'Authorization')
    expect(JSON.stringify(elsewhere)).not.toContain(VALUE)
    expect(init?.body).toBeUndefined()
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('a second read inside the cache window makes no fetch', async () => {
    const { usage, fetch, advance } = setup()
    await usage.read(deepseek)
    advance(59_999)
    await usage.read(deepseek)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('a read after the cache window fetches again', async () => {
    const { usage, fetch, advance } = setup()
    await usage.read(deepseek)
    advance(60_000)
    await usage.read(deepseek)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('force fetches inside the window', async () => {
    const { usage, fetch } = setup()
    await usage.read(deepseek)
    await usage.read(deepseek, { force: true })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('concurrent reads of one connection share one fetch', async () => {
    const { usage, fetch } = setup()
    const [a, b, c] = await Promise.all([
      usage.read(deepseek),
      usage.read(deepseek),
      usage.read(deepseek)
    ])
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(a).toEqual(b)
    expect(b).toEqual(c)
  })

  it('invalidate makes the next read fetch', async () => {
    const { usage, fetch } = setup()
    await usage.read(deepseek)
    usage.invalidate(deepseek.id)
    await usage.read(deepseek)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('401 and 403 are refused, any other status is named', async () => {
    for (const status of [401, 403]) {
      const { usage } = setup(async () => json({ error: 'no' }, status))
      expect(await usage.read(deepseek)).toEqual({
        kind: 'unknown',
        reason: 'The provider refused the connection.'
      })
    }
    const { usage } = setup(async () => json({ error: 'no' }, 500))
    expect(await usage.read(deepseek)).toEqual({
      kind: 'unknown',
      reason: 'The provider answered 500.'
    })
  })

  it('a rejected fetch is unreachable', async () => {
    const { usage } = setup(async () => {
      throw new TypeError(`fetch failed for ${VALUE}`)
    })
    expect(await usage.read(deepseek)).toEqual({
      kind: 'unknown',
      reason: 'The provider could not be reached.'
    })
  })

  it('a request that never answers is aborted and unreachable', async () => {
    const fetch = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError'))
          )
        )
    )
    const usage = new ProviderUsage({
      openValue: async () => VALUE,
      fetch: fetch as unknown as typeof globalThis.fetch,
      timeoutMs: 5
    })
    expect(await usage.read(deepseek)).toEqual({
      kind: 'unknown',
      reason: 'The provider could not be reached.'
    })
  })

  it('no value is no key, and no fetch', async () => {
    const { usage, fetch, openValue } = setup()
    openValue.mockResolvedValue(null)
    expect(await usage.read(deepseek)).toEqual({
      kind: 'unknown',
      reason: 'The connection has no key.'
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('a body that does not parse gives the parser’s reason', async () => {
    const { usage } = setup(async () => json({ nope: true }))
    const line = await usage.read(deepseek)
    expect(line).toEqual(parseDeepSeekBalance({ nope: true }))
  })

  it('the value is in no returned line, whatever the outcome', async () => {
    const answers: (() => Promise<Response>)[] = [
      async () => json(deepSeekSample()),
      async () => json({ error: VALUE }, 401),
      async () => json({ error: VALUE }, 500),
      async () => json({ balance_infos: VALUE }),
      async () => new Response(`not json ${VALUE}`, { status: 200 }),
      async () => {
        throw new Error(VALUE)
      }
    ]
    for (const answer of answers) {
      const { usage } = setup(answer)
      const line = await usage.read(deepseek)
      expect(JSON.stringify(line)).not.toContain(VALUE)
      expect(usageLineText(line)).not.toContain(VALUE)
    }
  })
})
