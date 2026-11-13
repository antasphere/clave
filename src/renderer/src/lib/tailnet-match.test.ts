import { describe, expect, it } from 'vitest'
import { savedServerOf, tailnetNamesOf } from './tailnet-match'
import type { TailnetMachine } from '../../../shared/server-setup-types'

const machine = (over: Partial<TailnetMachine> = {}): TailnetMachine => ({
  name: 'studio-mini',
  dnsName: 'studio-mini.tail-example.ts.net.',
  ip: '100.64.0.7',
  os: 'macOS',
  online: true,
  url: 'http://100.64.0.7:43127',
  claveServer: true,
  ...over
})
const saved = (
  url: string,
  id = 'srv-1'
): { id: string; name: string; url: string; enabled: boolean } => ({
  id,
  name: 'Mac Studio',
  url,
  enabled: true
})

describe('the tailnet scan against the saved servers (PRDCT-4163)', () => {
  it('names a machine by its IPv4, its DNS name without the dot, and its host name', () => {
    expect(tailnetNamesOf(machine())).toEqual([
      '100.64.0.7',
      'studio-mini.tail-example.ts.net',
      'studio-mini'
    ])
  })
  it('matches a server saved by the IPv4 the scan probes', () => {
    expect(savedServerOf(machine(), [saved('http://100.64.0.7:43127')])?.id).toBe('srv-1')
  })
  it('matches a server saved by the DNS name or the host name, same port', () => {
    expect(
      savedServerOf(machine(), [saved('http://studio-mini.tail-example.ts.net:43127')])?.id
    ).toBe('srv-1')
    expect(savedServerOf(machine(), [saved('http://Studio-Mini:43127/')])?.id).toBe('srv-1')
  })
  it('treats another port as another server', () => {
    expect(savedServerOf(machine(), [saved('http://100.64.0.7:43128')])).toBeUndefined()
  })
  it('matches an address with no explicit port on the protocol default', () => {
    expect(
      savedServerOf(machine({ url: 'http://100.64.0.7:80' }), [saved('http://100.64.0.7')])?.id
    ).toBe('srv-1')
  })
  it('matches nothing for a machine with no address of its own', () => {
    expect(savedServerOf(machine({ ip: '', url: '' }), [saved('http://studio-mini:43127')])).toBe(
      undefined
    )
  })
  it('ignores a saved address that is not a URL', () => {
    expect(savedServerOf(machine(), [saved('not a url')])).toBeUndefined()
  })
  it('answers the first saved server that matches', () => {
    expect(
      savedServerOf(machine(), [
        saved('http://100.64.0.9:43127', 'other'),
        saved('http://100.64.0.7:43127', 'mine'),
        saved('http://studio-mini:43127', 'twin')
      ])?.id
    ).toBe('mine')
  })
})
