import { describe, expect, it } from 'vitest'
import {
  endsPresentation,
  opensInBrowser,
  pickDisplay,
  presentableUrl,
  presentationPermits,
  staysOnPreview
} from './presentation-rules'

/** The presentation window's rules (PRDCT-4980). */
describe('the display a deck is presented on', () => {
  const laptop = { id: 1 }
  const projector = { id: 2 }
  const third = { id: 3 }

  it('is another display than the Clave window’s when there is one', () => {
    expect(pickDisplay([laptop, projector], 1)).toBe(projector)
    expect(pickDisplay([projector, laptop], 1)).toBe(projector)
    expect(pickDisplay([laptop, projector, third], 2)).toBe(laptop)
  })

  it('is the Clave window’s own display when it is the only one', () => {
    expect(pickDisplay([laptop], 1)).toBe(laptop)
  })

  it('is the first display when the window’s is unknown, and none when the screen lists none', () => {
    expect(pickDisplay([laptop, projector], null)).toBe(laptop)
    expect(pickDisplay([], 1)).toBeNull()
    expect(pickDisplay([], null)).toBeNull()
  })
})

describe('the address main shows', () => {
  it('is a preview on this Mac’s loopback, with a port, normalised', () => {
    expect(presentableUrl('http://127.0.0.1:4100/?bar=0&v=3')).toBe(
      'http://127.0.0.1:4100/?bar=0&v=3'
    )
    expect(presentableUrl('http://localhost:4100')).toBe('http://localhost:4100/')
  })

  it('refuses any other page, scheme, host or shape', () => {
    for (const raw of [
      'https://127.0.0.1:4100/',
      'http://127.0.0.1/',
      'http://example.com:4100/',
      'http://127.0.0.2:4100/',
      'http://[::1]:4100/',
      'http://user:secret@127.0.0.1:4100/',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'clave://app',
      'not a url',
      '',
      `http://127.0.0.1:4100/${'a'.repeat(4100)}`,
      undefined,
      42
    ])
      expect(presentableUrl(raw)).toBeNull()
  })
})

describe('where the page may go', () => {
  it('stays on the preview’s own origin, the browser takes web links, nothing else', () => {
    const preview = 'http://127.0.0.1:4100/?bar=0'
    expect(staysOnPreview('http://127.0.0.1:4100/other?v=2', preview)).toBe(true)
    expect(staysOnPreview('http://127.0.0.1:4101/', preview)).toBe(false)
    expect(staysOnPreview('http://localhost:4100/', preview)).toBe(false)
    expect(staysOnPreview('https://example.com/', preview)).toBe(false)
    expect(staysOnPreview('not a url', preview)).toBe(false)
    expect(opensInBrowser('https://example.com/')).toBe(true)
    expect(opensInBrowser('http://example.com/')).toBe(true)
    expect(opensInBrowser('file:///etc/passwd')).toBe(false)
    expect(opensInBrowser('javascript:alert(1)')).toBe(false)
  })
})

describe('the key that ends it and what the deck may ask', () => {
  it('ends on Escape pressed, not released, and on no other key', () => {
    expect(endsPresentation({ type: 'keyDown', key: 'Escape' })).toBe(true)
    expect(endsPresentation({ type: 'keyUp', key: 'Escape' })).toBe(false)
    expect(endsPresentation({ type: 'keyDown', key: 'ArrowRight' })).toBe(false)
    expect(endsPresentation({ type: 'keyDown', key: ' ' })).toBe(false)
  })

  it('lets a deck go full screen and copy, and nothing else', () => {
    expect(presentationPermits('fullscreen')).toBe(true)
    expect(presentationPermits('clipboard-sanitized-write')).toBe(true)
    for (const permission of [
      'media',
      'geolocation',
      'notifications',
      'clipboard-read',
      'openExternal'
    ])
      expect(presentationPermits(permission)).toBe(false)
  })
})
