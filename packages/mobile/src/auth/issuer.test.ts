import { describe, expect, it } from 'vitest'
import { DEFAULT_ISSUER, resolveIssuer } from './issuer'

describe('resolveIssuer', () => {
  it('is the hub when nothing is set', () => {
    expect(resolveIssuer(undefined)).toEqual({
      ok: true,
      config: { origin: DEFAULT_ISSUER, insecure: false }
    })
    expect(resolveIssuer('  ')).toEqual({
      ok: true,
      config: { origin: DEFAULT_ISSUER, insecure: false }
    })
  })

  it('takes an https origin and the literal loopback over http', () => {
    expect(resolveIssuer('https://hub.example/')).toEqual({
      ok: true,
      config: { origin: 'https://hub.example', insecure: false }
    })
    expect(resolveIssuer('http://127.0.0.1:4321')).toEqual({
      ok: true,
      config: { origin: 'http://127.0.0.1:4321', insecure: true }
    })
  })

  it.each([
    ['not a URL', 'nope'],
    ['not a bare origin', 'https://hub.example/path'],
    ['not a bare origin', 'https://hub.example/?x=1'],
    ['not a bare origin', 'https://user:pw@hub.example'],
    ['plain http is only accepted for 127.0.0.1', 'http://localhost:4321'],
    ['plain http is only accepted for 127.0.0.1', 'http://192.168.1.10:8080'],
    ['plain http is only accepted for 127.0.0.1', 'ftp://127.0.0.1']
  ])('refuses %s (%s) and never falls back to the hub', (reason, raw) => {
    expect(resolveIssuer(raw)).toEqual({ ok: false, reason })
  })
})
