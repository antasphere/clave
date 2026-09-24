import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { findExecutable, resolvePosixShellLaunch } from './shell-launch'

const POSIX = ['/bin/sh', '/bin/bash', '/bin/zsh', '/opt/homebrew/bin/bash', '/usr/bin/dash']
const NON_POSIX = ['/opt/homebrew/bin/nu', '/opt/homebrew/bin/fish', '/usr/bin/xonsh', '/bin/tcsh']

describe('resolvePosixShellLaunch', () => {
  it.each([...POSIX, ...NON_POSIX])(
    'opens a plain terminal with the user shell %s',
    (userShell) => {
      expect(resolvePosixShellLaunch(userShell, undefined, 'darwin')).toEqual({
        file: userShell,
        args: ['-l']
      })
    }
  )

  it.each(POSIX)('keeps a POSIX user shell %s in charge of the agent wrapper', (userShell) => {
    for (const platform of ['darwin', 'linux'] as const) {
      expect(resolvePosixShellLaunch(userShell, 'agent command', platform)).toEqual({
        file: userShell,
        args: ['-l', '-c', 'agent command']
      })
    }
  })

  it.each(NON_POSIX)('keeps the POSIX agent wrapper away from the user shell %s', (userShell) => {
    expect(resolvePosixShellLaunch(userShell, 'agent command', 'darwin')).toEqual({
      file: '/bin/zsh',
      args: ['-l', '-c', 'agent command']
    })
    expect(resolvePosixShellLaunch(userShell, 'agent command', 'linux')).toEqual({
      file: '/bin/sh',
      args: ['-l', '-c', 'agent command']
    })
  })

  describe('platform default', () => {
    const realPlatform = process.platform
    afterEach(() => Object.defineProperty(process, 'platform', { value: realPlatform }))

    // The production call site passes no platform; a wrong default would
    // pick the mac adapter on Linux and every explicit-platform case above
    // would still be green.
    it('reads process.platform when no platform is given', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' })
      expect(resolvePosixShellLaunch('/usr/bin/nu', 'agent command').file).toBe('/bin/sh')
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      expect(resolvePosixShellLaunch('/usr/bin/nu', 'agent command').file).toBe('/bin/zsh')
    })
  })
})

describe('findExecutable', () => {
  // A real directory layout, so the check is the filesystem's own: an
  // executable file is found, a directory or a non-executable file of the same
  // name is not, and the first PATH entry that has it wins.
  const root = mkdtempSync(join(tmpdir(), 'clave-find-exec-'))
  const first = join(root, 'first')
  const second = join(root, 'second')
  const plain = join(root, 'plain')
  mkdirSync(first)
  mkdirSync(second)
  mkdirSync(plain)
  mkdirSync(join(first, 'claude'))
  writeFileSync(join(second, 'claude'), '#!/bin/sh\n')
  chmodSync(join(second, 'claude'), 0o755)
  writeFileSync(join(plain, 'claude'), '')
  chmodSync(join(plain, 'claude'), 0o644)
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('returns the first PATH entry holding an executable file of that name', () => {
    expect(findExecutable('claude', `${plain}:${first}:${second}:${plain}`)).toBe(
      join(second, 'claude')
    )
  })

  it('skips a directory and a file without the execute bit', () => {
    expect(findExecutable('claude', `${first}:${plain}`)).toBeNull()
  })

  it('is null for an empty PATH, an empty command and an unknown name', () => {
    expect(findExecutable('claude', undefined)).toBeNull()
    expect(findExecutable('claude', '')).toBeNull()
    expect(findExecutable('', second)).toBeNull()
    expect(findExecutable('nothing-here', second)).toBeNull()
  })

  it('checks a command that names a path as given, without PATH', () => {
    const file = join(second, 'claude')
    expect(findExecutable(file, first)).toBe(file)
    expect(findExecutable(join(plain, 'claude'), second)).toBeNull()
    expect(findExecutable('./claude', second)).toBeNull()
  })

  it('ignores empty PATH entries rather than reading the current directory', () => {
    const seen: string[] = []
    findExecutable('claude', `:${first}::${second}:`, (file) => {
      seen.push(file)
      return false
    })
    expect(seen).toEqual([join(first, 'claude'), join(second, 'claude')])
  })
})
