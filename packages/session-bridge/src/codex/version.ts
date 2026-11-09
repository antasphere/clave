/**
 * What this package has seen. A writer lays a file down in another program's
 * storage, so it refuses a version of that program it was not written
 * against: a newer Codex may read the rows differently, and a file written
 * blind is worse than no file.
 */
import { execFile } from 'node:child_process'

/** The versions each writer's storage format was discovered on and is pinned
 *  to. `x` stands for any patch. */
export const SUPPORTED = {
  codex: ['0.167.x']
} as const

export class UnsupportedVersionError extends Error {
  readonly provider: string
  readonly version: string
  readonly supported: readonly string[]
  constructor(provider: string, version: string, supported: readonly string[]) {
    super(
      `${provider} ${version} is not a version this package has verified its storage on (supported: ${supported.join(', ')}); nothing was written`
    )
    this.name = 'UnsupportedVersionError'
    this.provider = provider
    this.version = version
    this.supported = supported
  }
}

/** Whether `version` (`0.167.0`) matches one of the pins (`0.167.x`, `0.168.2`). */
export function versionSupported(version: string, pins: readonly string[]): boolean {
  const parts = version.trim().split('.')
  if (parts.length !== 3 || parts.some((p) => !/^\d+$/.test(p))) return false
  return pins.some((pin) => {
    const want = pin.split('.')
    return want.length === 3 && want.every((w, i) => w === 'x' || w === parts[i])
  })
}

/** The version `codex --version` prints (`codex-cli 0.167.0` → `0.167.0`). */
export function codexVersion(bin = 'codex'): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, ['--version'], { timeout: 15_000 }, (error, stdout) => {
      if (error) {
        reject(new Error(`Could not run ${bin} --version: ${error.message}`))
        return
      }
      const match = /(\d+\.\d+\.\d+)/.exec(String(stdout))
      if (!match) {
        reject(new Error(`${bin} --version printed no version: ${String(stdout).trim()}`))
        return
      }
      resolve(match[1])
    })
  })
}

/** The installed Codex's version, or a refusal naming it and the pin. */
export async function assertCodexSupported(bin = 'codex'): Promise<string> {
  const version = await codexVersion(bin)
  if (!versionSupported(version, SUPPORTED.codex))
    throw new UnsupportedVersionError('codex', version, SUPPORTED.codex)
  return version
}
