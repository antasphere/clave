import { describe, expect, it } from 'vitest'
import type { SpeakResult } from '../../../../src/shared/speech'
import {
  AudioQueue,
  PART_CACHE_MAX,
  PartCache,
  blockParts,
  mp3Ms,
  partKey,
  type AudioLike,
  type SpeechPart
} from './audio'

/** Parts of one block each, numbered 1, 2, …: what most pages are. */
const parts = (...texts: string[]): SpeechPart[] => texts.map((text, i) => ({ block: i + 1, text }))
const speechParts = (text: string, max?: number): string[] =>
  blockParts([{ n: 1, text }], max).map((part) => part.text)

/* Folio's ElevenLabs voice (PRDCT-4411): the cut into parts, and the queue
   that plays them in order through one element, asking the next while one
   plays, and dropping everything on stop. The element is a fake that plays
   when told and ends when the test says. */

describe('blockParts (PRDCT-4430)', () => {
  it('makes one part per block, never one across two', () => {
    expect(
      blockParts([
        { n: 1, text: 'One.' },
        { n: 2, text: 'Two. Still two.' },
        { n: 3, text: '  ' },
        { n: 4, text: 'Four.' }
      ])
    ).toEqual([
      { block: 1, text: 'One.' },
      { block: 2, text: 'Two. Still two.' },
      { block: 4, text: 'Four.' }
    ])
  })

  it('cuts a long block at sentence ends into parts of the same block', () => {
    const long = 'This sentence is about forty characters. '.repeat(10).trim()
    const cut = blockParts(
      [
        { n: 1, text: 'Short.' },
        { n: 2, text: long }
      ],
      100
    )
    expect(cut[0]).toEqual({ block: 1, text: 'Short.' })
    expect(cut.length).toBeGreaterThan(3)
    for (const part of cut.slice(1)) {
      expect(part.block).toBe(2)
      expect(part.text.length).toBeLessThanOrEqual(100)
      expect(part.text.endsWith('.')).toBe(true)
    }
    expect(
      cut
        .slice(1)
        .map((p) => p.text)
        .join(' ')
    ).toBe(long)
  })

  it('reads a rendering without blocks as one block', () => {
    expect(blockParts([{ n: 0, text: 'The whole page.' }])).toEqual([
      { block: 0, text: 'The whole page.' }
    ])
  })
})

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
  currentTime = 0
  duration = NaN
  played: string[] = []
  paused = 0
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  ontimeupdate: (() => void) | null = null
  ondurationchange: (() => void) | null = null
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
    revoke: (url) => revoked.push(url),
    lengthOf: () => null
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
      parts: parts('a', 'b', 'c'),
      source: h.source,
      onProgress: (at, of, block) => h.events.push(`at ${at}/${of} block ${block}`),
      onEnd: () => h.events.push('end')
    })
    expect(h.asked).toEqual(['a'])
    h.answer('a')
    await tick()
    expect(h.audio.played).toEqual(['blob:a#1'])
    // Part 2 is asked as part 1 starts, not after it ends.
    expect(h.asked).toEqual(['a', 'b'])
    expect(h.events).toEqual(['at 0/3 block 1'])
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
    expect(h.events).toEqual(['at 0/3 block 1', 'at 1/3 block 2', 'at 2/3 block 3', 'end'])
    expect(h.queue.playing).toBe(false)
  })

  it('takes the first answer the caller already asked for', async () => {
    const h = harness()
    h.queue.play({
      parts: parts('a', 'b'),
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
      parts: parts('a', 'b'),
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
    h.queue.play({ parts: parts('a'), source: h.source })
    h.queue.stop()
    h.answer('a')
    await tick()
    expect(h.audio.played).toEqual([])
  })

  it('a later part that fails stops the play and says which and why', async () => {
    const h = harness()
    const failures: unknown[] = []
    h.queue.play({
      parts: parts('a', 'b'),
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
      parts: parts('a'),
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
    h.queue.play({ parts: parts('a'), source: h.source, onEnd: () => ends.push('first') })
    h.answer('a')
    await tick()
    h.queue.play({ parts: parts('x'), source: h.source, onEnd: () => ends.push('second') })
    h.answer('x')
    await tick()
    h.audio.end()
    await tick()
    expect(ends).toEqual(['second'])
    expect(h.audio.played).toEqual(['blob:a#1', 'blob:x#2'])
  })
})

describe('AudioQueue: pause, resume, seek and time (PRDCT-4430)', () => {
  it('pause keeps the part; resume plays the same part on, asking nothing new', async () => {
    const h = harness()
    h.queue.play({ parts: parts('a', 'b'), source: h.source })
    h.answer('a')
    await tick()
    expect(h.queue.state).toBe('playing')
    h.queue.pause()
    expect(h.queue.state).toBe('paused')
    expect(h.audio.paused).toBe(1)
    expect(h.revoked).toEqual([])
    h.queue.resume()
    expect(h.queue.state).toBe('playing')
    expect(h.audio.played).toEqual(['blob:a#1', 'blob:a#1'])
    expect(h.asked).toEqual(['a', 'b'])
    expect(h.queue.at).toBe(0)
  })

  it('a pause while the part is asked waits, loaded, for the resume', async () => {
    const h = harness()
    h.queue.play({ parts: parts('a'), source: h.source })
    h.queue.pause()
    h.answer('a')
    await tick()
    expect(h.audio.src).toBe('blob:a#1')
    expect(h.audio.played).toEqual([])
    h.queue.resume()
    expect(h.audio.played).toEqual(['blob:a#1'])
  })

  it('seek stops the part in play and starts the asked one, prefetch going on from there', async () => {
    const h = harness()
    const events: string[] = []
    h.queue.play({
      parts: parts('a', 'b', 'c', 'd'),
      source: h.source,
      onProgress: (at, _of, block) => events.push(`${at}:${block}`)
    })
    h.answer('a')
    await tick()
    h.queue.seek(2)
    expect(h.audio.paused).toBe(1)
    expect(h.revoked).toEqual(['blob:a#1'])
    expect(h.asked).toEqual(['a', 'b', 'c'])
    h.answer('c')
    await tick()
    expect(h.audio.played).toEqual(['blob:a#1', 'blob:c#2'])
    expect(h.asked).toEqual(['a', 'b', 'c', 'd'])
    expect(events).toEqual(['0:1', '2:3'])
    // Back to a part already had: played from its answer, not asked again.
    h.queue.seek(1)
    h.answer('b')
    await tick()
    expect(h.audio.played.at(-1)).toBe('blob:b#3')
    expect(h.asked.filter((x) => x === 'b')).toHaveLength(1)
  })

  it('a late answer of a part sought away from plays nothing', async () => {
    const h = harness()
    h.queue.play({ parts: parts('a', 'b', 'c'), source: h.source })
    h.queue.seek(2)
    h.answer('a')
    await tick()
    expect(h.audio.played).toEqual([])
    h.answer('c')
    await tick()
    expect(h.audio.played).toEqual(['blob:c#1'])
    // The old part's ended, fired late, moves nothing.
    expect(h.queue.at).toBe(2)
  })

  it('a seek while paused plays again from the asked part', async () => {
    const h = harness()
    h.queue.play({ parts: parts('a', 'b'), source: h.source })
    h.answer('a')
    await tick()
    h.queue.pause()
    h.queue.seek(1)
    h.answer('b')
    await tick()
    expect(h.queue.state).toBe('playing')
    expect(h.audio.played).toEqual(['blob:a#1', 'blob:b#2'])
  })

  it('seek and pause after a stop do nothing', async () => {
    const h = harness()
    h.queue.play({ parts: parts('a', 'b'), source: h.source })
    h.queue.stop()
    h.queue.seek(1)
    h.queue.pause()
    expect(h.asked).toEqual(['a'])
    expect(h.queue.state).toBe('idle')
  })

  it('reports the time read, and the whole length once every part’s is known', async () => {
    const audio = new FakeAudio()
    const times: [number, number | null, number][] = []
    const lengths: Record<string, number> = { a: 2000, b: 3000 }
    const queue = new AudioQueue({
      createAudio: () => audio,
      toUrl: (answer) => `blob:${answer.audio}`,
      revoke: () => undefined,
      lengthOf: (answer) => lengths[answer.audio] ?? null
    })
    const pending = new Map<string, (r: SpeakResult) => void>()
    const ok = (part: string): SpeakResult => ({
      ok: true,
      mime: 'audio/mpeg',
      audio: part,
      characters: 1
    })
    queue.play({
      parts: parts('a', 'b', 'c'),
      source: (part) => new Promise((resolve) => pending.set(part, resolve)),
      onTime: (elapsed, total, fraction) => times.push([elapsed, total, fraction])
    })
    pending.get('a')!(ok('a'))
    await tick()
    audio.currentTime = 1
    audio.ontimeupdate?.()
    // Part c's length is not known yet: no total.
    expect(times.at(-1)).toEqual([1000, null, 0.5])
    pending.get('b')!(ok('b'))
    audio.end()
    await tick()
    // c is asked as b plays; its answer has no estimate: still no total
    // until its element says.
    pending.get('c')!(ok('c'))
    audio.end()
    await tick()
    expect(times.at(-1)?.[1]).toBeNull()
    audio.currentTime = 0.5
    audio.duration = 4
    audio.ondurationchange?.()
    expect(times.at(-1)).toEqual([5500, 9000, 0.125])
  })
})

describe('PartCache (verifier round 3)', () => {
  const done = (text: string): SpeakResult => ({
    ok: true,
    mime: 'audio/mpeg',
    audio: btoa(text),
    characters: text.length
  })

  it('asks once per voice, model and words; another voice or model asks again', async () => {
    const cache = new PartCache()
    const asked: string[] = []
    const ask = (text: string) => () => {
      asked.push(text)
      return Promise.resolve(done(text))
    }
    await cache.get(partKey('a', 'm', 'One.'), ask('One.'))
    expect(await cache.get(partKey('a', 'm', 'One.'), ask('One.'))).toEqual(done('One.'))
    await cache.get(partKey('b', 'm', 'One.'), ask('One.'))
    await cache.get(partKey('a', 'n', 'One.'), ask('One.'))
    expect(asked).toEqual(['One.', 'One.', 'One.'])
  })

  it('a part in flight is waited for, not asked twice; a failure is not kept', async () => {
    const cache = new PartCache()
    let calls = 0
    let answer!: (result: SpeakResult) => void
    const ask = (): Promise<SpeakResult> => {
      calls += 1
      return new Promise((resolve) => (answer = resolve))
    }
    const first = cache.get('k', ask)
    const second = cache.get('k', ask)
    expect(calls).toBe(1)
    answer({ ok: false, error: 'no', reason: 'unreachable' })
    expect((await first).ok).toBe(false)
    expect((await second).ok).toBe(false)
    expect(cache.size).toBe(0)
    void cache.get('k', ask)
    expect(calls).toBe(2)
    const thrown = new PartCache()
    await expect(thrown.get('k', () => Promise.reject(new Error('gone')))).rejects.toThrow('gone')
    expect(thrown.size).toBe(0)
  })

  it(`keeps the last ${PART_CACHE_MAX} parts used, dropping the least recently used`, async () => {
    const cache = new PartCache()
    const asked: string[] = []
    const ask = (key: string) => () => {
      asked.push(key)
      return Promise.resolve(done(key))
    }
    for (let i = 0; i < PART_CACHE_MAX; i++) await cache.get(`p${i}`, ask(`p${i}`))
    // p0 used again: p1 is now the oldest, dropped by the next new part.
    await cache.get('p0', ask('p0'))
    await cache.get('new', ask('new'))
    expect(cache.size).toBe(PART_CACHE_MAX)
    asked.length = 0
    await cache.get('p0', ask('p0'))
    await cache.get('p1', ask('p1'))
    expect(asked).toEqual(['p1'])
  })
})

describe('mp3Ms', () => {
  it('reads 128 kbit/s: 16 bytes a millisecond', () => {
    const audio = btoa('x'.repeat(16_000))
    expect(mp3Ms({ ok: true, mime: 'audio/mpeg', audio, characters: 1 })).toBe(1000)
  })
})
