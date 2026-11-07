// A macOS keychain FILE of one run's own (PRDCT-3259): the standalone server
// files its secrets there when `CLAVE_KEYCHAIN_FILE` names it, so an
// end-to-end run never touches a personal keychain. Created before the server
// starts, never added to the search list, deleted at the end; `items` counts
// what the server filed and never reads a value. Shared by the specs that run
// the login on a server of its own process (attached, separate).
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'

const SECURITY = '/usr/bin/security'
/** The service the standalone server files its items under (`src/main/ports/standalone.ts`). */
export const KEYCHAIN_SERVICE = 'Clave server'

export function runKeychain(file) {
  return {
    file,
    create() {
      rmSync(path.dirname(file), { recursive: true, force: true })
      mkdirSync(path.dirname(file), { recursive: true })
      execFileSync(SECURITY, ['create-keychain', '-p', '', file], { stdio: 'ignore' })
      execFileSync(SECURITY, ['set-keychain-settings', file], { stdio: 'ignore' })
    },
    remove() {
      try {
        execFileSync(SECURITY, ['delete-keychain', file], { stdio: 'ignore' })
      } catch {
        // Never created, or already gone.
      }
      rmSync(path.dirname(file), { recursive: true, force: true })
    },
    /** How many items the server filed in the run's keychain (never their values). */
    items() {
      try {
        const dump = execFileSync(SECURITY, ['dump-keychain', file], { encoding: 'utf-8' })
        // One `svce` attribute line per item (the label line repeats the service).
        return dump.split('\n').filter((l) => l.includes(`"svce"<blob>="${KEYCHAIN_SERVICE}"`))
          .length
      } catch {
        return 0
      }
    }
  }
}
