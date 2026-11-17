import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * What an adapter says live it never also keeps in its past (PRDCT-4664).
 *
 * The session's timeline freezes the adapter's past as its prefix when the
 * session is made ready, then orders every event the adapter emits, heard by a
 * view or not. A notice both said live and pushed into the past therefore
 * stood twice in every conversation: an OpenCode or a Pi chat that refused at
 * start, or opened on another model, did until this rule. The adapters' own
 * tests hold the roads their stand-in agents can take; this holds every call
 * site at once, the ones no stand-in reaches included (Pi's refused handshake,
 * its notice of a model off the chat's connection).
 */
const read = (file: string): string => readFileSync(join(__dirname, file), 'utf8')

describe.each(['acp-adapter.ts', 'pi-rpc-adapter.ts'])('%s', (file) => {
  const source = read(file)

  it('puts no notice into its past', () => {
    // An `error` event built for the past, whatever variable holds the list.
    expect(source).not.toMatch(/history\.push\(\s*\{\s*event:\s*\{\s*type:\s*'error'/)
    expect(source).not.toMatch(/startNotice/)
  })

  it('says a notice in one place, which touches no past', () => {
    const at = source.indexOf('  private notice(')
    expect(at).toBeGreaterThan(-1)
    const body = source.slice(at, source.indexOf('\n  }\n', at))
    expect(body).toContain('this.emit(state, {')
    expect(body).not.toContain('history')
  })
})
