import { describe, expect, it } from 'vitest'
import {
  frameAt,
  frameText,
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
  const texts = frames.map(frameText)

  it('ends on the new text, all settled, and never shows the old one again', () => {
    expect(frames.at(-1)).toEqual({ settled: to, wet: '', old: '', fade: 0 })
    expect(texts).not.toContain(from)
    expect(frames.length).toBeGreaterThan(5)
    expect(frames.length).toBeLessThanOrEqual(REVEAL_STEPS)
  })

  it('writes left to right: the new text grows in front, the old one shrinks behind', () => {
    for (let i = 1; i < frames.length; i++) {
      const [a, b] = [frames[i - 1], frames[i]]
      expect((b.settled + b.wet).length).toBeGreaterThanOrEqual((a.settled + a.wet).length)
      expect(b.settled.length).toBeGreaterThanOrEqual(a.settled.length)
      expect(b.old.length).toBeLessThanOrEqual(a.old.length)
      expect(b.fade).toBeLessThanOrEqual(a.fade)
    }
    expect(frames[0].fade).toBeGreaterThan(0.9)
    const middle = frames[Math.floor(frames.length / 2)]
    expect(middle.old.endsWith(from.slice(-6))).toBe(true)
  })

  it('every frame is the new text so far, then the old text: never a character of neither', () => {
    for (const frame of frames) {
      expect(to.startsWith(frame.settled + frame.wet)).toBe(true)
      expect(from.endsWith(frame.old)).toBe(true)
    }
  })

  it('keeps a short run wet behind the pen', () => {
    for (const frame of frames) expect(frame.wet.length).toBeLessThanOrEqual(REVEAL_RUN)
    expect(frames.some((frame) => frame.wet.length === REVEAL_RUN)).toBe(true)
  })

  it('moves the pen on a hand’s pace: slower at the ends than through the middle', () => {
    const written = frames.map((frame) => frame.settled.length + frame.wet.length)
    const steps = written.slice(1).map((n, i) => n - written[i])
    const middle = steps[Math.floor(steps.length / 2)]
    expect(steps[0]).toBeLessThan(middle)
    expect(steps.at(-2) ?? 0).toBeLessThan(middle)
  })

  it('is the same every time: a test can read it', () => {
    expect(revealFrames(from, to)).toEqual(frames)
  })

  it('a stand-in longer than the title fades ahead of the pen, and is gone when it lifts', () => {
    const tail = frames.filter((frame) => frame.old.length > 0).at(-1)!
    expect(tail.fade).toBeLessThan(0.35)
    expect(frames.at(-1)!.old).toBe('')
  })

  it('reveals a longer text over a shorter one, and the same text not at all', () => {
    const grown = revealFrames('Hi', 'A much longer title')
    expect(frameText(grown.at(-1)!)).toBe('A much longer title')
    expect(revealFrames('Same', 'Same')).toEqual([{ settled: 'Same', wet: '', old: '', fade: 0 }])
    expect(frameText(revealFrames('', 'From nothing').at(-1)!)).toBe('From nothing')
  })
})

describe('frameAt', () => {
  it('plays the frames over the reveal, ending on the last', () => {
    const frames = ['a', 'b', 'c', 'd'].map((settled) => ({ settled, wet: '', old: '', fade: 1 }))
    expect(frameAt(frames, 0)?.settled).toBe('a')
    expect(frameAt(frames, REVEAL_MS / 2)?.settled).toBe('c')
    expect(frameAt(frames, REVEAL_MS * 2)?.settled).toBe('d')
    expect(frameAt([], 10)).toBeNull()
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
