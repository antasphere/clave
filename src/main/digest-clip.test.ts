import { describe, expect, it } from 'vitest'
import {
  DIGEST_MAX_FROM as WIRE_FROM,
  DIGEST_MAX_MESSAGES as WIRE_MESSAGES,
  DIGEST_MAX_NOTE as WIRE_NOTE,
  DIGEST_MAX_NOTES as WIRE_NOTES,
  DIGEST_MAX_SPOKEN as WIRE_SPOKEN,
  DIGEST_MAX_TEXT as WIRE_TEXT,
  DIGEST_MAX_TITLE_MESSAGE as WIRE_TITLE_MESSAGE
} from '@clave/contract/digests'
import {
  DIGEST_MAX_CHARS,
  DIGEST_MAX_FROM,
  DIGEST_MAX_MESSAGES,
  clipDigestMessages,
  digestKey
} from '../shared/exchange-digest'
import { MAX_NOTES, MAX_NOTE_CHARS, clipNotes, workDigestKey } from '../shared/work-digest'
import { clipText } from '../shared/helper-prompt'
import { SPOKEN_MAX_CHARS } from '../shared/spoken-rendering'
import { PAGE_TITLE_MESSAGE_CHARS } from '../shared/page-title'

/**
 * The one clip of what a digest reads (PRDCT-4327): the view applies it
 * before it keys and sends a timeline, the host again to what it receives.
 * It must be idempotent (or the two keys differ and the host refuses), and
 * the wire's bounds must take whatever it produces.
 */
describe('the digest clip', () => {
  const long = 'x'.repeat(300_000)
  const timeline = Array.from({ length: 45 }, (_, i) => ({
    from: `Tab ${i}`,
    text: i === 44 ? long : `message ${i}`,
    ...(i === 44 && { request: long, reply: long })
  }))

  it('keeps the latest messages, each text clipped, and says how many were left out', () => {
    const { messages, offset } = clipDigestMessages(timeline)
    expect(messages).toHaveLength(DIGEST_MAX_MESSAGES)
    expect(offset).toBe(45 - DIGEST_MAX_MESSAGES)
    expect(messages[0].text).toBe('message 15')
    const last = messages[messages.length - 1]
    expect(last.text).toBe(`${'x'.repeat(DIGEST_MAX_CHARS)}…`)
    expect(last.request).toBe(last.text)
    expect(last.reply).toBe(last.text)
  })

  it('is idempotent: the host clipping what the view clipped finds the view’s key', () => {
    const once = clipDigestMessages(timeline).messages
    const twice = clipDigestMessages(once)
    expect(twice).toEqual({ messages: once, offset: 0 })
    expect(digestKey(twice.messages)).toBe(digestKey(once))
    const notes = Array.from({ length: 50 }, (_, i) => (i === 49 ? long : `note ${i}`))
    const clipped = clipNotes(notes).notes
    expect(clipNotes(clipped)).toEqual({ notes: clipped, offset: 0 })
    expect(workDigestKey(clipNotes(clipped).notes)).toBe(workDigestKey(clipped))
  })

  it('produces nothing the wire refuses', () => {
    expect(WIRE_MESSAGES).toBeGreaterThanOrEqual(DIGEST_MAX_MESSAGES)
    expect(WIRE_TEXT).toBeGreaterThanOrEqual(DIGEST_MAX_CHARS + 1)
    expect(WIRE_FROM).toBeGreaterThanOrEqual(DIGEST_MAX_FROM + 1)
    expect(WIRE_NOTES).toBeGreaterThanOrEqual(MAX_NOTES)
    expect(WIRE_NOTE).toBeGreaterThanOrEqual(MAX_NOTE_CHARS + 1)
    // Folio's reads: an answer and a message, each clipped with `clipText`.
    expect(WIRE_SPOKEN).toBeGreaterThanOrEqual(
      clipText('a'.repeat(SPOKEN_MAX_CHARS * 2), SPOKEN_MAX_CHARS).length
    )
    expect(WIRE_TITLE_MESSAGE).toBeGreaterThanOrEqual(
      clipText('a'.repeat(PAGE_TITLE_MESSAGE_CHARS * 2), PAGE_TITLE_MESSAGE_CHARS).length
    )
  })
})
