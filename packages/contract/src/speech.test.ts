import { describe, expect, it } from 'vitest'
import { Schema } from 'effect'
import { PreviewVoice, SPEECH_MAX_TEXT, SpeakResult, SpeakText } from './speech'

/** The speech contract (PRDCT-4411): what a client may send, what it gets. */
describe('the speech contract', () => {
  const payload = Schema.decodeUnknownEither(SpeakText.payload)
  const result = Schema.decodeUnknownSync(SpeakResult)

  it('takes a text up to its bound, a voice id and a model it knows', () => {
    expect(payload({ sessionId: 's', text: 'a'.repeat(SPEECH_MAX_TEXT) })._tag).toBe('Right')
    expect(
      payload({ sessionId: 's', text: 'a', voiceId: 'Voice_1-a', modelId: 'eleven_flash_v2_5' })
        ._tag
    ).toBe('Right')
    expect(payload({ sessionId: 's', text: 'a'.repeat(SPEECH_MAX_TEXT + 1) })._tag).toBe('Left')
    expect(payload({ sessionId: 's', text: '' })._tag).toBe('Left')
    expect(payload({ sessionId: 's', text: 'a', voiceId: 'a/b' })._tag).toBe('Left')
    expect(payload({ sessionId: 's', text: 'a', modelId: 'other' })._tag).toBe('Left')
    expect(Schema.decodeUnknownEither(PreviewVoice.payload)({ voiceId: '' })._tag).toBe('Left')
  })

  it('answers audio, or a reason; a reason it does not know reads as absent', () => {
    expect(result({ ok: true, mime: 'audio/mpeg', audio: 'AA', characters: 2 })).toEqual({
      ok: true,
      mime: 'audio/mpeg',
      audio: 'AA',
      characters: 2
    })
    expect(result({ ok: false, error: 'spent', reason: 'quota' })).toEqual({
      ok: false,
      error: 'spent',
      reason: 'quota'
    })
    expect(result({ ok: false, error: 'new', reason: 'a-newer-reason' })).toEqual({
      ok: false,
      error: 'new'
    })
    expect(() => result({ ok: true, mime: 'audio/wav', audio: 'AA', characters: 2 })).toThrow()
  })
})
