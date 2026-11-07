import { describe, expect, it } from 'vitest'
import { buildProvenanceHeader } from '../../../src/shared/exchange-provenance'
import { gist, indexExchanges } from './exchanges'
import type { Entry } from './reducer'
import type { DeliveryEntry } from './tools'

let clock = 0
const from = (name: string, id: string, body: string): DeliveryEntry => ({
  kind: 'user',
  text: `${buildProvenanceHeader({ name, id })}\n${body}`,
  final: true,
  at: ++clock
})
const send = (to: string, message: string, name = 'mcp__clave__clave_send_to_session'): Entry => ({
  kind: 'tool',
  id: `t${++clock}`,
  name,
  input: { sessionId: to, message },
  complete: true,
  at: clock
})
const said = (text: string): Entry => ({ kind: 'assistant', text, final: true, at: ++clock })

describe('indexExchanges', () => {
  it('pairs a message with the send before it to that tab and the send after it', () => {
    const ack = from('Verifier', 'v1', 'starting')
    const entries = [send('v1', 'please verify'), ack, said('ok'), send('v1', 'thanks')]
    const exchange = indexExchanges(entries).get(ack)
    expect(exchange?.request?.text).toBe('please verify')
    expect(exchange?.reply?.text).toBe('thanks')
  })

  it('pairs by the tab id alone, never across tabs', () => {
    const report = from('Verifier', 'v1', 'report')
    const deploy = from('Deploy bot', 'd1', 'green')
    const entries = [send('v1', 'verify'), send('d1', 'deploy'), report, deploy, send('d1', 'nice')]
    const index = indexExchanges(entries)
    expect(index.get(report)?.request?.text).toBe('verify')
    expect(index.get(report)?.reply).toBeUndefined()
    expect(index.get(deploy)?.request?.text).toBe('deploy')
    expect(index.get(deploy)?.reply?.text).toBe('nice')
  })

  it('uses a reply once: it is not also the request of the next message', () => {
    const first = from('Verifier', 'v1', 'ack')
    const second = from('Verifier', 'v1', 'report')
    const index = indexExchanges([first, send('v1', 'thanks'), second])
    expect(index.get(first)?.reply?.text).toBe('thanks')
    expect(index.get(second)?.request).toBeUndefined()
  })

  it('answers the latest message waiting from that tab', () => {
    const one = from('Verifier', 'v1', 'one')
    const two = from('Verifier', 'v1', 'two')
    const index = indexExchanges([one, two, send('v1', 'answer')])
    expect(index.get(one)?.reply).toBeUndefined()
    expect(index.get(two)?.reply?.text).toBe('answer')
  })

  it('reads the bare tool name too, and ignores other tools and odd inputs', () => {
    const message = from('Verifier', 'v1', 'report')
    const entries: Entry[] = [
      send('v1', 'bare', 'clave_send_to_session'),
      {
        kind: 'tool',
        id: 'x',
        name: 'Bash',
        input: { sessionId: 'v1', message: 'no' },
        complete: true,
        at: ++clock
      },
      {
        kind: 'tool',
        id: 'y',
        name: 'clave_send_to_session',
        input: { sessionId: 'v1' },
        complete: true,
        at: ++clock
      },
      message
    ]
    expect(indexExchanges(entries).get(message)?.request?.text).toBe('bare')
  })

  it('indexes an anonymous message with nothing around it', () => {
    const anonymous: DeliveryEntry = {
      kind: 'user',
      text: `${buildProvenanceHeader(undefined)}\nhello`,
      final: true,
      at: ++clock
    }
    expect(indexExchanges([send('v1', 'x'), anonymous]).get(anonymous)).toEqual({})
  })
})

describe('gist', () => {
  it('is the first line worth reading, without its markup', () => {
    expect(gist('\n\n## Report\nbody')).toBe('Report')
    expect(gist('- first item\n- second')).toBe('first item')
    expect(gist('   ')).toBe('')
  })
})
