/**
 * The tailnet's machines, and which of them run a Clave server. A machine
 * answers when its liveness route (`/health/live`, no token) does on the
 * server's port at its tailnet address; an offline peer is never asked, and
 * the probes run a few at a time so a large tailnet does not open a socket
 * per machine at once. Nothing here imports Electron.
 */
import http from 'node:http'
import type { TailscaleStatus } from '../tailscale'
import type { TailnetMachine, TailnetScan } from '../../shared/server-setup-types'

const DEFAULT_CONCURRENCY = 8

export async function scanTailnet(opts: {
  status: TailscaleStatus
  port: number
  probe: (url: string) => Promise<boolean>
  concurrency?: number
}): Promise<TailnetScan> {
  const { status, port, probe } = opts
  if (status.backendState !== 'Running') return { available: false, reason: 'not-running' }
  const peers = status.peers.filter(
    (peer): peer is typeof peer & { ip: string } => peer.ip !== null
  )
  const machines: TailnetMachine[] = peers.map((peer) => ({
    name: peer.hostName,
    dnsName: peer.dnsName,
    ip: peer.ip,
    os: peer.os,
    online: peer.online,
    url: `http://${peer.ip}:${port}`,
    claveServer: false
  }))
  const queue = machines.filter((machine) => machine.online)
  const worker = async (): Promise<void> => {
    for (let machine = queue.shift(); machine; machine = queue.shift())
      machine.claveServer = await probe(`${machine.url}/health/live`).catch(() => false)
  }
  const width = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY)
  await Promise.all(Array.from({ length: width }, worker))
  return { available: true, self: { name: status.self.hostName, ip: status.self.ip }, machines }
}

/** Whether `url` answers a GET with a 2xx, its body read whole, within
 *  `timeoutMs` in all: a server that sends its headers and then stalls is as
 *  absent as one that never answers. Never throws. */
export function probeLive(url: string, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    let req: http.ClientRequest | undefined
    const timer = setTimeout(() => {
      req?.destroy()
      done(false)
    }, timeoutMs)
    timer.unref()
    const done = (value: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      done(false)
      return
    }
    if (parsed.protocol !== 'http:') {
      done(false)
      return
    }
    try {
      req = http.get(parsed, { timeout: timeoutMs }, (res) => {
        const ok = (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300
        res.resume()
        res.once('end', () => done(ok))
        res.once('error', () => done(false))
      })
      req.once('timeout', () => {
        req?.destroy()
        done(false)
      })
      req.once('error', () => done(false))
    } catch {
      done(false)
    }
  })
}
