import { describe, expect, it } from 'vitest'
import {
  endsPresentation,
  opensInBrowser,
  presentableUrl,
  presentationBounds,
  presentationPermits,
  staysOnPreview
} from './presentation-rules'

/** The presentation window's rules (PRDCT-4980). */
describe('where a presentation window opens (PRDCT-5167)', () => {
  it('is a 1280 by 720 window centred on a display with the room, never the whole screen', () => {
    // A large display's work area, under the menu bar.
    expect(presentationBounds({ x: 0, y: 25, width: 2560, height: 1415 })).toEqual({
      x: 640,
      y: 373,
      width: 1280,
      height: 720
    })
  })

  it('shrinks to four fifths of a small work area, keeping 16:9', () => {
    expect(presentationBounds({ x: 0, y: 25, width: 1280, height: 775 })).toEqual({
      x: 128,
      y: 125,
      width: 1024,
      height: 576
    })
    // A display standing upright: its width is what limits.
    expect(presentationBounds({ x: 0, y: 0, width: 1080, height: 1895 })).toEqual({
      x: 108,
      y: 705,
      width: 864,
      height: 486
    })
    // A wide, short display: its height is what limits.
    expect(presentationBounds({ x: 0, y: 0, width: 2560, height: 600 })).toEqual({
      x: 854,
      y: 60,
      width: 853,
      height: 480
    })
  })

  it('opens on the display it is given, wherever that display sits', () => {
    expect(presentationBounds({ x: -1920, y: -200, width: 1920, height: 1055 })).toEqual({
      x: -1600,
      y: -32,
      width: 1280,
      height: 720
    })
  })

  it('leaves room around it on every display', () => {
    for (const area of [
      { x: 0, y: 25, width: 1280, height: 775 },
      { x: 0, y: 25, width: 1440, height: 875 },
      { x: 0, y: 25, width: 1512, height: 957 },
      { x: 0, y: 25, width: 1920, height: 1055 },
      { x: 0, y: 25, width: 2560, height: 1415 },
      { x: 0, y: 0, width: 1080, height: 1895 },
      { x: 0, y: 0, width: 800, height: 600 }
    ]) {
      const window = presentationBounds(area)
      expect(window.width).toBeLessThan(area.width)
      expect(window.height).toBeLessThan(area.height)
      expect(window.x).toBeGreaterThan(area.x)
      expect(window.y).toBeGreaterThan(area.y)
      expect(window.x + window.width).toBeLessThan(area.x + area.width)
      expect(window.y + window.height).toBeLessThan(area.y + area.height)
      expect(Math.abs(window.width / window.height - 16 / 9)).toBeLessThan(0.01)
    }
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
