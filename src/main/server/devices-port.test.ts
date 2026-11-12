/**
 * The desktop side of the phone's road (PRDCT-4448): the machine id a paired
 * phone reaches this server under is minted once into its own document,
 * owner-only, and read back the same after a restart; a document that
 * cannot be read refuses the road instead of minting a second id.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installSettingsPorts, resetSettingsPorts } from '../ports/registry'
import type { SecretPort } from '../ports/secrets'
import { fileStorage } from '../ports/storage'
import type { AntasphereAccountStatus } from '../../shared/antasphere-account-types'
import { PHONE_ROAD_DOCUMENT, devicesPortFor, phoneRoadMachineId } from './devices-port'

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
