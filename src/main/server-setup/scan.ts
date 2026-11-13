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
  // A peer with no IPv4 address is listed, never probed and never picked:
  // a Clave server listens on its tailnet IPv4 (`tailscale ip -4`).
  const machines: TailnetMachine[] = status.peers.map((peer) => ({
    name: peer.hostName,
    dnsName: peer.dnsName,
    ip: peer.ip ?? '',
    os: peer.os,
    online: peer.online,
    url: peer.ip ? `http://${peer.ip}:${port}` : '',
    claveServer: false
  }))
  const queue = machines.filter((machine) => machine.online && machine.url)
  const worker = async (): Promise<void> => {
    for (let machine = queue.shift(); machine; machine = queue.shift())
      machine.claveServer = await probe(`${machine.url}/health/live`).catch(() => false)
  }
  const width = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY)
  await Promise.all(Array.from({ length: width }, worker))
  return { available: true, self: { name: status.self.hostName, ip: status.self.ip }, machines }
}

/** The most of a liveness answer that is read; a Clave server's is a few bytes. */
const LIVE_BODY_BYTES = 4096

/** Whether `url` answers a GET with a 2xx whose JSON body says `status:
 *  "live"`, the server's own liveness answer, within `timeoutMs` in all:
 *  any other service on the port, or a server that sends its headers and
 *  then stalls, is as absent as one that never answers. Never throws. */
function saysLive(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body)
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { status?: unknown }).status === 'live'
    )
  } catch {
    return false
  }
}

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
        let body = ''
        res.on('data', (chunk: Buffer) => {
          if (body.length < LIVE_BODY_BYTES) body += chunk.toString('utf8', 0, LIVE_BODY_BYTES)
        })
        res.once('end', () => done(ok && saysLive(body)))
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
