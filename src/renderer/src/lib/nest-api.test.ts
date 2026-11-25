import { afterEach, describe, expect, it, vi } from 'vitest'
import { NestRefused, nestRefusalMessage } from '../../../shared/nest-tools'
import { nestApi, nestErrorOf } from './nest-api'

/** The renderer's one door to the server's nesting (PRDCT-4997): what the
 *  context bridge delivers is a message and nothing else, and this door is
 *  where a marked message becomes a refusal again. If it stops doing so,
 *  every refusal reads as a call that was never answered: the row says the
 *  server could not be asked and an undo asks again at every press. */
const globals = globalThis as unknown as { window?: { electronAPI?: Record<string, unknown> } }
afterEach(() => {
  delete globals.window
})

describe('what crossed the bridge, as this realm throws it', () => {
  it('a marked message is a refusal carrying the server’s sentence, unmarked', () => {
    const sentence = 'This tab works on the lane "Mirror http://x", whose entry shows it'
    const refusal = nestErrorOf(new Error(nestRefusalMessage(sentence)))
    expect(refusal).toBeInstanceOf(NestRefused)
    expect(refusal.message).toBe(sentence)
  })

  it('anything else is a plain Error with the words that came, never a refusal', () => {
    for (const words of ['fetch failed', "Clave's server did not answer. Try again in a moment."]) {
      const failure = nestErrorOf(new Error(words))
      expect(failure).not.toBeInstanceOf(NestRefused)
      expect(failure.message).toBe(words)
    }
  })

  it('reads a value that is not an Error of this realm', () => {
    expect(nestErrorOf(nestRefusalMessage('That tab is gone'))).toBeInstanceOf(NestRefused)
    expect(nestErrorOf({ unexpected: true })).not.toBeInstanceOf(NestRefused)
  })
})

describe('nesting through the bridge', () => {
  it('asks the bridge and answers nothing when the server accepts', async () => {
    const sessionsNest = vi.fn(async () => ({ id: 'a', under: 'b', changed: true }))
    globals.window = { electronAPI: { sessionsNest } }
    await expect(nestApi.nest('a', 'b')).resolves.toBeUndefined()
    expect(sessionsNest).toHaveBeenCalledExactlyOnceWith('a', 'b')
  })

  it('throws the server’s no as a refusal, and a call never answered as a plain Error', async () => {
    const sessionsNest = vi.fn()
    globals.window = { electronAPI: { sessionsNest } }
    sessionsNest.mockRejectedValueOnce(
      new Error(nestRefusalMessage('A tab cannot be nested under itself'))
    )
    const refused = await nestApi.nest('a', 'a').catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(NestRefused)
    expect((refused as Error).message).toBe('A tab cannot be nested under itself')
    sessionsNest.mockRejectedValueOnce(new Error('fetch failed'))
    const silent = await nestApi.nest('a', 'b').catch((e: unknown) => e)
    expect(silent).not.toBeInstanceOf(NestRefused)
    expect((silent as Error).message).toBe('fetch failed')
  })

  it('says so when the window’s bridge has no nesting', async () => {
    globals.window = { electronAPI: {} }
    await expect(nestApi.nest('a', 'b')).rejects.toThrow('its bridge has no nesting')
  })
})
