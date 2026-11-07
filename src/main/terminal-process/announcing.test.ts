/**
 * The announcing child's stderr is bounded (PRDCT-3434, rounds 1 and 2 of
 * the verifier): the copy kept for a message holds the last
 * STDERR_KEEP_CHARS characters, and a line longer than that reaches the
 * listener in pieces of that size, so a child that logs for the app's whole
 * life, or writes without newlines, grows nothing here.
 */
import { describe, expect, it } from 'vitest'
import { STDERR_KEEP_CHARS, startAnnouncing, stopChild } from './announcing'

const childWriting = (
  script: string
): ReturnType<typeof startAnnouncing<'url'>> & {
  lines: string[]
} => {
  const lines: string[] = []
  const started = startAnnouncing({
    what: 'the child',
    cmd: process.execPath,
    args: ['-e', script],
    env: { PATH: process.env.PATH ?? '' },
    timeoutMs: 10_000,
    fields: ['url'],
    onStderr: (line) => lines.push(line)
  })
  return Object.assign(started, { lines })
}

const ANNOUNCE_THEN = (body: string): string =>
  `${body}; process.stdout.write(JSON.stringify({ url: 'u' }) + '\\n'); setInterval(() => {}, 1000)`

describe('the kept stderr of an announcing child', () => {
  it('keeps only the last STDERR_KEEP_CHARS characters of many lines', async () => {
    const child = childWriting(
      ANNOUNCE_THEN(
        `for (let i = 0; i < 4000; i++) process.stderr.write('line ' + String(i).padStart(5, '0') + ' ' + 'x'.repeat(40) + '\\n')`
      )
    )
    await child.announced
    await new Promise((r) => setTimeout(r, 200))
    const kept = child.stderr()
    expect(kept.length).toBeLessThanOrEqual(STDERR_KEEP_CHARS)
    expect(kept).toContain('line 03999')
    expect(kept).not.toContain('line 00000')
    expect(child.lines).toHaveLength(4000)
    await stopChild(child.child, 2_000)
  })

  it('hands a line with no newline on in pieces of at most STDERR_KEEP_CHARS', async () => {
    const child = childWriting(
      ANNOUNCE_THEN(`process.stderr.write('y'.repeat(${3 * 64 * 1024 + 10}))`)
    )
    await child.announced
    await new Promise((r) => setTimeout(r, 200))
    expect(child.lines.length).toBeGreaterThanOrEqual(3)
    for (const piece of child.lines) expect(piece.length).toBeLessThanOrEqual(STDERR_KEEP_CHARS)
    expect(child.stderr().length).toBeLessThanOrEqual(STDERR_KEEP_CHARS)
    await stopChild(child.child, 2_000)
  })
})
