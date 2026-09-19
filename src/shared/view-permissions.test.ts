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

  it('accepts IPv6 loopback in both spellings', () => {
    expect(isLocalPageOrigin('http://[::1]:4796')).toBe(true)
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
    expect(allowsViewPermission('http://127.0.0.1:4796', 'media', AUDIO)).toBe(true)
    expect(allowsViewPermission('http://localhost:4802', 'media', AUDIO)).toBe(true)
  })

  it('refuses the microphone to every other page', () => {
    expect(allowsViewPermission('https://example.com', 'media', AUDIO)).toBe(false)
    expect(allowsViewPermission('http://localhost.evil.com', 'media', AUDIO)).toBe(false)
  })

  it('refuses the camera, on a local page too', () => {
    // `media` is one permission name covering microphone and camera; the grant
    // is the microphone's alone.
    expect(allowsViewPermission('http://127.0.0.1:4796', 'media', ['video'])).toBe(false)
    expect(allowsViewPermission('http://127.0.0.1:4796', 'media', ['audio', 'video'])).toBe(false)
    expect(allowsViewPermission('http://127.0.0.1:4796', 'media', ['unknown'])).toBe(false)
  })

  it('refuses a media request that names no type', () => {
    expect(allowsViewPermission('http://127.0.0.1:4796', 'media', undefined)).toBe(false)
    expect(allowsViewPermission('http://127.0.0.1:4796', 'media', [])).toBe(false)
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
      expect(allowsViewPermission('http://127.0.0.1:4796', permission, AUDIO)).toBe(false)
      expect(allowsViewPermission('https://example.com', permission, AUDIO)).toBe(false)
    }
  })
})
