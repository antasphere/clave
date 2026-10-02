import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  installSettingsPorts,
  lazySettingsPorts,
  resetSettingsPorts,
  settingsPorts
} from './registry'
import { electronTestPorts, standaloneTestPorts } from './testing'
import { dataDirFromEnv, standalonePorts, DATA_DIR_ENV } from './standalone'

/**
 * The registry is how a manager built at import time finds its ports at
 * first use. Outside Electron with nothing installed it must refuse loudly:
 * a server that quietly read an empty folder would list no accounts and
 * look healthy.
 */
describe('the settings ports registry', () => {
  beforeEach(() => resetSettingsPorts())
  afterEach(() => resetSettingsPorts())

  it('throws, naming the fix, when nothing is installed outside Electron', () => {
    expect(process.versions.electron).toBeUndefined()
    expect(() => settingsPorts()).toThrow(/installSettingsPorts/)
    expect(() => lazySettingsPorts.storage).toThrow(/installSettingsPorts/)
  })

  it('answers the installed ports, and the lazy ports follow a swap', () => {
    const a = electronTestPorts()
    const b = standaloneTestPorts()
    installSettingsPorts(a)
    expect(settingsPorts()).toBe(a)
    lazySettingsPorts.storage.write('x.json', '1')
    expect(a.storage.read('x.json')).toBe('1')
    installSettingsPorts(b)
    expect(lazySettingsPorts.storage.read('x.json')).toBeNull()
    expect(lazySettingsPorts.secrets).toBe(b.secrets)
  })
})

describe('the standalone composition', () => {
  it('takes its data directory from the environment, or nothing', () => {
    expect(dataDirFromEnv({})).toBeUndefined()
    expect(dataDirFromEnv({ [DATA_DIR_ENV]: '  ' })).toBeUndefined()
    expect(dataDirFromEnv({ [DATA_DIR_ENV]: '/srv/clave' })).toBe('/srv/clave')
  })

  it('files documents under the given directory and seals through the Keychain', () => {
    const ports = standalonePorts({ dataDir: '/srv/clave' })
    expect(ports.storage.pathOf('a.json')).toBe('/srv/clave/a.json')
    // Availability follows the platform and the presence of `security`; the
    // adapter itself is proven in secrets.test.ts over a stand-in.
    expect(typeof ports.secrets.available()).toBe('boolean')
  })
})
