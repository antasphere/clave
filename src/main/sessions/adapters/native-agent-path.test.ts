import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { refreshLoginShellEnv, withNativeAgentDirs } from './pty-backend'

/**
 * The login PATH Clave spawns with always ends with the folder Anthropic's
 * native installer puts `claude` in: a process that read its environment
 * before the first-run walk installed the CLI still finds it, and nothing the
 * profile places is ever shadowed.
 */
describe('withNativeAgentDirs', () => {
  it('appends ~/.local/bin last, once', () => {
    const env = withNativeAgentDirs({ PATH: '/opt/homebrew/bin:/usr/bin' }, '/Users/a')
    expect(env.PATH).toBe('/opt/homebrew/bin:/usr/bin:/Users/a/.local/bin')
    expect(withNativeAgentDirs(env, '/Users/a').PATH).toBe(env.PATH)
  })

  it('leaves a PATH that already names it where the profile put it', () => {
    const env = withNativeAgentDirs({ PATH: '/Users/a/.local/bin:/usr/bin' }, '/Users/a')
    expect(env.PATH).toBe('/Users/a/.local/bin:/usr/bin')
  })

  it('makes a PATH from nothing, and does nothing without a home', () => {
    expect(withNativeAgentDirs({}, '/Users/a').PATH).toBe('/Users/a/.local/bin')
    expect(withNativeAgentDirs({ PATH: '/bin' }, '').PATH).toBe('/bin')
  })
})

describe('the login environment Clave spawns with', () => {
  it('ends its PATH with the native folder, as read from the login shell', async () => {
    // A login shell that answers `-lic 'env -0'` with a PATH of its own.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clave-shell-'))
    const shell = path.join(dir, 'fake-shell')
    fs.writeFileSync(shell, "#!/bin/sh\nprintf 'PATH=/fake/bin\\000ONLY_HERE=1\\000'\n")
    fs.chmodSync(shell, 0o755)
    const saved = process.env.SHELL
    process.env.SHELL = shell
    try {
      const env = await refreshLoginShellEnv()
      expect(env.ONLY_HERE).toBe('1')
      expect(env.PATH).toBe(`/fake/bin:${path.join(process.env.HOME || '', '.local', 'bin')}`)
    } finally {
      process.env.SHELL = saved
    }
  })
})
