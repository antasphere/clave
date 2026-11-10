import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SUPPORTED,
  UnsupportedVersionError,
  assertCodexSupported,
  codexVersion,
  versionSupported
} from './version.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
/** A stand-in `codex` that prints the version given. */
function fakeCodex(output: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'session-bridge-fake-codex-'))
  dirs.push(dir)
  const bin = join(dir, 'codex')
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' '${output}'\n`)
  chmodSync(bin, 0o755)
  return bin
}

describe('the version pin', () => {
  it('pins Codex to the 0.167 line', () => {
    expect(SUPPORTED.codex).toEqual(['0.167.x'])
  })
  it('accepts any patch of a pinned minor and nothing else', () => {
    expect(versionSupported('0.167.0', SUPPORTED.codex)).toBe(true)
    expect(versionSupported('0.167.12', SUPPORTED.codex)).toBe(true)
    expect(versionSupported('0.166.9', SUPPORTED.codex)).toBe(false)
    expect(versionSupported('0.168.0', SUPPORTED.codex)).toBe(false)
    expect(versionSupported('1.167.0', SUPPORTED.codex)).toBe(false)
    expect(versionSupported('0.167', SUPPORTED.codex)).toBe(false)
    expect(versionSupported('garbage', SUPPORTED.codex)).toBe(false)
    expect(versionSupported('0.168.2', ['0.167.x', '0.168.2'])).toBe(true)
  })
  it('reads the version out of `codex --version`', async () => {
    expect(await codexVersion(fakeCodex('codex-cli 0.167.0'))).toBe('0.167.0')
    await expect(codexVersion(fakeCodex('no version here'))).rejects.toThrow(/printed no version/)
    await expect(codexVersion(join(tmpdir(), 'no-such-codex-binary'))).rejects.toThrow(
      /Could not run/
    )
  })
  it('refuses a version outside the pin, naming the version and the pin', async () => {
    await expect(assertCodexSupported(fakeCodex('codex-cli 0.167.3'))).resolves.toBe('0.167.3')
    const refusal = assertCodexSupported(fakeCodex('codex-cli 0.171.0'))
    await expect(refusal).rejects.toBeInstanceOf(UnsupportedVersionError)
    await expect(refusal).rejects.toMatchObject({
      provider: 'codex',
      version: '0.171.0',
      supported: ['0.167.x']
    })
    await expect(refusal).rejects.toThrow(/0\.171\.0.*0\.167\.x.*nothing was written/)
  })
})
