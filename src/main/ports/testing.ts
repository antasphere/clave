import fs from 'fs'
import os from 'os'
import path from 'path'
import type { SecretPort } from './secrets'
import { keychainSecrets } from './secrets'
import { fileStorage } from './storage'
import { safeStorageSecrets } from './electron'
import type { SettingsPorts } from './registry'

/**
 * The ports a unit test runs a settings domain on. Two shapes, so the same
 * test file proves both adapters: `electronTestPorts` is the in-process
 * shape (file storage plus a reversible stand-in for the OS encryption, the
 * way the tests have always mocked `safeStorage`), `standaloneTestPorts` is
 * the server's shape (file storage plus the real Keychain adapter over a fake
 * `security` that keeps its items in memory). Both are plain code, not
 * mocks: what reaches the disk is what the adapter wrote.
 */

export function tempDataDir(prefix = 'clave-ports-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** `safeStorage` as the tests have always stood it in: reversible, and
 *  visibly not the plaintext. `available` can be flipped mid-test. */
export function fakeSafeStorage(state: { available: boolean } = { available: true }): {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
} {
  return {
    isEncryptionAvailable: () => state.available,
    encryptString: (plain) => Buffer.from(`enc:${plain}`),
    decryptString: (encrypted) => {
      const text = encrypted.toString()
      if (!text.startsWith('enc:')) throw new Error('not ours')
      return text.slice(4)
    }
  }
}

/** A `security` that keeps generic-password items in a map: the three
 *  subcommands the adapter uses, parsed the way the real one would. */
export function fakeSecurity(items: Map<string, string> = new Map()): {
  items: Map<string, string>
  calls: { args: string[]; input?: string }[]
  run: (args: string[], input?: string) => string
} {
  const calls: { args: string[]; input?: string }[] = []
  const key = (service: string, account: string): string => `${service}\u0000${account}`
  const unquote = (word: string): string =>
    word.startsWith('"') ? word.slice(1, -1).replace(/\\(["\\])/g, '$1') : word
  // `security -i` lines: words are either bare or double-quoted with \" and \\ escapes.
  const words = (line: string): string[] =>
    (line.match(/"(?:[^"\\]|\\.)*"|\S+/g) ?? []).map(unquote)
  const flag = (argv: string[], name: string): string | undefined => {
    const i = argv.indexOf(name)
    return i === -1 ? undefined : argv[i + 1]
  }
  return {
    items,
    calls,
    run(args, input) {
      calls.push({ args, input })
      if (args[0] === '-i') {
        for (const line of (input ?? '').split('\n').filter((l) => l.trim() !== '')) {
          const argv = words(line)
          if (argv[0] !== 'add-generic-password') throw new Error(`unsupported: ${line}`)
          const service = flag(argv, '-s')!
          const account = flag(argv, '-a')!
          const password = flag(argv, '-w')!
          if (items.has(key(service, account)) && !argv.includes('-U')) {
            throw new Error('The specified item already exists in the keychain.')
          }
          items.set(key(service, account), password)
        }
        return ''
      }
      const service = flag(args, '-s')!
      const account = flag(args, '-a')!
      if (args[0] === 'find-generic-password') {
        const value = items.get(key(service, account))
        if (value === undefined) {
          throw new Error('The specified item could not be found in the keychain.')
        }
        return args.includes('-w') ? `${value}\n` : ''
      }
      if (args[0] === 'delete-generic-password') {
        if (!items.delete(key(service, account))) {
          throw new Error('The specified item could not be found in the keychain.')
        }
        return ''
      }
      throw new Error(`unsupported: ${args.join(' ')}`)
    }
  }
}

export function electronTestPorts(
  dir: string = tempDataDir(),
  state: { available: boolean } = { available: true }
): SettingsPorts & { dir: string; secrets: SecretPort } {
  return { dir, storage: fileStorage(dir), secrets: safeStorageSecrets(fakeSafeStorage(state)) }
}

export function standaloneTestPorts(
  dir: string = tempDataDir(),
  security: ReturnType<typeof fakeSecurity> = fakeSecurity()
): SettingsPorts & { dir: string; security: ReturnType<typeof fakeSecurity> } {
  return {
    dir,
    security,
    storage: fileStorage(dir),
    secrets: keychainSecrets({
      service: 'Clave test',
      run: security.run,
      platform: 'darwin',
      exists: () => true
    })
  }
}

/** Both shapes, for a `describe.each` that runs one suite on each adapter. */
export function eachTestPorts(): [name: string, make: () => SettingsPorts & { dir: string }][] {
  return [
    ['the Electron adapters', () => electronTestPorts()],
    ['the standalone adapters', () => standaloneTestPorts()]
  ]
}
