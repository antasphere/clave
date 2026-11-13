import { describe, expect, it } from 'vitest'
import type { ElevenLabsStatus } from '../../../../src/shared/elevenlabs'
import type { Reading } from './read-aloud'
import { macVoiceLine, stepSeconds, voiceCardState, voiceSource } from './voice-card'

const status = (over: Partial<ElevenLabsStatus>): ElevenLabsStatus => ({
  configured: true,
  setAt: 1,
  voiceId: 'v',
  voiceName: 'Ada',
  modelId: 'eleven_flash_v2_5',
  checkedAt: 1,
  tier: null,
  charactersUsed: null,
  charactersLimit: null,
  lastError: null,
  ...over
})

const reading = (over: Partial<Reading>): Reading =>
  ({ state: 'preparing', phase: 'preparing', step: 'rewriting', ...over }) as Reading

describe('the voice card', () => {
  it('names its state from the reading, in the order a reading goes', () => {
    expect(voiceCardState(null)).toBe('idle')
    expect(voiceCardState(reading({}))).toBe('rewriting')
    expect(voiceCardState(reading({ step: 'creating' }))).toBe('creating')
    expect(voiceCardState(reading({ state: 'playing', phase: 'speaking', step: null }))).toBe(
      'playing'
    )
    expect(voiceCardState(reading({ state: 'paused', phase: 'speaking', step: null }))).toBe(
      'paused'
    )
  })

  it("says this Mac's voice from its status, before a click", () => {
    expect(voiceSource(true, status({}), null)).toEqual({
      name: 'Ada · ElevenLabs on this Mac',
      voiceName: 'Ada'
    })
    expect(voiceSource(true, status({ configured: false }), null)).toEqual({
      name: "The Mac's voice",
      why: 'No ElevenLabs on this server'
    })
    expect(voiceSource(true, status({ voiceId: null }), null)).toEqual({
      name: "The Mac's voice",
      why: 'No voice chosen on this server'
    })
    // Not read yet: nothing said rather than a guess.
    expect(voiceSource(true, undefined, null)).toBeNull()
  })

  it("says a server's voice from what its last reading heard, else that it may have one", () => {
    expect(voiceSource(false, undefined, null)).toEqual({
      name: "The server's voice, if it has one"
    })
    expect(voiceSource(false, undefined, { voice: 'elevenlabs' })).toEqual({
      name: 'ElevenLabs on the server'
    })
    expect(
      voiceSource(false, undefined, {
        voice: 'system',
        why: { kind: 'unset', words: 'this server needs an update' }
      })
    ).toEqual({ name: "The Mac's voice", why: 'This server needs an update' })
  })

  it("says the Mac's voice with its reason, and the seconds of a step", () => {
    expect(macVoiceLine('the ElevenLabs credits are spent')).toBe(
      "Reading with the Mac's voice: the ElevenLabs credits are spent"
    )
    expect(stepSeconds(1_000, 4_900)).toBe('3s')
    expect(stepSeconds(5_000, 4_000)).toBe('0s')
  })
})
