import { describe, expect, it } from 'vitest'
import { decideNavigation, isAtHome, isLoopbackHost } from './view-navigation'

const HOME = 'http://127.0.0.1:4756'

describe('decideNavigation', () => {
  it('keeps a link to another local port in the pane — a sibling exos page', () => {
    expect(decideNavigation(HOME, 'http://127.0.0.1:4751/index.html')).toBe('in-pane')
    expect(decideNavigation(HOME, 'http://localhost:5173/')).toBe('in-pane')
    expect(decideNavigation(HOME, 'http://[::1]:4000/x')).toBe('in-pane')
  })

  it('keeps a same-origin link in the pane even off the local machine', () => {
    expect(
      decideNavigation('https://dash.example.com/board', 'https://dash.example.com/board/tasks')
    ).toBe('in-pane')
  })

  it('sends any other web link to the system browser', () => {
    expect(decideNavigation(HOME, 'https://linear.app/antasphere/issue/PRDCT-1')).toBe('external')
    expect(decideNavigation('https://dash.example.com', 'https://other.example.com/')).toBe(
      'external'
    )
    // Same host, different port: a different origin, and not loopback.
    expect(decideNavigation('https://dash.example.com', 'https://dash.example.com:8443/')).toBe(
      'external'
    )
  })

  it('denies anything that is not http(s) — no scheme reaches the app or the disk', () => {
    expect(decideNavigation(HOME, 'file:///etc/passwd')).toBe('deny')
    expect(decideNavigation(HOME, 'clave://open')).toBe('deny')
    expect(decideNavigation(HOME, 'javascript:alert(1)')).toBe('deny')
    expect(decideNavigation(HOME, 'not a url')).toBe('deny')
  })

  it('never lets a broken home widen the rule', () => {
    expect(decideNavigation('nonsense', 'https://example.com/')).toBe('external')
    expect(decideNavigation('nonsense', 'http://127.0.0.1:1/')).toBe('in-pane')
  })
})

describe('decideNavigation on a page served from disk', () => {
  const FILE_HOME = 'clave-preview://a1b2c3/dash.html'

  it('keeps a link inside the same folder in the pane — same token, same folder', () => {
    expect(decideNavigation(FILE_HOME, 'clave-preview://a1b2c3/two.html')).toBe('in-pane')
    expect(decideNavigation(FILE_HOME, 'clave-preview://a1b2c3/sub/three.html#x')).toBe('in-pane')
  })

  it('denies another token — another folder the page has no business in', () => {
    expect(decideNavigation(FILE_HOME, 'clave-preview://ffffff/dash.html')).toBe('deny')
  })

  it('denies a served-from-disk target from an http home', () => {
    expect(decideNavigation(HOME, 'clave-preview://a1b2c3/dash.html')).toBe('deny')
  })

  it('applies the web rules unchanged from a file home', () => {
    expect(decideNavigation(FILE_HOME, 'http://127.0.0.1:4751/')).toBe('in-pane')
    expect(decideNavigation(FILE_HOME, 'https://example.com/')).toBe('external')
    expect(decideNavigation(FILE_HOME, 'file:///etc/hosts')).toBe('deny')
  })
})

describe('isLoopbackHost', () => {
  it('recognises the loopback spellings', () => {
    for (const h of [
      'localhost',
      'LOCALHOST',
      '127.0.0.1',
      '127.1.2.3',
      '[::1]',
      '[::ffff:7f00:1]',
      'app.localhost',
      '0.0.0.0'
    ])
      expect(isLoopbackHost(h)).toBe(true)
    for (const h of ['example.com', '10.0.0.1', 'localhost.example.com'])
      expect(isLoopbackHost(h)).toBe(false)
  })

  it('is an address test, not a name shape: a public name starting with 127. is not local', () => {
    for (const h of [
      '127.0.0.1.nip.io',
      '127.example.com',
      '127.0.0.1.evil.com',
      '[::ffff:8.8.8.8]'
    ])
      expect(isLoopbackHost(h)).toBe(false)
    expect(decideNavigation(HOME, 'http://127.0.0.1.nip.io/')).toBe('external')
  })

  it('reads the canonical hostname the URL parser produces', () => {
    // The parser normalises the exotic spellings of 127.0.0.1 before we see them.
    expect(decideNavigation(HOME, 'http://0x7f000001/')).toBe('in-pane')
    expect(decideNavigation(HOME, 'http://2130706433/')).toBe('in-pane')
    expect(decideNavigation(HOME, 'http://[::ffff:127.0.0.1]:4000/')).toBe('in-pane')
  })
})

describe('isAtHome', () => {
  it('treats the declared home and the browser’s spelling of it as the same page', () => {
    expect(isAtHome(HOME, 'http://127.0.0.1:4756/')).toBe(true)
    expect(isAtHome(HOME, 'http://127.0.0.1:4756')).toBe(true)
    expect(isAtHome(HOME, 'http://127.0.0.1:4756/#demo')).toBe(true)
    expect(
      isAtHome(
        'http://127.0.0.1:5301/2026-09-08-demo-ag.html',
        'http://127.0.0.1:5301/2026-09-08-demo-ag.html#p2'
      )
    ).toBe(true)
  })

  it('is not home on another path, query, port or origin', () => {
    expect(isAtHome(HOME, 'http://127.0.0.1:4756/second')).toBe(false)
    expect(isAtHome(HOME, 'http://127.0.0.1:4756/?tab=demo')).toBe(false)
    expect(isAtHome(HOME, 'http://127.0.0.1:4751/')).toBe(false)
    expect(isAtHome(HOME, 'http://localhost:4756/')).toBe(false)
  })

  it('works for a page served from disk', () => {
    expect(
      isAtHome('clave-preview://a1b2c3/dash.html', 'clave-preview://a1b2c3/dash.html#p2')
    ).toBe(true)
    expect(isAtHome('clave-preview://a1b2c3/dash.html', 'clave-preview://a1b2c3/two.html')).toBe(
      false
    )
    expect(isAtHome('clave-preview://a1b2c3/dash.html', 'clave-preview://ffffff/dash.html')).toBe(
      false
    )
  })

  it('is false on unparseable input', () => {
    expect(isAtHome(HOME, 'about:blank')).toBe(false)
    expect(isAtHome('', HOME)).toBe(false)
  })
})
