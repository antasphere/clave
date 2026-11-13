import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureRevealMarkerOnClick } from './reveal-marker.mjs'

afterEach(() => vi.unstubAllGlobals())

describe('the stream marker at a reveal click', () => {
  it('samples the latest arrival at the click, after any automation delay', async () => {
    const button = new EventTarget()
    const page = { __responsivenessChunks: ['chunk000001 old'] }
    vi.stubGlobal('window', page)
    vi.stubGlobal('document', { querySelector: () => button })
    captureRevealMarkerOnClick('fixture')
    let settled = false
    page.__responsivenessRevealMarker.then(() => (settled = true))
    await Promise.resolve()
    expect(settled).toBe(false)
    page.__responsivenessChunks.push('chunk000002 latest')
    button.dispatchEvent(new Event('click'))
    expect(await page.__responsivenessRevealMarker).toBe('chunk000002')
    page.__responsivenessChunks.push('chunk000003 after the click')
    button.dispatchEvent(new Event('click'))
    expect(await page.__responsivenessRevealMarker).toBe('chunk000002')
  })

  it('does not invent a marker when the stream has supplied none', async () => {
    const button = new EventTarget()
    vi.stubGlobal('window', { __responsivenessChunks: [] })
    vi.stubGlobal('document', { querySelector: () => button })
    captureRevealMarkerOnClick('fixture')
    button.dispatchEvent(new Event('click'))
    expect(await window.__responsivenessRevealMarker).toBeUndefined()
  })

  it('refuses a missing reveal control', () => {
    vi.stubGlobal('document', { querySelector: () => null })
    expect(() => captureRevealMarkerOnClick('missing')).toThrow('The reveal button is missing')
  })
})
