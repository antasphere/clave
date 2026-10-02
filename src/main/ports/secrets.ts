import { execFileSync } from 'child_process'
import { randomUUID } from 'crypto'
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
}): SecretPort {
  const run = options.run ?? runSecurity
  const platform = options.platform ?? process.platform
  const exists = options.exists ?? ((file: string) => fs.existsSync(file))
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
      run(
        ['-i'],
        `add-generic-password -U -s ${quoteForSecurity(options.service)} -a ${quoteForSecurity(handle)} -w ${quoteForSecurity(plain)}\n`
      )
      return `${KEYCHAIN_HANDLE_PREFIX}${handle}`
    },
    open(sealed) {
      const handle = handleOf(sealed)
      if (handle === null || !port.available()) return undefined
      try {
        return run(['find-generic-password', '-s', options.service, '-a', handle, '-w']).replace(
          /\n$/,
          ''
        )
      } catch {
        return undefined
      }
    },
    discard(sealed) {
      const handle = handleOf(sealed)
      if (handle === null || !port.available()) return
      try {
        run(['delete-generic-password', '-s', options.service, '-a', handle])
      } catch {
        // Already gone, or never written: nothing to forget.
      }
    }
  }
  return port
}
