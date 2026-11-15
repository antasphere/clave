import { describe, expect, it } from 'vitest'
import { parsePiOwnDefault, piStartModel } from './pi-start-model'

/**
 * The one rule of a Pi tab on a stored connection that names no model
 * (PRDCT-4496): the person's own Pi default when it belongs to the
 * connection's provider, else the first model listed for the connection,
 * else one plain refusal.
 */
describe('piStartModel', () => {
  const listed = ['k-first', 'k-second']

  it("takes the person's own default when it is the connection's provider's", () => {
    expect(
      piStartModel({
        provider: 'kimi-coding',
        ownDefault: { provider: 'kimi-coding', model: 'k-second' },
        listed,
        label: 'Kimi'
      })
    ).toEqual({ ok: true, model: 'k-second', from: 'own-default' })
  })

  it('takes it even when the launcher lists no model for the connection', () => {
    expect(
      piStartModel({
        provider: 'clave-ollama',
        ownDefault: { provider: 'clave-ollama', model: 'llama-made-up' },
        listed: [],
        label: 'Ollama'
      })
    ).toEqual({ ok: true, model: 'llama-made-up', from: 'own-default' })
  })

  it("else the first model listed: a default on another provider, or one naming no provider, is not the connection's", () => {
    for (const ownDefault of [
      { provider: 'anthropic', model: 'made-up-claude' },
      { model: 'k-second' },
      null
    ])
      expect(piStartModel({ provider: 'kimi-coding', ownDefault, listed, label: 'Kimi' })).toEqual({
        ok: true,
        model: 'k-first',
        from: 'first-listed'
      })
  })

  it('refuses in one plain sentence a connection with no model listed and no default of its own', () => {
    const out = piStartModel({
      provider: 'clave-ollama',
      ownDefault: { provider: 'kimi-coding', model: 'k-second' },
      listed: [],
      label: 'Local Ollama'
    })
    expect(out).toEqual({
      ok: false,
      reason: 'No model is listed for the connection "Local Ollama": name one to open Pi on it.'
    })
  })
})

describe('parsePiOwnDefault', () => {
  it('reads defaultProvider and defaultModel, nothing else', () => {
    expect(
      parsePiOwnDefault(
        JSON.stringify({
          defaultProvider: 'kimi-coding',
          defaultModel: 'k-second',
          theme: 'dark',
          apiKey: 'never-read'
        })
      )
    ).toEqual({ provider: 'kimi-coding', model: 'k-second' })
  })

  it('is null for no default model, a file that is not an object, or text that is not JSON', () => {
    for (const text of ['{}', '{"defaultProvider":"x"}', '[]', 'null', 'not json', ''])
      expect(parsePiOwnDefault(text)).toBeNull()
  })

  it('keeps a default model with no provider, which then belongs to no connection', () => {
    expect(parsePiOwnDefault('{"defaultModel":"m"}')).toEqual({ model: 'm' })
  })
})
