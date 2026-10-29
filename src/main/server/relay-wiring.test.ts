import { describe, expect, it } from 'vitest'
import { machineRecord, relayAddressOf, relayCredentialStore } from './relay-wiring'
import { electronTestPorts, standaloneTestPorts } from '../ports/testing'

describe('the relay address the server accepts', () => {
  it('takes https, and plain http to a literal loopback address only', () => {
    expect(relayAddressOf('https://relay.antasphere.com')).toBe('https://relay.antasphere.com')
    expect(relayAddressOf('https://relay.antasphere.com/')).toBe('https://relay.antasphere.com')
    expect(relayAddressOf(' http://127.0.0.1:8787/ ')).toBe('http://127.0.0.1:8787')
    expect(relayAddressOf('http://localhost:8787')).toBe('http://localhost:8787')
    expect(relayAddressOf('http://[::1]:8787')).toBe('http://[::1]:8787')
  })
  it('refuses a plain-http address off this machine, another scheme, credentials, a query, nothing', () => {
    expect(relayAddressOf('http://relay.antasphere.com')).toBeNull()
    expect(relayAddressOf('http://192.168.1.20:8787')).toBeNull()
    expect(relayAddressOf('ws://relay.antasphere.com')).toBeNull()
    expect(relayAddressOf('https://user:pw@relay.antasphere.com')).toBeNull()
    expect(relayAddressOf('https://relay.antasphere.com/?x=1')).toBeNull()
    expect(relayAddressOf('https://relay.antasphere.com/#f')).toBeNull()
    expect(relayAddressOf('')).toBeNull()
    expect(relayAddressOf(undefined)).toBeNull()
    expect(relayAddressOf(42)).toBeNull()
  })
})

describe('the machine record', () => {
  it('combines the host and owner display name when signed in', () => {
    expect(
      machineRecord({
        version: '2.4.0',
        hostname: 'Build-Mac.local',
        platform: 'darwin',
        accountName: 'Ada'
      }).name
    ).toBe('Build-Mac · Ada')
  })
  it('names the host without .local, the platform and the version, and the direct addresses', () => {
    expect(
      machineRecord({
        version: '2.4.0',
        hostname: 'Valentins-MacBook-Pro.local',
        platform: 'darwin'
      })
    ).toEqual({ name: 'Valentins-MacBook-Pro', platform: 'macos', version: '2.4.0', direct: [] })
    expect(
      machineRecord({
        version: '2.4.0',
        hostname: 'build-box',
        platform: 'linux',
        direct: ['http://100.64.0.2:43127']
      })
    ).toEqual({
      name: 'build-box',
      platform: 'linux',
      version: '2.4.0',
      direct: [{ url: 'http://100.64.0.2:43127' }]
    })
  })
})

describe('the credential store over the settings ports', () => {
  it.each([
    ['the Electron adapters', () => electronTestPorts()],
    ['the standalone adapters', () => standaloneTestPorts()]
  ])('seals the secret, keeps the rest in clear, and clears whole, on %s', (_name, make) => {
    const ports = make()
    const store = relayCredentialStore(ports)
    expect(store.load()).toBeNull()
    store.save({
      relay: 'https://relay.example',
      machineId: 'm_1',
      owner: 'sub-1',
      machineSecret: 'cms_secret'
    })
    const text = ports.storage.read('relay.json') ?? ''
    expect(text).toContain('m_1')
    expect(text).toContain('sub-1')
    expect(text).not.toContain('cms_secret')
    expect(store.load()).toEqual({
      relay: 'https://relay.example',
      machineId: 'm_1',
      owner: 'sub-1',
      machineSecret: 'cms_secret'
    })
    store.clear()
    expect(store.load()).toBeNull()
    expect(ports.storage.read('relay.json')).toBeNull()
  })
})
