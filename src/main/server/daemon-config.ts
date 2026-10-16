import { randomBytes, randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { normalizeListenHost } from '../../../packages/server/src/listen-host'
import { unlinkSync } from 'node:fs'
import { privateDirectory, createPrivateFile, readPrivateFile } from '../ports/private-files'

export interface DaemonConfig {
  daemon: boolean
  host: string
}

/** Legacy app children retain their handshake and parent watchdog. */
export function daemonConfig(argv: readonly string[]): DaemonConfig {
  const daemon = argv.includes('--daemon')
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`)
    if (index !== -1) {
      const next = argv[index + 1]
      if (!next || next.startsWith('--')) throw new Error(`--${name} needs a value`)
      return next
    }
    return argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
  }
  if (daemon && value('parent') !== undefined) throw new Error('--daemon cannot use --parent')
  if (daemon && value('token') !== undefined)
    throw new Error('Use --token-file for a daemon credential')
  const host = normalizeListenHost(value('host') ?? '127.0.0.1')
  if (!daemon && host !== '127.0.0.1') throw new Error('--host requires --daemon')
  return { daemon, host }
}

export interface DaemonIdentity {
  serverId: string
  token: string
}

/** Missing state is initialized once. Corrupt/insecure existing state fails closed. */
export function daemonIdentity(dataDir: string, tokenFile?: string): DaemonIdentity {
  privateDirectory(resolve(dataDir))
  const directory = join(resolve(dataDir), 'daemon')
  privateDirectory(directory)
  const file = join(directory, 'identity.json')
  const supplied = tokenFile ? readPrivateFile(tokenFile).toString('utf8').trim() : undefined
  if (supplied !== undefined && !/^[\x21-\x7e]{32,4096}$/.test(supplied)) {
    throw new Error('The daemon token file must hold 32..4096 printable non-space characters')
  }
  let state: unknown
  try {
    state = JSON.parse(readPrivateFile(file).toString('utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new Error('Cannot read private daemon identity')
    state = { serverId: randomUUID(), token: supplied ?? randomBytes(32).toString('hex') }
    createPrivateFile(file, JSON.stringify(state))
  }
  const identity = state as Partial<DaemonIdentity> | null
  if (
    !identity ||
    typeof identity.serverId !== 'string' ||
    !/^[0-9a-f-]{36}$/.test(identity.serverId) ||
    typeof identity.token !== 'string' ||
    !/^[\x21-\x7e]{32,4096}$/.test(identity.token)
  ) {
    throw new Error('Invalid private daemon identity')
  }
  if (supplied !== undefined && identity.token !== supplied) {
    throw new Error('The supplied token differs from the saved daemon credential')
  }
  return { serverId: identity.serverId, token: identity.token }
}

/** The short lease transaction must never reclaim its own guard automatically:
 *  an interrupted transaction requires operator inspection rather than split ownership. */
function withLeaseGuard(directory: string, operation: () => void): void {
  const guard = join(directory, 'process.guard')
  try {
    createPrivateFile(guard, JSON.stringify({ pid: process.pid }))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(
        'Daemon lease transaction already in progress; inspect process.guard if startup crashed'
      )
    }
    throw error
  }
  try {
    operation()
  } finally {
    unlinkSync(guard)
  }
}

/** One writer for one data directory. A stale lease after a crash is reclaimed. */
export function acquireDaemonLease(dataDir: string): () => void {
  const directory = join(resolve(dataDir), 'daemon')
  privateDirectory(directory)
  const file = join(directory, 'process.json')
  const claimId = randomUUID()
  const claim = (): void => createPrivateFile(file, JSON.stringify({ pid: process.pid, claimId }))
  withLeaseGuard(directory, () => {
    try {
      claim()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const previous = JSON.parse(readPrivateFile(file).toString('utf8')) as { pid?: number }
      if (!previous.pid || !Number.isSafeInteger(previous.pid) || previous.pid < 1)
        throw new Error('Invalid daemon process lease')
      try {
        process.kill(previous.pid, 0)
        throw new Error('Another daemon already owns this data directory')
      } catch (reason) {
        if ((reason as NodeJS.ErrnoException).code !== 'ESRCH') throw reason
      }
      unlinkSync(file)
      claim()
    }
  })
  return () => {
    try {
      withLeaseGuard(directory, () => {
        const current = JSON.parse(readPrivateFile(file).toString('utf8')) as {
          pid?: number
          claimId?: string
        }
        if (current.pid === process.pid && current.claimId === claimId) unlinkSync(file)
      })
    } catch {
      /* Busy transactions or an already released lease remain safe to reclaim after exit. */
    }
  }
}
