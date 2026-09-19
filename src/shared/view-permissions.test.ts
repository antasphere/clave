import { describe, it, expect } from 'vitest'
import { isLocalPageOrigin, allowsViewPermission } from './view-permissions'

/**
 * The guest pages' permission rule. Every case here is a page that either does
 * or does not get a microphone inside Clave, and the cost of the wrong answer
 * is silent in both directions: too loose and a page nobody vetted listens,
 * too tight and the voice dock stays mute with nothing on screen to say why.
 */

/** What a `media` request for the microphone alone looks like. */
const AUDIO = ['audio']

describe('isLocalPageOrigin', () => {
  it('accepts the loopback hosts Clave serves its own pages on, at any port', () => {
    expect(isLocalPageOrigin('http://127.0.0.1:4796')).toBe(true)
    expect(isLocalPageOrigin('http://localhost:5173')).toBe(true)
    expect(isLocalPageOrigin('http://127.0.0.1:4802/index.html')).toBe(true)
    // No port at all is still loopback.
    expect(isLocalPageOrigin('http://localhost')).toBe(true)
  })

  it('accepts IPv6 loopback, which keeps its brackets', () => {
    // `new URL('http://[::1]:4796').hostname` is '[::1]', brackets included,
    // and a bare `http://::1` does not parse at all — so the bracketed
    // spelling is the only one that can ever be matched.
    expect(new URL('http://[::1]:4796').hostname).toBe('[::1]')
    expect(isLocalPageOrigin('http://[::1]:4796')).toBe(true)
  })

  it('refuses 0.0.0.0, which is not a page only this machine can reach', () => {
    // A server bound to 0.0.0.0 answers the whole network, so a page served
    // from it is not the person's own local page in the sense that matters.
    expect(isLocalPageOrigin('http://0.0.0.0:4796')).toBe(false)
    expect(isLocalPageOrigin('http://[::]:4796')).toBe(false)
  })

  it('accepts https on loopback', () => {
    expect(isLocalPageOrigin('https://localhost:8443')).toBe(true)
  })

  it('refuses the internet', () => {
    expect(isLocalPageOrigin('https://example.com')).toBe(false)
    expect(isLocalPageOrigin('https://exos.antasphere.studio')).toBe(false)
  })

  it('refuses a host that merely CONTAINS a loopback name', () => {
    // The whole reason the check is an exact host match and not a prefix, a
    // suffix or an includes(): every one of these is an ordinary internet
    // host that someone else controls.
    expect(isLocalPageOrigin('http://127.0.0.1.evil.com')).toBe(false)
    expect(isLocalPageOrigin('http://localhost.evil.com')).toBe(false)
    expect(isLocalPageOrigin('http://evil-localhost.com')).toBe(false)
    expect(isLocalPageOrigin('http://notlocalhost')).toBe(false)
    expect(isLocalPageOrigin('https://localhost.attacker.io:4796')).toBe(false)
  })

  it('refuses a loopback name that is only in the path, the query or the credentials', () => {
    expect(isLocalPageOrigin('https://evil.com/http://127.0.0.1')).toBe(false)
    expect(isLocalPageOrigin('https://evil.com/?x=localhost')).toBe(false)
    // The host here is evil.com; the loopback name is a username.
    expect(isLocalPageOrigin('https://localhost@evil.com')).toBe(false)
  })

  it('refuses a private-network address that is not loopback', () => {
    // Another machine on the network is not this machine.
    expect(isLocalPageOrigin('http://192.168.1.10:4796')).toBe(false)
    expect(isLocalPageOrigin('http://10.0.0.5:4796')).toBe(false)
    expect(isLocalPageOrigin('http://127.0.0.2:4796')).toBe(false)
  })

  it('refuses schemes that carry no host to reason about', () => {
    // A file page's origin is opaque, and the app's own disk-serving scheme
    // would make "local" mean "any file the page can reach".
    expect(isLocalPageOrigin('file:///Users/someone/page.html')).toBe(false)
    expect(isLocalPageOrigin('clave-preview://127.0.0.1/page.html')).toBe(false)
    expect(isLocalPageOrigin('data:text/html,<h1>hi</h1>')).toBe(false)
  })

  it('refuses what is not a URL at all', () => {
    expect(isLocalPageOrigin('')).toBe(false)
    expect(isLocalPageOrigin('null')).toBe(false)
    expect(isLocalPageOrigin('not a url')).toBe(false)
  })
})

describe('allowsViewPermission', () => {
  it('grants the microphone to a page served from this machine', () => {
    expect(
      allowsViewPermission(
        { origin: 'http://127.0.0.1:4796', mediaTypes: AUDIO, isMainFrame: true },
        'media'
      )
    ).toBe(true)
    expect(
      allowsViewPermission(
        { origin: 'http://localhost:4802', mediaTypes: AUDIO, isMainFrame: true },
        'media'
      )
    ).toBe(true)
  })

  it('refuses the microphone to every other page', () => {
    expect(
      allowsViewPermission(
        { origin: 'https://example.com', mediaTypes: AUDIO, isMainFrame: true },
        'media'
      )
    ).toBe(false)
    expect(
      allowsViewPermission(
        { origin: 'http://localhost.evil.com', mediaTypes: AUDIO, isMainFrame: true },
        'media'
      )
    ).toBe(false)
  })

  it('refuses the camera, on a local page too', () => {
    // `media` is one permission name covering microphone and camera; the grant
    // is the microphone's alone.
    expect(
      allowsViewPermission(
        { origin: 'http://127.0.0.1:4796', mediaTypes: ['video'], isMainFrame: true },
        'media'
      )
    ).toBe(false)
    expect(
      allowsViewPermission(
        { origin: 'http://127.0.0.1:4796', mediaTypes: ['audio', 'video'], isMainFrame: true },
        'media'
      )
    ).toBe(false)
    expect(
      allowsViewPermission(
        { origin: 'http://127.0.0.1:4796', mediaTypes: ['unknown'], isMainFrame: true },
        'media'
      )
    ).toBe(false)
  })

  it('refuses a media request that names no type', () => {
    expect(
      allowsViewPermission(
        { origin: 'http://127.0.0.1:4796', mediaTypes: undefined, isMainFrame: true },
        'media'
      )
    ).toBe(false)
    expect(
      allowsViewPermission(
        { origin: 'http://127.0.0.1:4796', mediaTypes: [], isMainFrame: true },
        'media'
      )
    ).toBe(false)
  })

  it('refuses a subframe, even a loopback one', () => {
    // The hole this closes: a page from the internet shown in a view embeds
    // <iframe src="http://127.0.0.1:1234"> and asks through it. The asking
    // origin is the iframe's — loopback — while the page driving it is not,
    // and an iframe is a subresource load that the link policy never sees.
    // Only the page Clave itself shows is granted.
    expect(
      allowsViewPermission(
        { origin: 'http://127.0.0.1:4796', mediaTypes: AUDIO, isMainFrame: false },
        'media'
      )
    ).toBe(false)
    expect(
      allowsViewPermission(
        { origin: 'http://localhost:4802', mediaTypes: AUDIO, isMainFrame: false },
        'media'
      )
    ).toBe(false)
  })

  it('refuses every permission that is not media, local page or not', () => {
    // The partition refused everything before the microphone was let through,
    // and everything else must still be refused.
    for (const permission of [
      'geolocation',
      'notifications',
      'clipboard-read',
      'display-capture',
      'midi',
      'midiSysex',
      'hid',
      'serial',
      'usb',
      'idle-detection',
      'pointerLock',
      'fullscreen',
      'openExternal',
      'window-management',
      'storage-access',
      'fileSystem',
      'speaker-selection',
      'mediaKeySystem',
      'unknown'
    ]) {
      expect(
        allowsViewPermission(
          { origin: 'http://127.0.0.1:4796', mediaTypes: AUDIO, isMainFrame: true },
          permission
        )
      ).toBe(false)
      expect(
        allowsViewPermission(
          { origin: 'https://example.com', mediaTypes: AUDIO, isMainFrame: true },
          permission
        )
      ).toBe(false)
    }
  })
})
