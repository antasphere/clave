/**
 * The desktop side of the phone's road (PRDCT-4448): the machine id a paired
 * phone reaches this server under is minted once into its own document,
 * owner-only, and read back the same after a restart; a document that
 * cannot be read refuses the road instead of minting a second id.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installSettingsPorts, resetSettingsPorts } from '../ports/registry'
import type { SecretPort } from '../ports/secrets'
import { fileStorage } from '../ports/storage'
import type { AntasphereAccountStatus } from '../../shared/antasphere-account-types'
import {
  PHONE_ROAD_DOCUMENT,
  accountDevicesPort,
  devicesPortFor,
  phoneRoadMachineId
} from './devices-port'

let dir: string
/** A signed-in login as the port reads it: the phase and the subject are all it uses. */
const signedIn = (): AntasphereAccountStatus =>
  ({
    phase: 'signed-in',
    account: { subject: 'owner-subject' }
  }) as unknown as AntasphereAccountStatus

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'clave-devices-port-'))
  installSettingsPorts({ storage: fileStorage(dir), secrets: {} as SecretPort })
})
afterEach(() => {
  resetSettingsPorts()
  rmSync(dir, { recursive: true, force: true })
})

describe('the phone road machine id', () => {
  it('is minted once, owner-only, and the same at every later read', () => {
    const first = phoneRoadMachineId()
    expect(first).toMatch(/^m_[0-9a-f]{32}$/)
    const file = join(dir, PHONE_ROAD_DOCUMENT)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ v: 1, machineId: first })
    expect(phoneRoadMachineId()).toBe(first)
  })

  it('survives a restart: a new port over the same data reads the same id', () => {
    const before = devicesPortFor({ status: signedIn, version: '1.2.3' }).road!.machineId()
    resetSettingsPorts()
    installSettingsPorts({ storage: fileStorage(dir), secrets: {} as SecretPort })
    const after = devicesPortFor({ status: signedIn, version: '1.2.3' }).road!.machineId()
    expect(after).toBe(before)
  })

  it('refuses a document that holds no id, and mints no second one', () => {
    const file = join(dir, PHONE_ROAD_DOCUMENT)
    writeFileSync(file, JSON.stringify({ v: 1, machineId: 'not-an-id' }), { mode: 0o600 })
    expect(() => phoneRoadMachineId()).toThrow('holds no machine id')
    writeFileSync(file, '{ truncated', { mode: 0o600 })
    expect(() => phoneRoadMachineId()).toThrow()
    expect(readFileSync(file, 'utf8')).toBe('{ truncated')
  })

  it('refuses a document it cannot read at all', () => {
    mkdirSync(join(dir, PHONE_ROAD_DOCUMENT))
    expect(() => phoneRoadMachineId()).toThrow()
  })
})

describe('the devices port the entries build', () => {
  it('has no road without a version, and one with it', () => {
    expect(devicesPortFor({ status: signedIn }).road).toBeUndefined()
    const port = devicesPortFor({ status: signedIn, version: '3.0.0' })
    expect(port.road).toMatchObject({
      version: '3.0.0',
      platform:
        process.platform === 'darwin' ? 'macos' : process.platform === 'linux' ? 'linux' : 'unknown'
    })
    expect(port.road!.machineId()).toBe(port.road!.machineId())
  })

  it('reads the owner from the login, and no owner from anything but a signed-in one', async () => {
    expect(await devicesPortFor({ status: signedIn }).owner()).toBe('owner-subject')
    expect(
      await devicesPortFor({
        status: () => ({ phase: 'signed-out', account: null }) as never
      }).owner()
    ).toBeNull()
    expect(
      await devicesPortFor({
        status: () => {
          throw new Error('no manager')
        }
      }).owner()
    ).toBeNull()
  })
})

/** An account manager as the port reads one: the status now, and every change told. */
function fakeAccount(initial: AntasphereAccountStatus): {
  account: {
    status: () => AntasphereAccountStatus
    onChange: (listener: (status: AntasphereAccountStatus) => void) => () => void
  }
  set: (status: AntasphereAccountStatus) => void
  listeners: Set<(status: AntasphereAccountStatus) => void>
} {
  let status = initial
  const listeners = new Set<(status: AntasphereAccountStatus) => void>()
  return {
    account: {
      status: () => status,
      onChange: (listener) => {
        listeners.add(listener)
        return () => void listeners.delete(listener)
      }
    },
    set: (next) => {
      status = next
      for (const listener of [...listeners]) listener(next)
    },
    listeners
  }
}

describe('the devices port over an Antasphere account (PRDCT-4448)', () => {
  it('reads the owner at once and tells every change of it as the account manager says it', () => {
    const fake = fakeAccount(signedIn())
    const port = accountDevicesPort(fake.account)
    expect(port.ownerNow?.()).toBe('owner-subject')
    expect(port.owner()).toBe('owner-subject')
    const told: Array<string | null> = []
    const off = port.onOwnerChanged!((owner) => told.push(owner))
    fake.set({ phase: 'signed-out', account: null } as never)
    expect(port.ownerNow?.()).toBeNull()
    // A login in flight is nobody's yet, whatever account it carries.
    fake.set({ phase: 'signing-in', account: { subject: 'owner-subject' } } as never)
    fake.set(signedIn())
    expect(told).toEqual([null, null, 'owner-subject'])
    off()
    expect(fake.listeners.size).toBe(0)
  })

  it('reads no owner and tells nothing without an account manager, or with one that throws', () => {
    const none = accountDevicesPort(null)
    expect(none.ownerNow?.()).toBeNull()
    expect(none.owner()).toBeNull()
    none.onOwnerChanged!(() => {
      throw new Error('never told')
    })()
    const broken = accountDevicesPort({
      status: () => {
        throw new Error('no session store')
      },
      onChange: () => () => {}
    })
    expect(broken.ownerNow?.()).toBeNull()
  })

  it('keeps a failing listener of its own from taking the word away from the manager’s other listeners', () => {
    const fake = fakeAccount(signedIn())
    const port = accountDevicesPort(fake.account)
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    const others: string[] = []
    port.onOwnerChanged!(() => {
      throw new Error('a listener that fails')
    })
    fake.account.onChange((status) => others.push(status.phase))
    fake.set({ phase: 'signed-out', account: null } as never)
    expect(others).toEqual(['signed-out'])
    expect(quiet).toHaveBeenCalled()
    quiet.mockRestore()
  })

  it('puts the version on the road it builds, and builds none without one', () => {
    expect(accountDevicesPort(null, { version: '3.1.4' }).road?.version).toBe('3.1.4')
    expect(accountDevicesPort(null).road).toBeUndefined()
  })
})
