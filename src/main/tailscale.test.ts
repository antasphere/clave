import { describe, expect, it } from 'vitest'
import {
  findTailscaleBinary,
  parseTailscaleStatus,
  readTailscaleStatus,
  tailscaleIPv4
} from './tailscale'

const STATUS = {
  BackendState: 'Running',
  Self: {
    ID: 'self-id',
    HostName: 'desk-laptop',
    DNSName: 'desk-laptop.example-tailnet.ts.net.',
    OS: 'macOS',
    Online: true,
    TailscaleIPs: ['fd7a:115c:a1e0::1', '100.64.0.1']
  },
  Peer: {
    'nodekey:b': {
      ID: 'b',
      HostName: 'studio-mini',
      DNSName: 'studio-mini.example-tailnet.ts.net.',
      OS: 'macOS',
      Online: true,
      TailscaleIPs: ['100.64.0.2', 'fd7a:115c:a1e0::2']
    },
    'nodekey:c': {
      ID: 'c',
      HostName: 'build-box',
      DNSName: 'build-box.example-tailnet.ts.net.',
      OS: 'linux',
      Online: false,
      TailscaleIPs: ['100.64.0.3']
    },
    'nodekey:a': {
      ID: 'a',
      DNSName: 'attic-pi.example-tailnet.ts.net.',
      OS: 'linux',
      Online: true,
      TailscaleIPs: ['fd7a:115c:a1e0::4']
    },
    'nodekey:junk': 'not a node'
  }
}

describe('findTailscaleBinary', () => {
  it('takes the first tailscale on PATH', () => {
    const found = findTailscaleBinary({
      env: { PATH: '/opt/a:/opt/b' },
      platform: 'darwin',
      executable: (p) => p === '/opt/b/tailscale' || p === '/usr/local/bin/tailscale'
    })
    expect(found).toBe('/opt/b/tailscale')
  })

  it('falls back to the Mac app, then /usr/local/bin', () => {
    expect(findTailscaleBinary({ env: {}, platform: 'darwin', executable: () => true })).toBe(
      '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
    )
    expect(
      findTailscaleBinary({
        env: { PATH: '' },
        platform: 'linux',
        executable: (p) => p === '/usr/local/bin/tailscale' || p.startsWith('/Applications')
      })
    ).toBe('/usr/local/bin/tailscale')
  })

  it('answers null when there is none', () => {
    expect(
      findTailscaleBinary({ env: { PATH: '/x' }, platform: 'darwin', executable: () => false })
    ).toBeNull()
  })
})

describe('parseTailscaleStatus', () => {
  it('reads self and the peers, online first then by name', () => {
    const status = parseTailscaleStatus(STATUS)
    expect(status.backendState).toBe('Running')
    expect(status.self).toEqual({
      hostName: 'desk-laptop',
      dnsName: 'desk-laptop.example-tailnet.ts.net',
      ip: '100.64.0.1'
    })
    expect(status.peers.map((p) => p.hostName)).toEqual(['attic-pi', 'studio-mini', 'build-box'])
    expect(status.peers[1]).toEqual({
      id: 'b',
      hostName: 'studio-mini',
      dnsName: 'studio-mini.example-tailnet.ts.net',
      ip: '100.64.0.2',
      os: 'macOS',
      online: true
    })
    expect(status.peers[0].ip).toBeNull()
    expect(status.peers[2].online).toBe(false)
  })

  it('never throws on a malformed status', () => {
    for (const input of [null, 42, 'x', [], { Peer: [] }, { Peer: 'x', Self: 3 }]) {
      const status = parseTailscaleStatus(input)
      expect(status.peers).toEqual([])
      expect(status.self.ip).toBeNull()
    }
  })
})

describe('readTailscaleStatus', () => {
  it('runs status --json and parses it', async () => {
    const calls: string[][] = []
    const exec = async (file: string, args: string[]): Promise<string> => {
      calls.push([file, ...args])
      return JSON.stringify(STATUS)
    }
    const status = await readTailscaleStatus({ binary: '/bin/tailscale', exec })
    expect(calls).toEqual([['/bin/tailscale', 'status', '--json']])
    expect(status.peers).toHaveLength(3)
    expect(await tailscaleIPv4({ binary: '/bin/tailscale', exec })).toBe('100.64.0.1')
  })

  it('has no ip while Tailscale is stopped, and rejects a failed run', async () => {
    const stopped = async (): Promise<string> =>
      JSON.stringify({ ...STATUS, BackendState: 'Stopped' })
    expect(await tailscaleIPv4({ binary: 't', exec: stopped })).toBeNull()
    const failing = async (): Promise<string> => {
      throw new Error('exit 1')
    }
    await expect(readTailscaleStatus({ binary: 't', exec: failing })).rejects.toThrow()
  })
})
