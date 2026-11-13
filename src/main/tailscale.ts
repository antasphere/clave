/**
 * Tailscale as Clave reads it: where the CLI is, and what `tailscale status
 * --json` says about this machine and its peers. A Mac set up as a server
 * listens on its tailnet address, and the Servers page lists the tailnet's
 * other machines, so both read the same status here.
 *
 * The CLI is looked for on the login shell's PATH first (a packaged app's own
 * PATH is the minimal one, AGENTS.md's PATH rule), then where the Mac app and
 * Homebrew put it. The parsing is pure and never throws on a field it does
 * not find: the status shape is Tailscale's, not ours, and a peer with an odd
 * record is still a peer. Nothing here imports Electron.
 */
import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'
import { getLoginShellEnv } from './sessions/adapters/pty-backend'

/** Where the Mac app keeps its CLI, outside any PATH. */
const MAC_APP_BINARY = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
const USR_LOCAL_BINARY = '/usr/local/bin/tailscale'

export function findTailscaleBinary(opts: {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  executable: (path: string) => boolean
}): string | null {
  for (const dir of (opts.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, 'tailscale')
    if (opts.executable(candidate)) return candidate
  }
  if (opts.platform === 'darwin' && opts.executable(MAC_APP_BINARY)) return MAC_APP_BINARY
  if (opts.executable(USR_LOCAL_BINARY)) return USR_LOCAL_BINARY
  return null
}

export interface TailscaleStatus {
  backendState: string
  self: { hostName: string; dnsName: string; ip: string | null }
  peers: Array<{
    id: string
    hostName: string
    dnsName: string
    ip: string | null
    os: string
    online: boolean
  }>
}

const IPV4 = /^\d+\.\d+\.\d+\.\d+$/

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

function firstIPv4(value: unknown): string | null {
  if (!Array.isArray(value)) return null
  const found = value.find((ip): ip is string => typeof ip === 'string' && IPV4.test(ip))
  return found ?? null
}

/** A node's names: the DNS name without its trailing dot, and the host name,
 *  or the DNS name's first label when the node gives none. */
function names(node: Record<string, unknown> | null): { hostName: string; dnsName: string } {
  const dnsName = text(node?.DNSName).replace(/\.$/, '')
  const hostName = text(node?.HostName) || dnsName.split('.')[0] || ''
  return { hostName, dnsName }
}

export function parseTailscaleStatus(json: unknown): TailscaleStatus {
  const root = record(json)
  const self = record(root?.Self)
  const peerMap = record(root?.Peer)
  const peers = Object.values(peerMap ?? {})
    .map((value) => record(value))
    .filter((node): node is Record<string, unknown> => node !== null)
    .map((node) => ({
      id: text(node.ID),
      ...names(node),
      ip: firstIPv4(node.TailscaleIPs),
      os: text(node.OS),
      online: node.Online === true
    }))
    .sort((a, b) =>
      a.online === b.online ? a.hostName.localeCompare(b.hostName) : a.online ? -1 : 1
    )
  return {
    backendState: text(root?.BackendState),
    self: { ...names(self), ip: firstIPv4(self?.TailscaleIPs) },
    peers
  }
}

const STATUS_TIMEOUT_MS = 5000
const STATUS_MAX_BUFFER = 4 * 1024 * 1024

function execStatus(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: STATUS_TIMEOUT_MS, maxBuffer: STATUS_MAX_BUFFER, encoding: 'utf8' },
      (error, stdout) => (error ? reject(error) : resolve(stdout))
    )
  })
}

/** The status the CLI reports; rejects when it exits non-zero or prints no JSON. */
export async function readTailscaleStatus(opts: {
  binary: string
  exec?: (file: string, args: string[]) => Promise<string>
}): Promise<TailscaleStatus> {
  const out = await (opts.exec ?? execStatus)(opts.binary, ['status', '--json'])
  return parseTailscaleStatus(JSON.parse(out))
}

/** This machine's tailnet IPv4 while Tailscale is up, else null. */
export async function tailscaleIPv4(opts: {
  binary: string
  exec?: (file: string, args: string[]) => Promise<string>
}): Promise<string | null> {
  const status = await readTailscaleStatus(opts)
  return status.backendState === 'Running' ? status.self.ip : null
}

/** The CLI on this machine, looked for on the login shell's PATH. */
export function defaultTailscaleBinary(): string | null {
  return findTailscaleBinary({
    env: { ...process.env, PATH: getLoginShellEnv().PATH ?? process.env.PATH },
    platform: process.platform,
    executable: (path) => {
      try {
        accessSync(path, constants.X_OK)
        return true
      } catch {
        return false
      }
    }
  })
}
