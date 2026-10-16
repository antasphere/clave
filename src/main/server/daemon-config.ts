import { randomBytes, randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { normalizeListenHost } from '../../../packages/server/src/listen-host'
import { readFileSync, readdirSync, renameSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
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

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const CLAIM_NAME = new RegExp(`^(${UUID})_([1-9][0-9]*)_(${UUID})\\.claim$`)
let bootId: string | undefined

/** Kernel boot identity must be stable even when the wall clock changes. */
function daemonBootId(): string {
  if (bootId) return bootId
  const value = (
    process.platform === 'linux'
      ? readFileSync('/proc/sys/kernel/random/boot_id', 'utf8')
      : process.platform === 'darwin'
        ? execFileSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], {
            encoding: 'utf8',
            timeout: 5000
          })
        : ''
  )
    .trim()
    .toLowerCase()
  if (!new RegExp(`^${UUID}$`).test(value))
    throw new Error('A kernel boot identifier is required for daemon ownership')
  bootId = value
  return value
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

function removeMissingOk(file: string): void {
  try {
    unlinkSync(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/** Publish before scanning and retain the immutable claim until release completes.
 *  If two transactions overlap, at least the later publisher sees the earlier
 *  live claim and aborts. Dead claims have unique names and can never be reused. */
export function acquireDaemonLease(dataDir: string): () => void {
  const directory = join(resolve(dataDir), 'daemon')
  privateDirectory(directory)
  const claims = join(directory, 'process-claims')
  privateDirectory(claims)
  const boot = daemonBootId()
  const claimId = randomUUID()
  const claim = join(claims, `${boot}_${process.pid}_${claimId}.claim`)
  const pending = join(directory, `${claimId}.pending`)
  const file = join(directory, 'process.json')
  // The filename contains all liveness information, even if killed before close/write.
  createPrivateFile(claim, '')
  try {
    for (const name of readdirSync(claims)) {
      const other = join(claims, name)
      if (other === claim) continue
      const match = CLAIM_NAME.exec(name)
      if (!match || !Number.isSafeInteger(Number(match[2])))
        throw new Error('Invalid daemon ownership claim')
      if (match[1] === boot && alive(Number(match[2])))
        throw new Error('Another daemon already owns or is claiming this data directory')
      // Never unlink a shared guard pathname: this exact attempt can never be revived.
      removeMissingOk(other)
      removeMissingOk(join(directory, `${match[3]}.pending`))
    }
    let previous: { pid?: number; bootId?: string } | undefined
    try {
      previous = JSON.parse(readPrivateFile(file).toString('utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (previous !== undefined) {
      if (
        !previous ||
        !previous.pid ||
        !Number.isSafeInteger(previous.pid) ||
        previous.pid < 1 ||
        (previous.bootId !== undefined && !new RegExp(`^${UUID}$`).test(previous.bootId))
      )
        throw new Error('Invalid daemon process lease')
      // Legacy PID-only leases stay conservative when a PID was reused.
      if ((previous.bootId === undefined || previous.bootId === boot) && alive(previous.pid))
        throw new Error('Another daemon already owns this data directory')
    }
    createPrivateFile(pending, JSON.stringify({ pid: process.pid, claimId, bootId: boot }))
    // A killed writer can leave a partial pending file, never partial published JSON.
    renameSync(pending, file)
  } catch (error) {
    removeMissingOk(claim)
    removeMissingOk(pending)
    throw error
  }
  let released = false
  return () => {
    if (released) return
    try {
      let current: { pid?: number; claimId?: string } | undefined
      try {
        current = JSON.parse(readPrivateFile(file).toString('utf8'))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (current?.pid === process.pid && current.claimId === claimId) removeMissingOk(file)
      // Keep the live claim throughout all shared state changes, including release.
      removeMissingOk(claim)
      released = true
    } catch {
      /* Retain the claim on cleanup failure. It becomes reclaimable on process exit. */
    }
  }
}
