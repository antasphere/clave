import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * What an adapter says live it never also keeps in its past (PRDCT-4664).
 *
 * The session's timeline freezes the adapter's past as its prefix when the
 * session is made ready, then orders every event the adapter emits, heard by a
 * view or not. A notice both said live and written into the past therefore
 * stood twice in every conversation: an OpenCode or a Pi chat that refused at
 * start, or opened on another model, did until this rule. The adapters' own
 * tests hold the roads their stand-in agents can take; this holds every call
 * site at once, the ones no stand-in reaches included (Pi's refused handshake,
 * its notice of a model off the chat's connection).
 *
 * It does so by naming who may write an adapter's past at all: the load of the
 * conversation it resumes, and nothing else. A write anywhere else fails here,
 * whatever it writes and however it is spelled, and its author reads this.
 */
const read = (file: string): string => readFileSync(join(__dirname, file), 'utf8')

/** A line that writes the list an adapter's `history()` answers, or takes it
 *  under another name to write it from there (the verifier's round 3: a
 *  `const past = state.history` followed by `past.push` passed a guard that
 *  only knew the list by its own name). */
const WRITES = [
  /\bhistory\s*=(?!=)/,
  /\bhistory(?:\[[^\]]*\])+[\w.]*\s*=(?!=)/,
  /\bhistory\.(?:push|unshift|splice|pop|shift|fill|sort|reverse|copyWithin)\(/,
  /\bhistory\.length\s*=(?!=)/,
  /=\s*(?:[\w.()]+\.)?history\s*;?$/
]

/** Every such line of `source`, with where it sits, comments left out. */
function writesOf(source: string): { at: number; line: string }[] {
  const found: { at: number; line: string }[] = []
  let at = 0
  for (const raw of source.split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('*') && !line.startsWith('//') && !line.startsWith('/*'))
      if (WRITES.some((write) => write.test(line))) found.push({ at, line })
    at += raw.length + 1
  }
  return found
}

/** The span of one method of the class, from its declaration to its closing
 *  brace at the class's indentation. */
function methodSpan(source: string, declaration: string): [number, number] {
  const start = source.indexOf(declaration)
  if (start < 0) throw new Error(`no method ${declaration}`)
  return [start, source.indexOf('\n  }\n', start)]
}

describe('acp-adapter.ts (OpenCode)', () => {
  const source = read('acp-adapter.ts')

  it('writes its past only where it loads the conversation it resumes', () => {
    const [start, end] = methodSpan(source, '  private replay(')
    const outside = writesOf(source)
      .filter(({ at }) => at < start || at > end)
      .map(({ line }) => line)
    // The one write outside the replay: a load that failed leaves no past.
    expect(outside).toEqual(['state.history = []'])
    // And the replay does write it: the rule above is not vacuous.
    expect(writesOf(source).length).toBeGreaterThan(outside.length)
  })

  it('says a notice in one place, which touches no past', () => {
    const [start, end] = methodSpan(source, '  private notice(')
    const body = source.slice(start, end)
    expect(body).toContain('this.emit(state, {')
    expect(body).not.toContain('history')
  })
})

describe('pi-rpc-adapter.ts (Pi)', () => {
  const source = read('pi-rpc-adapter.ts')

  it('writes its past only where it loads the conversation it resumes', () => {
    expect(writesOf(source).map(({ line }) => line)).toEqual([
      "state.history = piHistory(record(await connection.command('get_messages')).messages)"
    ])
  })

  it('says a notice in one place, which touches no past', () => {
    const [start, end] = methodSpan(source, '  private notice(')
    const body = source.slice(start, end)
    expect(body).toContain('this.emit(state, {')
    expect(body).not.toContain('history')
  })
})
