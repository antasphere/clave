import { describe, expect, it } from 'vitest'
import {
  claudeCardFacts,
  codexCardFacts,
  connectLabel,
  connectedCountText,
  harnessesForEndpoints,
  machineWords,
  modelPreview,
  moreLabel,
  offerFacts,
  providerCardFacts,
  providerKeyState,
  removalSentence
} from './connection-cards'

const claude = (over: Partial<Parameters<typeof claudeCardFacts>[0]> = {}) =>
  claudeCardFacts({
    id: 'a1',
    hasToken: true,
    tokenInvalid: false,
    tokenLife: 'expires in 12 months',
    migrated: false,
    isDefault: false,
    ...over
  })

describe('a Claude account card', () => {
  it('is a subscription Claude Code runs on', () => {
    const facts = claude()
    expect(facts.company).toBe('anthropic')
    expect(facts.companyName).toBe('Anthropic')
    expect(facts.what).toBe('Subscription')
    expect(facts.harnesses).toEqual(['claude'])
  })

  it('says it is signed in, and how long the token has', () => {
    expect(claude().state).toEqual({ label: 'Signed in, expires in 12 months', tone: 'ok' })
    expect(claude({ tokenLife: null }).state).toEqual({ label: 'Signed in', tone: 'ok' })
  })

  it('asks for attention when it cannot run a tab', () => {
    expect(claude({ hasToken: false, tokenLife: null }).state).toEqual({
      label: 'Needs sign-in',
      tone: 'attention'
    })
    expect(claude({ migrated: true }).state.label).toBe('Needs sign-in')
    expect(claude({ tokenInvalid: true }).state).toEqual({
      label: 'Sign-in refused',
      tone: 'attention'
    })
    expect(claude({ tokenLife: 'expired' }).state).toEqual({
      label: 'Sign-in expired',
      tone: 'attention'
    })
  })

  it('names the machine login quietly', () => {
    expect(claude({ isDefault: true, hasToken: false, tokenLife: null }).state).toEqual({
      label: 'Machine login',
      tone: 'quiet'
    })
  })
})

describe('a Codex account card', () => {
  const codex = (over: Partial<Parameters<typeof codexCardFacts>[0]> = {}) =>
    codexCardFacts({ id: 'c1', kind: 'chatgpt', hasCredential: true, isDefault: false, ...over })

  it('is a subscription, or pay per use with a key', () => {
    expect(codex().what).toBe('Subscription')
    expect(codex({ kind: 'apiKey' }).what).toBe('Pay per use')
    expect(codex().harnesses).toEqual(['codex'])
    expect(codex().companyName).toBe('OpenAI')
  })

  it('says its sign-in or its key in plain words', () => {
    expect(codex().state).toEqual({ label: 'Signed in', tone: 'ok' })
    expect(codex({ hasCredential: false }).state).toEqual({
      label: 'Needs sign-in',
      tone: 'attention'
    })
    expect(codex({ kind: 'apiKey' }).state).toEqual({ label: 'Key stored', tone: 'ok' })
    expect(codex({ kind: 'apiKey', hasCredential: false }).state).toEqual({
      label: 'Needs a key',
      tone: 'attention'
    })
    expect(codex({ isDefault: true }).state.label).toBe('Machine login')
    expect(codex({ isDefault: true, hasCredential: false }).state).toEqual({
      label: 'Not signed in',
      tone: 'attention'
    })
  })
})

describe('a stored provider connection card', () => {
  const moonshot = {
    company: 'moonshot' as const,
    needsKey: true,
    hasKey: true,
    endpoints: [
      { wireFormat: 'openai-chat' as const, baseUrl: 'https://api.kimi.ai/coding/v1' },
      { wireFormat: 'anthropic-messages' as const, baseUrl: 'https://api.kimi.ai/coding/' }
    ]
  }

  it('names its coding plan, its key and the harnesses its endpoints serve', () => {
    const facts = providerCardFacts(moonshot)
    expect(facts.companyName).toBe('Moonshot')
    expect(facts.what).toBe('Kimi Code plan')
    expect(facts.state).toEqual({ label: 'Key stored', tone: 'ok' })
    expect(facts.harnesses).toEqual(['pi', 'opencode'])
  })

  it('keeps a plan already named a plan as the company names it', () => {
    expect(providerCardFacts({ ...moonshot, company: 'zai' }).what).toBe('GLM Coding Plan')
    expect(providerCardFacts({ ...moonshot, company: 'minimax' }).what).toBe('Coding Plan')
  })

  it('says pay per use, many models, local or an endpoint of your own', () => {
    expect(providerCardFacts({ ...moonshot, company: 'deepseek' }).what).toBe('Pay per use')
    expect(providerCardFacts({ ...moonshot, company: 'mistral' }).what).toBe('Pay per use')
    expect(providerCardFacts({ ...moonshot, company: 'openrouter' }).what).toBe(
      'Many models, one key'
    )
    expect(providerCardFacts({ ...moonshot, company: 'ollama' }).what).toBe('Local models')
    expect(providerCardFacts({ ...moonshot, company: 'generic' }).what).toBe('Your own endpoint')
  })

  it('reads the key the way the page always has', () => {
    expect(providerKeyState({ needsKey: true, hasKey: true }).label).toBe('Key stored')
    expect(providerKeyState({ needsKey: true, hasKey: false })).toEqual({
      label: 'Needs a key',
      tone: 'attention'
    })
    expect(providerKeyState({ needsKey: false, hasKey: false })).toEqual({
      label: 'No key needed',
      tone: 'quiet'
    })
  })

  it('serves no harness through an endpoint no harness speaks', () => {
    expect(harnessesForEndpoints([])).toEqual([])
    expect(harnessesForEndpoints(null)).toEqual(['pi', 'opencode'])
  })
})

describe('the providers that can be connected', () => {
  it('lists Anthropic and OpenAI first on this Mac, then the ten providers', () => {
    const offers = offerFacts({ subscriptions: true })
    expect(offers.map((o) => o.company)).toEqual([
      'anthropic',
      'openai',
      'moonshot',
      'zai',
      'mistral',
      'deepseek',
      'minimax',
      'alibaba',
      'openrouter',
      'vercel-ai-gateway',
      'ollama',
      'generic'
    ])
    expect(offers[0]).toMatchObject({ road: 'sign-in', harnesses: ['claude'] })
    expect(offers[1]).toMatchObject({ road: 'sign-in', harnesses: ['codex'] })
    expect(offers.find((o) => o.company === 'generic')).toMatchObject({
      road: 'form',
      harnesses: ['pi', 'opencode']
    })
  })

  it('lists the ten providers alone on a server, whose subscriptions sign in there', () => {
    const offers = offerFacts({ subscriptions: false })
    expect(offers).toHaveLength(10)
    expect(offers.every((o) => o.road === 'form')).toBe(true)
  })

  it('offers another connection of a provider already connected', () => {
    expect(connectLabel(0)).toBe('Connect')
    expect(connectLabel(2)).toBe('Connect another')
    expect(connectedCountText(0)).toBeNull()
    expect(connectedCountText(1)).toBe('1 connected')
    expect(connectedCountText(3)).toBe('3 connected')
  })
})

describe('the models a card names', () => {
  it('shows the first few and folds the rest behind one control', () => {
    expect(modelPreview(['a', 'b', 'c', 'd', 'e', 'f'])).toEqual({
      first: ['a', 'b', 'c'],
      rest: ['d', 'e', 'f']
    })
    expect(moreLabel(3, false)).toBe('3 more')
    expect(moreLabel(3, true)).toBe('Fewer')
  })

  it('never folds a single model away', () => {
    expect(modelPreview(['a', 'b', 'c', 'd'])).toEqual({ first: ['a', 'b', 'c', 'd'], rest: [] })
    expect(modelPreview([])).toEqual({ first: [], rest: [] })
  })
})

describe('removing asks first', () => {
  it('names what goes and what keeps running, for each kind', () => {
    const mac = machineWords(null)
    expect(mac).toBe('this Mac')
    expect(removalSentence('claude', 'Work', mac)).toEqual({
      question: 'Remove Work?',
      consequence:
        'Its token is deleted from this Mac. Tabs running on it keep going until they are restarted, then they need another connection.'
    })
    expect(removalSentence('codex-chatgpt', 'Team', mac).consequence).toMatch(
      /^Its sign-in is deleted from this Mac\. Tabs running on it keep going/
    )
    expect(removalSentence('codex-key', 'Billing', mac).consequence).toMatch(
      /^Its key is deleted from this Mac\./
    )
    expect(
      removalSentence('provider-key', 'Kimi', machineWords('Studio')).consequence
    ).toMatch(/^Its key is deleted from Studio\./)
    expect(removalSentence('provider-local', 'Local', mac).consequence).toMatch(
      /^Its address is forgotten on this Mac\./
    )
  })
})
