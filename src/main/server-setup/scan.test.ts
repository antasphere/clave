import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { probeLive, scanTailnet } from './scan'
import type { TailscaleStatus } from '../tailscale'

const peer = (
  id: string,
  ip: string | null,
  online: boolean
): TailscaleStatus['peers'][number] => ({
  id,
  hostName: id,
  dnsName: `${id}.example-tailnet.ts.net`,
  ip,
  os: 'linux',
  online
})

const STATUS: TailscaleStatus = {
  backendState: 'Running',
  self: {
    hostName: 'desk-laptop',
    dnsName: 'desk-laptop.example-tailnet.ts.net',
    ip: '100.64.0.1'
  },
  peers: [
    peer('studio-mini', '100.64.0.2', true),
    peer('build-box', '100.64.0.3', true),
    peer('no-ipv4', null, true),
    peer('sleeping', '100.64.0.4', false)
  ]
}

describe('scanTailnet', () => {
  it('probes the online peers on the port and flags the servers', async () => {
    const probed: string[] = []
    const scan = await scanTailnet({
      status: STATUS,
      port: 43127,
      probe: async (url) => {
        probed.push(url)
        return url.startsWith('http://100.64.0.2:')
      }
    })
    expect(probed.sort()).toEqual([
      'http://100.64.0.2:43127/health/live',
      'http://100.64.0.3:43127/health/live'
    ])
    expect(scan).toEqual({
      available: true,
      self: { name: 'desk-laptop', ip: '100.64.0.1' },
      machines: [
        expect.objectContaining({
          name: 'studio-mini',
          url: 'http://100.64.0.2:43127',
          claveServer: true
        }),
        expect.objectContaining({ name: 'build-box', claveServer: false, online: true }),
        // Listed, never probed, never picked: no address to reach it on.
        expect.objectContaining({ name: 'no-ipv4', ip: '', url: '', claveServer: false }),
        expect.objectContaining({ name: 'sleeping', claveServer: false, online: false })
      ]
    })
  })

  it('keeps the probes in flight under the limit', async () => {
    const many: TailscaleStatus = {
      ...STATUS,
      peers: Array.from({ length: 20 }, (_, i) => peer(`m${i}`, `100.64.1.${i}`, true))
    }
    let inFlight = 0
    let most = 0
    const scan = await scanTailnet({
      status: many,
      port: 4000,
      probe: async () => {
        most = Math.max(most, ++inFlight)
        await new Promise((r) => setTimeout(r, 5))
        inFlight--
        return true
      }
    })
    expect(most).toBe(8)
    expect(scan.available && scan.machines.map((m) => m.name)).toEqual(many.peers.map((p) => p.id))
  })

  it('answers not-running while Tailscale is down, without probing', async () => {
    let calls = 0
    const scan = await scanTailnet({
      status: { ...STATUS, backendState: 'Stopped' },
      port: 1,
      probe: async () => (calls++, true)
    })
    expect(scan).toEqual({ available: false, reason: 'not-running' })
    expect(calls).toBe(0)
  })
})

describe('probeLive', () => {
  let server: http.Server
  let base = ''
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/ok') res.end('{"status":"live","checks":{}}')
      else if (req.url === '/imposter') res.end('hello')
      else if (req.url === '/dead') res.end('{"status":"down"}')
      else if (req.url === '/stall') res.writeHead(200).write('x')
      else res.writeHead(404).end()
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => {
    server.closeAllConnections()
    server.close()
  })

  it("is true on a 2xx whose body is the server's own liveness answer only", async () => {
    expect(await probeLive(`${base}/ok`)).toBe(true)
    expect(await probeLive(`${base}/imposter`)).toBe(false)
    expect(await probeLive(`${base}/dead`)).toBe(false)
    expect(await probeLive(`${base}/missing`)).toBe(false)
    expect(await probeLive('not a url')).toBe(false)
    expect(await probeLive(`${base}/stall`, 200)).toBe(false)
  })
})
