import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { ConversationClient } from './client'
import { servicePaths } from './wire'

export interface RestartConfirmation {
  userData: string
  openConversations: number
  method: 'shutdown' | 'signal'
}

export interface RestartConversationServiceOptions {
  /** The exact selected profile, as passed to ConversationClient.connect. */
  userData: string
  daemonPath?: string
  executablePath?: string
  /** Must show a native confirmation dialog. Only call this helper from an explicit user action. */
  confirm: (info: RestartConfirmation) => Promise<boolean>
  /** Clear the parent's cached connection, including any rejected connection promise. */
  disconnect: () => void | Promise<void>
  /** Connect with the new build after the previous owner has released its resources. */
  reconnect: () => Promise<unknown>
}

export interface RestartPeer {
  getServerInfo(): { protocolVersion: number; pid?: number; capabilities: string[] }
  list(): Promise<{ status: string }[]>
  shutdown(): Promise<void>
  isConnected(): boolean
  disconnect(): void
}

export interface RestartProcessIdentity {
  uid: number
  started: string
  command: string
}

/** Injection points are for tests, not renderer-controlled options. */
export interface RestartDependencies {
  platform: NodeJS.Platform
  uid: number | undefined
  attach: (socket: string, token: string, version: number) => Promise<RestartPeer>
  inspect: (pid: number) => Promise<RestartProcessIdentity | null>
  signal: (pid: number) => void
  resourcesReleased: (socket: string) => Promise<boolean>
  sleep: (ms: number) => Promise<void>
  stopTimeoutMs: number
}

const execFileAsync = promisify(execFile)
const restarting = new Set<string>()

/** Deliberately inspect only the owner PID. Never search all processes or use kill(pid, 0). */
export async function inspectConversationOwner(
  pid: number
): Promise<RestartProcessIdentity | null> {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('Invalid conversation owner PID')
  let stdout: string
  try {
    const result = await execFileAsync(
      '/bin/ps',
      ['-p', String(pid), '-ww', '-o', 'uid=', '-o', 'lstart=', '-o', 'args='],
      { timeout: 2000, maxBuffer: 64 * 1024, env: { ...process.env, LC_ALL: 'C' } }
    )
    stdout = result.stdout
  } catch (error) {
    const failure = error as { code?: number; stdout?: string }
    if (failure.code === 1 && !failure.stdout?.trim()) return null
    throw new Error('Could not verify the conversation owner process')
  }
  const match = stdout.trim().match(/^(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+([^\r\n]+)$/)
  if (!match) throw new Error('Ambiguous conversation owner process')
  return { uid: Number(match[1]), started: match[2], command: match[3] }
}

function socketReleased(socket: string): Promise<boolean> {
  return new Promise((resolve) => {
    const connection = createConnection(socket)
    connection.once('connect', () => {
      connection.destroy()
      resolve(false)
    })
    connection.once('error', (error: NodeJS.ErrnoException) => {
      resolve(error.code === 'ENOENT' || error.code === 'ECONNREFUSED')
    })
    connection.setTimeout(500, () => {
      connection.destroy()
      resolve(false)
    })
  })
}

async function resourcesReleased(socket: string): Promise<boolean> {
  if (!(await socketReleased(socket))) return false
  // Match the daemon's kernel-held election lock, including owners predating owner.port.
  const port = 49152 + (createHash('sha256').update(socket).digest().readUInt16BE(0) % 16384)
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      probe.close(() => resolve(true))
    })
  })
}

const defaults: RestartDependencies = {
  platform: process.platform,
  uid: process.getuid?.(),
  attach: (socket, token, version) => ConversationClient.attach(socket, token, version),
  inspect: inspectConversationOwner,
  signal: (pid) => {
    process.kill(pid, 'SIGTERM')
  },
  resourcesReleased,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  stopTimeoutMs: 8000
}

function privatePath(path: string, directory: boolean, deps: RestartDependencies): void {
  const stat = lstatSync(path)
  if (
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    (deps.platform !== 'win32' && (stat.uid !== deps.uid || (stat.mode & 0o077) !== 0))
  ) {
    throw new Error('Unsafe conversation service ownership metadata')
  }
}

function readOwner(
  directory: string,
  deps: RestartDependencies
): { pid: number; signature: string } {
  privatePath(directory, true, deps)
  const path = join(directory, 'owner.json')
  privatePath(path, false, deps)
  const signature = readFileSync(path, 'utf8')
  const owner = JSON.parse(signature) as { pid?: number }
  if (!Number.isSafeInteger(owner.pid) || owner.pid! <= 1) {
    throw new Error('Invalid conversation owner PID')
  }
  return { pid: owner.pid!, signature }
}

function sameIdentity(a: RestartProcessIdentity, b: RestartProcessIdentity | null): boolean {
  return !!b && a.uid === b.uid && a.started === b.started && a.command === b.command
}

/** Managed service recovery only. This does not touch PTYs, tmux, or detached provider tools. */
export async function restartConversationService(
  options: RestartConversationServiceOptions,
  overrides: Partial<RestartDependencies> = {}
): Promise<boolean> {
  if (!isAbsolute(options.userData)) throw new Error('Select an absolute conversation profile path')
  if (restarting.has(options.userData))
    throw new Error('This conversation service is already restarting')
  restarting.add(options.userData)
  const deps = { ...defaults, ...overrides }
  const paths = servicePaths(options.userData)
  let peer: RestartPeer | undefined
  try {
    privatePath(paths.directory, true, deps)
    privatePath(paths.token, false, deps)
    const token = readFileSync(paths.token, 'utf8')
    for (const version of [2, 1]) {
      try {
        peer = await deps.attach(paths.socket, token, version)
        break
      } catch {
        // Probe only. Never call connect here: it can launch a replacement.
      }
    }
    if (!peer)
      throw new Error(
        'Could not authenticate the selected conversation service. Nothing was stopped.'
      )
    const info = peer.getServerInfo()
    const method = info.capabilities.includes('shutdown') ? 'shutdown' : 'signal'
    let owner: ReturnType<typeof readOwner> | undefined
    let identity: RestartProcessIdentity | undefined
    if (method === 'signal') {
      if (!['darwin', 'linux'].includes(deps.platform) || deps.uid === undefined) {
        throw new Error(
          'This older conversation service cannot be safely restarted on this platform'
        )
      }
      owner = readOwner(paths.directory, deps)
      if (info.pid !== undefined && info.pid !== owner.pid) {
        throw new Error('Conversation owner does not match the authenticated service')
      }
      const candidate = await deps.inspect(owner.pid)
      const daemonPath = options.daemonPath ?? join(__dirname, 'conversation-daemon.js')
      const executablePath = options.executablePath ?? process.execPath
      // ps does not quote argv. Accept only the complete known invocation, never a substring.
      const expected = `${executablePath} ${daemonPath} --conversation-daemon ${options.userData}`
      if (
        !candidate ||
        candidate.uid !== deps.uid ||
        candidate.command !== expected ||
        !candidate.started ||
        /[\r\n]/.test(expected)
      ) {
        throw new Error(
          'Cannot verify the exact conversation daemon and profile. Nothing was stopped.'
        )
      }
      identity = candidate
    }
    const sessions = await peer.list()
    const confirmed = await options.confirm({
      userData: options.userData,
      openConversations: sessions.filter((session) => session.status !== 'closed').length,
      method
    })
    if (!confirmed) return false
    // A successful request proves the original authenticated peer survived the prompt.
    await peer.list()
    if (owner && identity) {
      if (
        readOwner(paths.directory, deps).signature !== owner.signature ||
        !sameIdentity(identity, await deps.inspect(owner.pid))
      ) {
        throw new Error('Conversation owner changed during confirmation. Nothing was stopped.')
      }
    }
    if (!peer.isConnected()) throw new Error('The authenticated conversation service disconnected')
    if (method === 'shutdown') {
      // A lost acknowledgement is not permission to spawn. The release checks below decide.
      void peer.shutdown().catch(() => {})
    } else {
      try {
        deps.signal(owner!.pid)
      } catch {
        throw new Error(
          'Could not stop the verified conversation service. No replacement was started.'
        )
      }
    }
    const deadline = Date.now() + deps.stopTimeoutMs
    let released = false
    do {
      if (!peer.isConnected() && (await deps.resourcesReleased(paths.socket))) {
        // Legacy owners must actually exit, not merely close their socket.
        if (!owner || (await deps.inspect(owner.pid)) === null) {
          released = true
          break
        }
      }
      await deps.sleep(100)
    } while (Date.now() < deadline)
    if (!released) {
      throw new Error(
        'Conversation service has not released its resources. No replacement was started.'
      )
    }
    await options.disconnect()
    try {
      await options.reconnect()
    } catch {
      // Do not leave the parent's rejected connect promise cached. Normal connection can retry.
      await options.disconnect()
      throw new Error(
        'The old conversation service stopped, but the new build could not connect. Retry connecting.'
      )
    }
    return true
  } finally {
    peer?.disconnect()
    restarting.delete(options.userData)
  }
}
