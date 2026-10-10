import { describe, expect, it } from 'vitest'
import { DraftShadow } from '../../shared/draft-shadow'
import { TYPING_GAP_MS, draftHandlingOf, typeIntoTerminal } from './typing'

/**
 * The typing sequence over a fake terminal: what is written, in which
 * order, and what the answer says about the draft. The real writer is the
 * PTY manager's; here every write is kept.
 */
interface Fake {
  writes: string[]
  sleeps: number[]
  target: Parameters<typeof typeIntoTerminal>[2]
}
function fakeTarget(shadow = new DraftShadow()): Fake {
  const writes: string[] = []
  const sleeps: number[] = []
  return {
    writes,
    sleeps,
    target: {
      shadow,
      write: (data: string) => void writes.push(data),
      sleep: async (ms: number) => void sleeps.push(ms)
    }
  }
}

describe('typeIntoTerminal', () => {
  it('with an empty input: one bracketed paste, a pause, the submit, nothing else', async () => {
    const f = fakeTarget()
    const out = await typeIntoTerminal('t1', 'hello\nworld', f.target)
    expect(f.writes).toEqual(['\x1b[200~hello\nworld\x1b[201~', '\r'])
    expect(f.sleeps).toEqual([TYPING_GAP_MS])
    expect(out).toEqual({ submitted: true, draftHandling: 'none' })
  })
  it('sets a confident draft aside, delivers alone, and puts it back unsubmitted', async () => {
    const shadow = new DraftShadow()
    shadow.feed('half typed')
    const f = fakeTarget(shadow)
    const out = await typeIntoTerminal('t1', 'msg', f.target)
    expect(f.writes[0]).toBe('\x7f'.repeat('half typed'.length))
    expect(f.writes.slice(1)).toEqual([
      '\x1b[200~msg\x1b[201~',
      '\r',
      '\x1b[200~half typed\x1b[201~'
    ])
    expect(out.draftHandling).toBe('stashed-restored')
    expect(shadow.snapshot()).toMatchObject({ text: 'half typed', confident: true })
  })
  it('says best effort when the shadow lost confidence, and still delivers', async () => {
    const shadow = new DraftShadow()
    shadow.feed('abc')
    shadow.noteOpaqueInput()
    const f = fakeTarget(shadow)
    const out = await typeIntoTerminal('t1', 'msg', f.target)
    expect(out.draftHandling).toBe('stashed-restored-best-effort')
    expect(f.writes).toContain('\x1b[200~msg\x1b[201~')
    expect(f.writes.at(-2)).toBe('\r')
  })
  it('two messages to one terminal never interleave their envelopes', async () => {
    const f = fakeTarget()
    await Promise.all([
      typeIntoTerminal('same', 'one', f.target),
      typeIntoTerminal('same', 'two', f.target)
    ])
    expect(f.writes).toEqual(['\x1b[200~one\x1b[201~', '\r', '\x1b[200~two\x1b[201~', '\r'])
  })
  it('the restored draft is filtered as the message is', () => {
    expect(draftHandlingOf({ text: '', confident: true, clear: '' })).toBe('none')
    expect(draftHandlingOf({ text: 'x', confident: true, clear: '\x7f' })).toBe('stashed-restored')
    expect(draftHandlingOf({ text: '', confident: false, clear: '' })).toBe(
      'stashed-restored-best-effort'
    )
  })
})
