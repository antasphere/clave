// The gate's module imports Electron's types only: its pure parts run here without it.
import { describe, expect, it } from 'vitest'
import { gateUrls, stampWindowHeader } from './window-gate'
import { WINDOW_HEADER } from './loopback-forwards'

const secrets = new Map([
  [41001, 'secret-one'],
  [41002, 'secret-two']
])

describe('the window gate', () => {
  it('lists both loopback names, HTTP and WebSocket, for every open port', () => {
    expect(gateUrls(secrets)).toEqual([
      'http://127.0.0.1:41001/*',
      'ws://127.0.0.1:41001/*',
      'http://localhost:41001/*',
      'ws://localhost:41001/*',
      'http://127.0.0.1:41002/*',
      'ws://127.0.0.1:41002/*',
      'http://localhost:41002/*',
      'ws://localhost:41002/*'
    ])
    expect(gateUrls(new Map())).toEqual([])
  })

  it("stamps a known port's secret, on both names and both schemes", () => {
    for (const url of [
      'http://127.0.0.1:41001/index.html',
      'http://localhost:41001/',
      'ws://127.0.0.1:41001/__reload'
    ])
      expect(stampWindowHeader(url, { accept: '*/*' }, secrets), url).toEqual({
        accept: '*/*',
        [WINDOW_HEADER]: 'secret-one'
      })
    expect(stampWindowHeader('http://127.0.0.1:41002/a', {}, secrets)).toEqual({
      [WINDOW_HEADER]: 'secret-two'
    })
  })

  it('leaves the headers of a port that is not open, or another host, unchanged', () => {
    const headers = { accept: '*/*', [WINDOW_HEADER]: 'page-made' }
    expect(stampWindowHeader('http://127.0.0.1:41003/', headers, secrets)).toBe(headers)
    expect(stampWindowHeader('http://example.com:41001/', headers, secrets)).toBe(headers)
    expect(stampWindowHeader('http://127.0.0.1.example.com:41001/', headers, secrets)).toBe(headers)
  })

  it('replaces a header of that name the page sent, whatever its case, and never keeps it', () => {
    const stamped = stampWindowHeader(
      'http://127.0.0.1:41001/',
      { 'X-Clave-Window': 'page-made', [WINDOW_HEADER]: 'also-page-made', accept: 'text/html' },
      secrets
    )
    expect(stamped).toEqual({ accept: 'text/html', [WINDOW_HEADER]: 'secret-one' })
  })
})
