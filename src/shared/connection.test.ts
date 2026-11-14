import { describe, expect, it } from 'vitest'
import {
  CLAUDE_POOL,
  CODEX_POOL,
  CONNECTION_POOLS,
  CONNECTION_POOL_BY_ID,
  MACHINE_LOGIN_ID,
  claudeConnection,
  codexConnection,
  firstPoolOf,
  isConnectionPoolId,
  poolAccountOf,
  usageByConnection,
  type Connection
} from './connection'
import { HARNESSES, HARNESS_BY_ID } from './harness'
import { pickAccount, switchTargets, type AccountUsageSummary } from './account-pool'
// ── Lane B (harness wave): provider connections ──
import { PROVIDER_COMPANIES } from '@clave/contract/settings/provider-catalogue'

/** A weekly cap the service calls critical: the pool's rule reads it as out. */
const spent: AccountUsageSummary = {
  tightest: { kind: 'weekly_all', usedPercentage: 97, severity: 'critical' },
  windows: [{ kind: 'weekly_all', usedPercentage: 97, severity: 'critical' }]
}
const fresh: AccountUsageSummary = {
  tightest: { kind: 'weekly_all', usedPercentage: 20 },
  windows: [{ kind: 'weekly_all', usedPercentage: 20 }]
}

describe('the pools', () => {
  it('registers the Claude and Codex pools, each billed by its company and reading usage', () => {
    expect(CONNECTION_POOLS.map((pool) => pool.id)).toEqual([
      'claude',
      'codex',
      ...PROVIDER_COMPANIES.map((c) => c.id)
    ])
    expect(CLAUDE_POOL.company).toEqual({ id: 'anthropic', name: 'Anthropic' })
    expect(CODEX_POOL.company).toEqual({ id: 'openai', name: 'OpenAI' })
    expect(CLAUDE_POOL.reportsUsage && CODEX_POOL.reportsUsage).toBe(true)
    expect(CONNECTION_POOLS.slice(2).some((pool) => pool.reportsUsage)).toBe(false)
    expect(CONNECTION_POOL_BY_ID.claude).toBe(CLAUDE_POOL)
    expect(CONNECTION_POOL_BY_ID.codex).toBe(CODEX_POOL)
  })

  it('knows a registered pool id and nothing else', () => {
    expect(isConnectionPoolId('claude')).toBe(true)
    expect(isConnectionPoolId('codex')).toBe(true)
    for (const value of ['anthropic', 'Claude', ' claude', 'claude ', '', null, undefined, 1, {}])
      expect(isConnectionPoolId(value)).toBe(false)
  })
})

describe('the harness table names the pools each harness runs on', () => {
  it('Claude Code on the Claude pool, Codex on the Codex pool, Pi and OpenCode on the ten provider pools, Antigravity on none', () => {
    // The pools a stored key serves (PRDCT-4496).
    const providers = PROVIDER_COMPANIES.map((c) => c.id)
    expect(
      Object.fromEntries(HARNESSES.map((harness) => [harness.id, [...harness.connectionPools]]))
    ).toEqual({
      claude: ['claude'],
      codex: ['codex'],
      antigravity: [],
      pi: providers,
      opencode: providers
    })
  })

  it('names registered pools only', () => {
    for (const harness of HARNESSES)
      for (const id of harness.connectionPools) expect(isConnectionPoolId(id)).toBe(true)
  })

  it('lists a harness from its first pool, and a harness on none from no pool', () => {
    expect(firstPoolOf(HARNESS_BY_ID.claude)).toBe('claude')
    expect(firstPoolOf(HARNESS_BY_ID.codex)).toBe('codex')
    expect(firstPoolOf(HARNESS_BY_ID.antigravity)).toBeNull()
    expect(firstPoolOf(HARNESS_BY_ID.pi)).toBe('moonshot')
    expect(firstPoolOf(HARNESS_BY_ID.opencode)).toBe('moonshot')
    expect(firstPoolOf({ connectionPools: ['codex', 'claude'] })).toBe('codex')
  })
})

describe('a Claude account as its pool reads it', () => {
  it('the machine login is a usable subscription, with no token of its own', () => {
    expect(
      claudeConnection(
        { id: MACHINE_LOGIN_ID, label: 'Default', hasToken: false, tokenInvalid: false },
        fresh
      )
    ).toEqual({
      id: 'default',
      label: 'Default',
      pool: 'claude',
      company: 'anthropic',
      kind: 'subscription',
      usable: true,
      reportsUsage: true,
      usage: fresh
    })
  })

  it('a token account is usable with a token the service has not refused, and not otherwise', () => {
    const base = { id: 'c1', label: 'Anthropic 2' }
    expect(claudeConnection({ ...base, hasToken: true, tokenInvalid: false }).usable).toBe(true)
    expect(claudeConnection({ ...base, hasToken: true, tokenInvalid: true }).usable).toBe(false)
    expect(claudeConnection({ ...base, hasToken: false, tokenInvalid: false }).usable).toBe(false)
  })

  it('carries no read before one lands', () => {
    const connection = claudeConnection({
      id: 'c1',
      label: 'Anthropic 2',
      hasToken: true,
      tokenInvalid: false
    })
    expect(connection.reportsUsage).toBe(true)
    expect(connection.usage).toBeUndefined()
  })
})

describe('a Codex account as its pool reads it', () => {
  it('a ChatGPT login is a subscription that reports its caps', () => {
    expect(
      codexConnection(
        { id: 'default', label: 'Default', kind: 'chatgpt', hasCredential: true },
        fresh
      )
    ).toEqual({
      id: 'default',
      label: 'Default',
      pool: 'codex',
      company: 'openai',
      kind: 'subscription',
      usable: true,
      reportsUsage: true,
      usage: fresh
    })
  })

  it('an API key is a key paid per use: it reports none, and a read handed in is dropped', () => {
    expect(
      codexConnection({ id: 'k1', label: 'OpenAI 2', kind: 'apiKey', hasCredential: true }, spent)
    ).toEqual({
      id: 'k1',
      label: 'OpenAI 2',
      pool: 'codex',
      company: 'openai',
      kind: 'key',
      usable: true,
      reportsUsage: false,
      usage: undefined
    })
  })

  it('is usable once its home holds the credential, the machine login included', () => {
    expect(
      codexConnection({ id: 'default', label: 'Default', kind: 'chatgpt', hasCredential: false })
        .usable
    ).toBe(false)
    expect(
      codexConnection({ id: 'k1', label: 'OpenAI 2', kind: 'apiKey', hasCredential: false }).usable
    ).toBe(false)
  })
})

describe('a connection reports usage only when its pool reads it', () => {
  it('holds for every connection the two builders make', () => {
    const built = [
      claudeConnection(
        { id: 'default', label: 'Default', hasToken: false, tokenInvalid: false },
        fresh
      ),
      claudeConnection(
        { id: 'c1', label: 'Anthropic 2', hasToken: true, tokenInvalid: false },
        spent
      ),
      codexConnection(
        { id: 'default', label: 'Default', kind: 'chatgpt', hasCredential: true },
        fresh
      ),
      codexConnection({ id: 'k1', label: 'OpenAI 2', kind: 'apiKey', hasCredential: true }, spent)
    ]
    for (const connection of built) {
      const pool = CONNECTION_POOL_BY_ID[connection.pool]
      if (connection.reportsUsage) expect(pool.reportsUsage).toBe(true)
      if (!connection.reportsUsage) expect(connection.usage).toBeUndefined()
      expect(connection.company).toBe(pool.company.id)
    }
  })
})

describe('the pool rule reads the shape unchanged', () => {
  const pool: Connection[] = [
    codexConnection(
      { id: 'default', label: 'Default', kind: 'chatgpt', hasCredential: true },
      spent
    ),
    codexConnection({ id: 'k1', label: 'OpenAI 2', kind: 'apiKey', hasCredential: true }),
    codexConnection({ id: 'c2', label: 'OpenAI 3', kind: 'chatgpt', hasCredential: true }, fresh)
  ]
  const accounts = pool.map(poolAccountOf)
  const usage = usageByConnection(pool)

  it("a key is the rule's fallback and a subscription is not", () => {
    expect(accounts).toEqual([
      { id: 'default', usable: true },
      { id: 'k1', usable: true, fallback: true },
      { id: 'c2', usable: true }
    ])
    expect(usage).toEqual({ default: spent, k1: undefined, c2: fresh })
  })

  it('a launch leaves a spent subscription for the one with headroom, never for the key first', () => {
    expect(pickAccount({ accounts, usage, preferredId: 'default' })).toBe('c2')
  })

  it('with every subscription spent, the key is the last resort', () => {
    expect(pickAccount({ accounts, usage: { ...usage, c2: spent }, preferredId: 'default' })).toBe(
      'k1'
    )
  })

  it('the menu lists the key last among the open ones, never exhausted, and suggests the subscription', () => {
    const targets = switchTargets(accounts, usage, 'default')
    expect(targets.map((target) => target.id)).toEqual(['c2', 'k1'])
    expect(targets.find((target) => target.id === 'k1')?.exhausted).toBe(false)
    expect(targets.find((target) => target.id === 'c2')?.suggested).toBe(true)
  })
})
