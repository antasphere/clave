import { describe, expect, it } from 'vitest'
import {
  WORK_DIGEST_MARKER,
  parseWorkDigestReply,
  workDigestKey,
  workDigestPrompt
} from './work-digest'

describe('workDigestPrompt', () => {
  it('opens with the marker the session history skips, and numbers the notes', () => {
    const prompt = workDigestPrompt(['Formatting the first fix.', 'Typecheck: web is clean.'], 7)
    expect(prompt.startsWith(WORK_DIGEST_MARKER)).toBe(true)
    expect(prompt).toContain('these 2 short notes')
    expect(prompt).toContain('between 7 tool calls')
    expect(prompt).toContain('1. Formatting the first fix.')
    expect(prompt).toContain('2. Typecheck: web is clean.')
  })
})

describe('workDigestKey', () => {
  it('is the same for the same notes and differs on a changed word', () => {
    const a = workDigestKey(['one', 'two'])
    expect(workDigestKey(['one', 'two'])).toBe(a)
    expect(workDigestKey(['one', 'three'])).not.toBe(a)
    expect(a.startsWith('work-2-')).toBe(true)
  })
})

describe('parseWorkDigestReply', () => {
  it('reads the JSON line, the note number made 0-based, the title without its stop', () => {
    expect(
      parseWorkDigestReply(
        '{"title": "Fixed the attachment check.", "needs_you": true, "note": 2}',
        3
      )
    ).toEqual({ ok: true, title: 'Fixed the attachment check', needsYou: true, note: 1 })
  })

  it('tolerates a fence or words around the object', () => {
    const reply =
      'Here:\n```json\n{"title": "Traced the schema", "needs_you": false, "note": null}\n```'
    expect(parseWorkDigestReply(reply, 2)).toEqual({
      ok: true,
      title: 'Traced the schema',
      needsYou: false,
      note: null
    })
  })

  it('drops a note number outside the stretch, and with it the flag', () => {
    expect(parseWorkDigestReply('{"title": "x", "needs_you": true, "note": 9}', 2)).toEqual({
      ok: true,
      title: 'x',
      needsYou: false,
      note: null
    })
  })

  it('never raises a flag it cannot point at', () => {
    expect(
      parseWorkDigestReply('{"title": "x", "needs_you": true, "note": null}', 2)?.needsYou
    ).toBe(false)
  })

  it('refuses a reply that is not the asked shape', () => {
    expect(parseWorkDigestReply('no json here', 1)).toBeNull()
    expect(parseWorkDigestReply('{"title": 3, "needs_you": true}', 1)).toBeNull()
    expect(parseWorkDigestReply('{"title": " . ", "needs_you": false}', 1)).toBeNull()
    expect(parseWorkDigestReply('{broken', 1)).toBeNull()
  })
})
