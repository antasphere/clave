import { describe, expect, it } from 'vitest'
import { DIGEST_HELPER_MARKER, digestPrompt, parseDigestReply } from './exchange-digest'

describe('digestPrompt', () => {
  it('opens with the marker the session history skips, and numbers each message with its context', () => {
    const prompt = digestPrompt([
      { from: 'Verifier', text: 'report', request: 'please verify', reply: 'thanks' },
      { from: 'Deploy bot', text: 'green' }
    ])
    expect(prompt.startsWith(DIGEST_HELPER_MARKER)).toBe(true)
    expect(prompt).toContain('### Message 1, from "Verifier"')
    expect(prompt).toContain('(This session had asked them:)\nplease verify')
    expect(prompt).toContain('(This session answered them:)\nthanks')
    expect(prompt).toContain('### Message 2, from "Deploy bot"')
  })
})

describe('parseDigestReply', () => {
  it('reads the JSON line, the message number made 0-based', () => {
    expect(
      parseDigestReply('{"needs_you": true, "message": 2, "summary": "Decide on rotation."}', 3)
    ).toEqual({ ok: true, needsYou: true, summary: 'Decide on rotation.', message: 1 })
  })

  it('tolerates a fence or words around the object', () => {
    const reply =
      'Here:\n```json\n{"needs_you": false, "message": null, "summary": "Nothing for you."}\n```'
    expect(parseDigestReply(reply, 2)).toEqual({
      ok: true,
      needsYou: false,
      summary: 'Nothing for you.',
      message: null
    })
  })

  it('drops a message number outside the timeline', () => {
    expect(parseDigestReply('{"needs_you": true, "message": 9, "summary": "x"}', 2)?.message).toBe(
      null
    )
  })

  it('refuses a reply that is not the asked shape', () => {
    expect(parseDigestReply('no json here', 1)).toBeNull()
    expect(parseDigestReply('{"needs_you": "yes", "summary": "x"}', 1)).toBeNull()
    expect(parseDigestReply('{"needs_you": true, "summary": "  "}', 1)).toBeNull()
    expect(parseDigestReply('{broken', 1)).toBeNull()
  })
})
