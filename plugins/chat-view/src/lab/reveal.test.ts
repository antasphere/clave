import { describe, expect, it } from 'vitest'
import {
  frameAt,
  REVEAL_MIN_WAIT_MS,
  REVEAL_MS,
  REVEAL_RUN,
  REVEAL_STEPS,
  revealFrames,
  shouldReveal
} from './reveal'

describe('revealFrames', () => {
  const from = 'tell me about the weather in brussels please'
  const to = 'The weather in Brussels'
  const frames = revealFrames(from, to)

  it('ends on the new text, and never shows the old one again', () => {
    expect(frames.at(-1)).toBe(to)
    expect(frames).not.toContain(from)
    expect(frames.length).toBeGreaterThan(5)
    expect(frames.length).toBeLessThanOrEqual(REVEAL_STEPS)
  })

  it('resolves left to right: the new text grows in front, the old one shrinks behind', () => {
    const settled = (frame: string): number => {
      let n = 0
      while (n < frame.length && n < to.length && frame[n] === to[n]) n++
      return n
    }
    const counts = frames.map(settled)
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1])
    const middle = frames[Math.floor(frames.length / 2)]
    expect(middle.endsWith(from.slice(-6))).toBe(true)
  })

  it('passes through a short run of unsettled characters, keeping the spaces', () => {
    const middle = frames[Math.floor(frames.length / 2)]
    const unsettled = [...middle].filter(
      (c, i) => c !== (to[i] ?? '') && c !== (from[i] ?? '')
    ).length
    expect(unsettled).toBeGreaterThan(0)
    expect(unsettled).toBeLessThanOrEqual(REVEAL_RUN)
    for (const frame of frames)
      for (let i = 0; i < frame.length; i++)
        if (from[i] === ' ' && to[i] === ' ') expect(frame[i]).toBe(' ')
  })

  it('is the same every time: a test can read it', () => {
    expect(revealFrames(from, to)).toEqual(frames)
  })

  it('reveals a longer text over a shorter one, and the same text not at all', () => {
    const grown = revealFrames('Hi', 'A much longer title')
    expect(grown.at(-1)).toBe('A much longer title')
    expect(revealFrames('Same', 'Same')).toEqual(['Same'])
    expect(revealFrames('', 'From nothing').at(-1)).toBe('From nothing')
  })
})

describe('frameAt', () => {
  it('plays the frames over the reveal, ending on the last', () => {
    const frames = ['a', 'b', 'c', 'd']
    expect(frameAt(frames, 0)).toBe('a')
    expect(frameAt(frames, REVEAL_MS / 2)).toBe('c')
    expect(frameAt(frames, REVEAL_MS * 2)).toBe('d')
    expect(REVEAL_MS).toBeGreaterThanOrEqual(300)
    expect(REVEAL_MS).toBeLessThanOrEqual(500)
  })
})

describe('shouldReveal', () => {
  it('reveals a title written while the head showed the loader long enough', () => {
    expect(REVEAL_MIN_WAIT_MS).toBe(400)
    expect(shouldReveal(1_000, 1_000 + REVEAL_MIN_WAIT_MS, true, false)).toBe(true)
    expect(shouldReveal(1_000, 5_000, true, false)).toBe(true)
  })

  it('just shows a title that came at once: it was filed on the host', () => {
    expect(shouldReveal(1_000, 1_000 + REVEAL_MIN_WAIT_MS - 1, true, false)).toBe(false)
    expect(shouldReveal(1_000, 1_050, true, false)).toBe(false)
  })

  it('just shows a title the head never waited for, one not written now, or under reduced motion', () => {
    expect(shouldReveal(null, 5_000, true, false)).toBe(false)
    expect(shouldReveal(1_000, 5_000, false, false)).toBe(false)
    expect(shouldReveal(1_000, 5_000, true, true)).toBe(false)
  })
})
