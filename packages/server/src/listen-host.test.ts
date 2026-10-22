import { describe, expect, it, vi } from 'vitest'
import { isIP } from 'node:net'
import { normalizeListenHost, resolveListenHost } from './listen-host'
import { startEmbedded } from './embedded'

const WILDCARDS = [
  '0.0.0.0',
  '0',
  '00',
  '0.0',
  '0.0.0',
  '0x0',
  '0x00000000',
  '00000000',
  '0.0.0.0.',
  '::',
  '::0',
  '0::',
  '0::0',
  '0:0:0:0:0:0:0:0',
  '::0.0.0.0',
  '::ffff:0.0.0.0',
  '::ffff:0000:0000',
  '0:0:0:0:0:FFFF:0:0'
]

describe('explicit listener host boundary', () => {
  it.each(WILDCARDS)('rejects numeric wildcard alias %s', async (host) => {
    expect(() => normalizeListenHost(host)).toThrow('never a wildcard')
    let opened: Awaited<ReturnType<typeof startEmbedded>> | undefined
    try {
      await expect(
        startEmbedded({ ports: {}, host }).then((server) => {
          opened = server
          return server
        })
      ).rejects.toThrow('never a wildcard')
    } finally {
      await opened?.stop()
    }
  })

  it.each([
    ['127.0.0.1', '127.0.0.1'],
    ['127.1', '127.0.0.1'],
    ['0x7f000001', '127.0.0.1'],
    ['100.64.0.2', '100.64.0.2'],
    ['0:0:0:0:0:0:0:1', '::1'],
    ['fd7a:115c:a1e0:0:0:0:0:2', 'fd7a:115c:a1e0::2'],
    ['vps.example.ts.net', 'vps.example.ts.net']
  ])('normalizes an explicit address %s', (input, expected) => {
    expect(normalizeListenHost(input)).toBe(expected)
  })

  it('does not resolve a verified numeric literal a second time', async () => {
    const lookup = vi.fn()
    expect(await resolveListenHost('127.1', lookup)).toBe('127.0.0.1')
    expect(lookup).not.toHaveBeenCalled()
  })

  it.each(['0.0.0.0', '::', '::ffff:0.0.0.0'])(
    'rejects a hostname resolving to %s, including mixed answers',
    async (address) => {
      const lookup = vi.fn(async () => [
        { address: '100.64.0.2', family: 4 },
        { address, family: isIP(address) }
      ])
      await expect(resolveListenHost('vps.example.ts.net', lookup)).rejects.toThrow(
        'never a wildcard'
      )
      expect(lookup).toHaveBeenCalledTimes(1)
    }
  )

  it('returns only the checked numeric address for the actual listener', async () => {
    const lookup = vi.fn(async () => [{ address: 'fd7a:115c:a1e0::2', family: 6 }])
    expect(await resolveListenHost('vps.example.ts.net', lookup)).toBe('fd7a:115c:a1e0::2')
    expect(lookup).toHaveBeenCalledExactlyOnceWith('vps.example.ts.net')
  })

  it('rejects empty, invalid, failed and stalled DNS answers', async () => {
    await expect(resolveListenHost('vps', async () => [])).rejects.toThrow('no address')
    await expect(
      resolveListenHost('vps', async () => [{ address: 'another-host', family: 4 }])
    ).rejects.toThrow('IP address')
    await expect(
      resolveListenHost('vps', async () => {
        throw new Error('DNS failed')
      })
    ).rejects.toThrow('DNS failed')
    await expect(resolveListenHost('vps', () => new Promise(() => {}), 5)).rejects.toThrow(
      'timed out'
    )
  })

  it('serves a real authenticated listener on the resolved loopback address', async () => {
    const server = await startEmbedded({ ports: {}, host: 'localhost' })
    try {
      expect(isIP(new URL(server.url).hostname.replace(/^\[|\]$/g, ''))).toBeGreaterThan(0)
      const response = await fetch(`${server.url}/health/live`, {
        headers: { authorization: `Bearer ${server.token}` }
      })
      expect(response.ok).toBe(true)
    } finally {
      await server.stop()
    }
  })
})
