/**
 * The machines the relay knows: one row per claimed credential, the secret
 * kept as a SHA-256 and never in clear, bound to the owner's subject, with
 * the record the machine last presented and when it was last heard from.
 * `machines.json` under the data directory, mode 0600 in a 0700 directory,
 * written whole by rename so a kill mid-write never leaves a torn file.
 * A file that is there but unreadable fails the start: a relay that came up
 * on an empty directory would have every machine claim anew and every phone
 * see none, and look fine.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { MachineRecord } from '@clave/contract/relay'

export interface StoredMachine {
  readonly id: string
  readonly secretHash: string
  readonly owner: string
  readonly record: MachineRecord
  readonly created: number
  readonly lastSeen: number | null
}

interface MachinesFile {
  v: 1
  machines: StoredMachine[]
}

export const MACHINES_FILE = 'machines.json'
/** Ids and secrets wear a prefix, so a secret that leaked into a log or a
 *  file can be found by looking for it. */
export const MACHINE_ID_PREFIX = 'm_'
export const MACHINE_SECRET_PREFIX = 'cms_'

export const secretHashOf = (secret: string): string =>
  createHash('sha256').update(secret).digest('hex')

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const readMachine = (value: unknown): StoredMachine | null => {
  if (!isRecord(value)) return null
  if (typeof value.id !== 'string' || typeof value.secretHash !== 'string') return null
  if (typeof value.owner !== 'string' || !isRecord(value.record)) return null
  const record = value.record
  if (typeof record.name !== 'string' || typeof record.version !== 'string') return null
  if (record.platform !== 'macos' && record.platform !== 'linux') return null
  if (!Array.isArray(record.direct)) return null
  const direct = record.direct.filter(
    (d): d is { url: string } => isRecord(d) && typeof d.url === 'string'
  )
  return {
    id: value.id,
    secretHash: value.secretHash,
    owner: value.owner,
    record: { name: record.name, platform: record.platform, version: record.version, direct },
    created: typeof value.created === 'number' ? value.created : 0,
    lastSeen: typeof value.lastSeen === 'number' ? value.lastSeen : null
  }
}

export class MachineRegistry {
  private readonly machines = new Map<string, StoredMachine>()
  private readonly file: string

  private constructor(
    dataDir: string,
    private readonly now: () => number
  ) {
    this.file = path.join(dataDir, MACHINES_FILE)
  }

  /** Open the registry on `dataDir`, creating the directory private. */
  static open(dataDir: string, now: () => number = () => Date.now()): MachineRegistry {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    const registry = new MachineRegistry(dataDir, now)
    let text: string | null
    try {
      text = fs.readFileSync(registry.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      text = null
    }
    if (text !== null) {
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        throw new Error(`${registry.file} is not JSON`)
      }
      if (!isRecord(parsed) || parsed.v !== 1 || !Array.isArray(parsed.machines))
        throw new Error(`${registry.file} is not a machines file`)
      for (const row of parsed.machines) {
        const machine = readMachine(row)
        if (!machine) throw new Error(`${registry.file} holds a machine row that cannot be read`)
        registry.machines.set(machine.id, machine)
      }
    }
    return registry
  }

  get size(): number {
    return this.machines.size
  }

  get(id: string): StoredMachine | undefined {
    return this.machines.get(id)
  }

  /** A new credential for `owner`; the secret is answered once and kept hashed. */
  claim(owner: string, record: MachineRecord): { machineId: string; machineSecret: string } {
    let machineId: string
    do machineId = `${MACHINE_ID_PREFIX}${randomBytes(8).toString('hex')}`
    while (this.machines.has(machineId))
    const machineSecret = `${MACHINE_SECRET_PREFIX}${randomBytes(24).toString('hex')}`
    this.machines.set(machineId, {
      id: machineId,
      secretHash: secretHashOf(machineSecret),
      owner,
      record,
      created: this.now(),
      lastSeen: null
    })
    this.write()
    return { machineId, machineSecret }
  }

  /** The machine the credential names, or null: an unknown id, or a secret
   *  that does not hash to the stored one (compared in constant time). */
  verify(machineId: string, machineSecret: string): StoredMachine | null {
    const machine = this.machines.get(machineId)
    if (!machine) return null
    const presented = Buffer.from(secretHashOf(machineSecret), 'hex')
    const stored = Buffer.from(machine.secretHash, 'hex')
    if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) return null
    return machine
  }

  /** The record refreshed and the machine heard from now. */
  touch(machineId: string, record?: MachineRecord): void {
    const machine = this.machines.get(machineId)
    if (!machine) return
    this.machines.set(machineId, {
      ...machine,
      record: record ?? machine.record,
      lastSeen: this.now()
    })
    this.write()
  }

  list(owner: string): StoredMachine[] {
    return [...this.machines.values()].filter((m) => m.owner === owner)
  }

  /** Drop a machine of `owner`; another owner's is not there to drop. */
  forget(owner: string, machineId: string): boolean {
    const machine = this.machines.get(machineId)
    if (!machine || machine.owner !== owner) return false
    this.machines.delete(machineId)
    this.write()
    return true
  }

  private write(): void {
    const file: MachinesFile = { v: 1, machines: [...this.machines.values()] }
    const tmp = `${this.file}.tmp`
    fs.rmSync(tmp, { force: true })
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, this.file)
    fs.chmodSync(this.file, 0o600)
  }
}
