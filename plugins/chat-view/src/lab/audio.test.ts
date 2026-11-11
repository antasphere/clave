import { describe, expect, it } from 'vitest'
import type { SpeakResult } from '../../../../src/shared/speech'
import { AudioQueue, speechParts, type AudioLike } from './audio'

/* Folio's ElevenLabs voice (PRDCT-4411): the cut into parts, and the queue
   that plays them in order through one element, asking the next while one
   plays, and dropping everything on stop. The element is a fake that plays
   when told and ends when the test says. */

describe('speechParts', () => {
  it('keeps a short rendering whole', () => {
    expect(speechParts('One. Two.')).toEqual(['One. Two.'])
  })

  it('cuts at sentence ends, every part within the bound, nothing lost', () => {
    const sentence = 'This sentence is about forty characters. '
    const text = sentence.repeat(200).trim()
    const parts = speechParts(text, 2_400)
    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(2_400)
      expect(part.endsWith('.')).toBe(true)
    }
    expect(parts.join(' ')).toBe(text)
  })

  it('cuts a sentence longer than the bound at a clause, then at a word', () => {
    const clauses = Array.from({ length: 30 }, (_, i) => `clause number ${i}`).join(', ') + '.'
    const parts = speechParts(clauses, 100)
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(100)
    expect(parts.join(' ').replace(/\s+/g, ' ')).toBe(clauses)
    const words = speechParts('word '.repeat(100).trim(), 50)
    for (const part of words) expect(part.length).toBeLessThanOrEqual(50)
  })
})

class FakeAudio implements AudioLike {
  src = ''
  played: string[] = []
  paused = 0
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  refuse = false
  play(): Promise<void> {
    if (this.refuse) return Promise.reject(new Error('NotAllowedError'))
    this.played.push(this.src)
    return Promise.resolve()
  }
  pause(): void {
    this.paused += 1
  }
  end(): void {
    this.onended?.()
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function harness(): {
  audio: FakeAudio
  revoked: string[]
  queue: AudioQueue
  asked: string[]
  source: (part: string) => Promise<SpeakResult>
  answer: (part: string, result?: SpeakResult) => void
  events: string[]
} {
  const audio = new FakeAudio()
  const revoked: string[] = []
  let made = 0
  const queue = new AudioQueue({
    createAudio: () => audio,
    toUrl: (answer) => `blob:${answer.audio}#${++made}`,
    revoke: (url) => revoked.push(url)
  })
  const asked: string[] = []
  const pending = new Map<string, (answer: SpeakResult) => void>()
  const source = (part: string): Promise<SpeakResult> => {
    asked.push(part)
    return new Promise((resolve) => pending.set(part, resolve))
  }
  const answer = (part: string, result?: SpeakResult): void =>
    pending.get(part)!(
      result ?? { ok: true, mime: 'audio/mpeg', audio: part, characters: part.length }
    )
  const events: string[] = []
  return { audio, revoked, queue, asked, source, answer, events }
}

describe('AudioQueue', () => {
  it('plays the parts in order, asking the next while one plays', async () => {
    const h = harness()
    h.queue.play({
      parts: ['a', 'b', 'c'],
      source: h.source,
      onProgress: (at, of) => h.events.push(`at ${at}/${of}`),
      onEnd: () => h.events.push('end')
    })
    expect(h.asked).toEqual(['a'])
    h.answer('a')
    await tick()
    expect(h.audio.played).toEqual(['blob:a#1'])
    // Part 2 is asked as part 1 starts, not after it ends.
    expect(h.asked).toEqual(['a', 'b'])
    expect(h.events).toEqual(['at 0/3'])
    h.answer('b')
    await tick()
    expect(h.audio.played).toEqual(['blob:a#1'])
    h.audio.end()
    await tick()
    expect(h.audio.played).toEqual(['blob:a#1', 'blob:b#2'])
    expect(h.revoked).toEqual(['blob:a#1'])
    expect(h.asked).toEqual(['a', 'b', 'c'])
    h.audio.end()
    await tick()
    // Part 3 not back yet: nothing plays until it is.
    expect(h.audio.played).toHaveLength(2)
    h.answer('c')
    await tick()
    h.audio.end()
    await tick()
    expect(h.audio.played).toEqual(['blob:a#1', 'blob:b#2', 'blob:c#3'])
    expect(h.revoked).toEqual(['blob:a#1', 'blob:b#2', 'blob:c#3'])
    expect(h.events).toEqual(['at 0/3', 'at 1/3', 'at 2/3', 'end'])
    expect(h.queue.playing).toBe(false)
  })

  it('takes the first answer the caller already asked for', async () => {
    const h = harness()
    h.queue.play({
      parts: ['a', 'b'],
      source: h.source,
      first: Promise.resolve({ ok: true, mime: 'audio/mpeg', audio: 'first', characters: 1 })
    })
    await tick()
    expect(h.audio.played).toEqual(['blob:first#1'])
    expect(h.asked).toEqual(['b'])
  })

  it('stop pauses, revokes, and drops the answers still to come', async () => {
    const h = harness()
    h.queue.play({
      parts: ['a', 'b'],
      source: h.source,
      onEnd: () => h.events.push('end'),
      onError: () => h.events.push('error')
    })
    h.answer('a')
    await tick()
    h.queue.stop()
    expect(h.audio.paused).toBe(1)
    expect(h.revoked).toEqual(['blob:a#1'])
    expect(h.audio.onended).toBeNull()
    h.answer('b')
    await tick()
    expect(h.audio.played).toEqual(['blob:a#1'])
    expect(h.events).toEqual([])
    expect(h.queue.playing).toBe(false)
  })

  it('a stop while the first part is asked plays nothing when it comes', async () => {
    const h = harness()
    h.queue.play({ parts: ['a'], source: h.source })
    h.queue.stop()
    h.answer('a')
    await tick()
    expect(h.audio.played).toEqual([])
  })

  it('a later part that fails stops the play and says which and why', async () => {
    const h = harness()
    const failures: unknown[] = []
    h.queue.play({
      parts: ['a', 'b'],
      source: h.source,
      onEnd: () => h.events.push('end'),
      onError: (at, failure) => failures.push({ at, ...failure })
    })
    h.answer('a')
    await tick()
    h.answer('b', { ok: false, error: 'The ElevenLabs credits are spent.', reason: 'quota' })
    h.audio.end()
    await tick()
    expect(failures).toEqual([
      { at: 1, error: 'The ElevenLabs credits are spent.', reason: 'quota' }
    ])
    expect(h.audio.played).toEqual(['blob:a#1'])
    expect(h.events).toEqual([])
  })

  it('an element that refuses to play is a failure of that part', async () => {
    const h = harness()
    h.audio.refuse = true
    const failures: unknown[] = []
    h.queue.play({
      parts: ['a'],
      source: h.source,
      onError: (at, failure) => failures.push({ at, reason: failure.reason })
    })
    h.answer('a')
    await tick()
    await tick()
    expect(failures).toEqual([{ at: 0, reason: 'failed' }])
    expect(h.revoked).toEqual(['blob:a#1'])
  })

  it('a new play replaces the one going', async () => {
    const h = harness()
    const ends: string[] = []
    h.queue.play({ parts: ['a'], source: h.source, onEnd: () => ends.push('first') })
    h.answer('a')
    await tick()
    h.queue.play({ parts: ['x'], source: h.source, onEnd: () => ends.push('second') })
    h.answer('x')
    await tick()
    h.audio.end()
    await tick()
    expect(ends).toEqual(['second'])
    expect(h.audio.played).toEqual(['blob:a#1', 'blob:x#2'])
  })
})
