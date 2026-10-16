import { execFileSync } from 'child_process'
import { randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'crypto'
import * as path from 'node:path'
import { privateDirectory, readPrivateFile, createPrivateFile } from './private-files'
import * as fs from 'fs'

/**
 * Where a secret rests. A domain hands the port a value and gets back an
 * OPAQUE STRING that stands for it, keeps that string in its own document,
 * and opens it again when the process needs the value. The value itself is
 * never in the document: with the Electron adapter the opaque string is the
 * OS-encrypted ciphertext (`electron.ts`, the on-disk shape the app has
 * always had), with the standalone adapter it is a handle to a Keychain item
 * (`keychainSecrets` below). An opaque string from one adapter opens to
 * nothing on the other, by design: moving an install between the two means
 * signing in again, never a plaintext copy in between.
 */
export interface SecretPort {
  /** Whether the port can seal at all. A domain never falls back to plaintext. */
  available(): boolean
  /** Put a value away; the string returned is what the domain keeps. Throws when unavailable. */
  seal(plain: string): string
  /** The value a string stands for, or undefined when it cannot be opened here. */
  open(sealed: string): string | undefined
  /** Forget what a string stands for, where the port keeps anything of its own. */
  discard(sealed: string): void
}

/** Runs the `security` command: the arguments, the text on its standard
 *  input, the text it printed. Injectable so the adapter is tested without a
 *  keychain. */
export type SecurityCommand = (args: string[], input?: string) => string

const SECURITY = '/usr/bin/security'
/** The prefix that marks an opaque string as this adapter's. */
export const KEYCHAIN_HANDLE_PREFIX = 'keychain:'
/** A read that has not answered in this long is an access prompt nobody is
 *  looking at (the item's ACL does not cover this binary). */
const SECURITY_TIMEOUT_MS = 10_000

function runSecurity(args: string[], input?: string): string {
  return execFileSync(SECURITY, args, {
    encoding: 'utf-8',
    timeout: SECURITY_TIMEOUT_MS,
    input,
    stdio: ['pipe', 'pipe', 'ignore']
  })
}

/** A word for `security -i`'s own line parser: double-quoted, the two
 *  characters it treats specially escaped. */
function quoteForSecurity(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * The macOS Keychain through the `security` CLI, for the standalone server.
 * Each sealed value is one generic-password item under `service`, its
 * account a fresh handle; the handle is what the domain keeps. The value
 * goes in through `security -i`'s standard input, never on the command line,
 * so it is not readable in the process list while the write runs. Printable
 * ASCII values only: that is what `security` reads back verbatim.
 */
export function keychainSecrets(options: {
  service: string
  run?: SecurityCommand
  platform?: NodeJS.Platform
  exists?: (file: string) => boolean
  /** A keychain file to use instead of the login keychain: every subcommand
   *  names it last, the way `security` takes one. The end-to-end harness
   *  gives the standalone server a keychain of the run's own, so a test
   *  never files anything in, or reads anything from, a personal keychain. */
  keychainFile?: string
}): SecretPort {
  const run = options.run ?? runSecurity
  const platform = options.platform ?? process.platform
  const exists = options.exists ?? ((file: string) => fs.existsSync(file))
  const keychain = options.keychainFile ? [options.keychainFile] : []
  const handleOf = (sealed: string): string | null =>
    sealed.startsWith(KEYCHAIN_HANDLE_PREFIX) ? sealed.slice(KEYCHAIN_HANDLE_PREFIX.length) : null
  const port: SecretPort = {
    available: () => platform === 'darwin' && exists(SECURITY),
    seal(plain) {
      if (!port.available()) throw new Error('The macOS Keychain is unavailable here.')
      // Printable ASCII only. `security -i` reads one command per line, so a
      // line break or another control character would be read as a second
      // command; and `find-generic-password -w` prints anything beyond ASCII
      // as hex, so a value with an accent would open to a different string.
      // The tokens this port carries are ASCII; anything else is refused
      // rather than filed and read back wrong.
      if (/[^\x20-\x7e]/.test(plain)) {
        throw new Error(
          'A secret outside printable ASCII cannot be filed in the Keychain through security.'
        )
      }
      const handle = randomUUID()
      const file = keychain.length ? ` ${quoteForSecurity(keychain[0])}` : ''
      run(
        ['-i'],
        `add-generic-password -U -s ${quoteForSecurity(options.service)} -a ${quoteForSecurity(handle)} -w ${quoteForSecurity(plain)}${file}\n`
      )
      return `${KEYCHAIN_HANDLE_PREFIX}${handle}`
    },
    open(sealed) {
      const handle = handleOf(sealed)
      if (handle === null || !port.available()) return undefined
      try {
        return run([
          'find-generic-password',
          '-s',
          options.service,
          '-a',
          handle,
          '-w',
          ...keychain
        ]).replace(/\n$/, '')
      } catch {
        return undefined
      }
    },
    discard(sealed) {
      const handle = handleOf(sealed)
      if (handle === null || !port.available()) return
      try {
        run(['delete-generic-password', '-s', options.service, '-a', handle, ...keychain])
      } catch {
        // Already gone, or never written: nothing to forget.
      }
    }
  }
  return port
}

/** Linux daemon secrets, encrypted and authenticated with a private local key.
 *  Protect and back up this whole directory as one unit. The local key is a
 *  filesystem security boundary, not protection against the owning OS user. */
export function fileSecrets(options: { directory: string }): SecretPort {
  const directory = options.directory
  const prefix = 'file:v1:'
  const fileOf = (sealed: string): string | null => {
    const handle = sealed.slice(prefix.length)
    return sealed.startsWith(prefix) && /^[0-9a-f-]{36}$/.test(handle)
      ? path.join(directory, `${handle}.secret`)
      : null
  }
  const key = (create: boolean): Buffer => {
    privateDirectory(directory)
    const file = path.join(directory, 'master.key')
    if (create && !fs.existsSync(file)) {
      if (fs.readdirSync(directory).some((name) => name.endsWith('.secret'))) {
        throw new Error('The server secret key is missing; restore the private directory backup')
      }
      try {
        createPrivateFile(file, randomBytes(32))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
    const value = readPrivateFile(file)
    if (value.length !== 32) throw new Error('Invalid server secret key')
    return value
  }
  return {
    available() {
      try {
        key(true)
        return true
      } catch {
        return false
      }
    },
    seal(plain) {
      if (Buffer.byteLength(plain) > 1024 * 1024) throw new Error('Server secret is too large')
      const handle = `${prefix}${randomUUID()}`
      const nonce = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key(true), nonce)
      cipher.setAAD(Buffer.from(handle))
      const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
      createPrivateFile(fileOf(handle)!, Buffer.concat([nonce, cipher.getAuthTag(), encrypted]))
      return handle
    },
    open(sealed) {
      const file = fileOf(sealed)
      if (!file) return undefined
      try {
        const value = readPrivateFile(file)
        const decipher = createDecipheriv('aes-256-gcm', key(false), value.subarray(0, 12))
        decipher.setAAD(Buffer.from(sealed))
        decipher.setAuthTag(value.subarray(12, 28))
        return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString(
          'utf8'
        )
      } catch {
        return undefined
      }
    },
    discard(sealed) {
      const file = fileOf(sealed)
      if (file) fs.rmSync(file, { force: true })
    }
  }
}
