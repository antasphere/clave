import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import path from 'path'

/**
 * Where tmux is found at a launch (PRDCT-3527). It is looked up on the login
 * shell's PATH, and that read took two seconds on Valentin's machine; made
 * synchronously by main's first records listing, it froze every window's first
 * calls. Before the login shell has answered, the tmux the last launch found
 * (remembered in `tmux-path.json`) answers, and `whenTmuxResolvable` waits on
 * the login shell only when nothing is remembered. The login shell is a stub
 * here that answers when the test says so; a synchronous read is a failure.
 */
const shell = vi.hoisted(() => ({
  answer: null as null | ((stdout: string) => void),
  syncReads: 0
}))
vi.mock('child_process', async (original) => {
  const real = await original<typeof import('child_process')>()
  return {
    ...real,
    execFile: vi.fn((_file: string, args: string[], ...rest: unknown[]) => {
      const cb = rest.find((r) => typeof r === 'function') as
        | ((err: null, stdout: string) => void)
        | undefined
      if (args[0] === '-lic') shell.answer = (stdout) => cb?.(null, stdout)
      else cb?.(null, '')
      return { on: () => {} }
    }),
    execFileSync: vi.fn((_file: string, args: string[]) => {
      if (args[0] === '-lic') shell.syncReads++
      return ''
    })
  }
})

import { tempDataDir } from '../../ports/testing'

let dir: string
let bin: string
let backend: typeof import('./pty-backend')
let ports: typeof import('../../ports/terminals')

const env0 = (vars: Record<string, string>): string =>
  Object.entries(vars)
    .map(([k, v]) => `${k}=${v}\0`)
    .join('')

beforeEach(async () => {
  vi.resetModules()
  shell.answer = null
  shell.syncReads = 0
  dir = tempDataDir('clave-tmux-path-')
  bin = tempDataDir('clave-tmux-bin-')
  fs.writeFileSync(path.join(bin, 'tmux'), '#!/bin/sh\n', { mode: 0o755 })
  // Fresh modules each test (the backend caches what it found): the port
  // registry is installed on the same fresh copy the backend reads.
  ports = await import('../../ports/terminals')
  const { fileStorage } = await import('../../ports/storage')
  ports.installTerminalPorts({ storage: fileStorage(dir) })
  backend = await import('./pty-backend')
})
afterEach(() => {
  ports.resetTerminalPorts()
})

describe.skipIf(process.platform === 'win32')('tmux at a launch', () => {
  it('answers with the remembered tmux while the login shell has not, never reading it synchronously', async () => {
    fs.writeFileSync(
      path.join(dir, backend.TMUX_PATH_DOCUMENT),
      JSON.stringify({ path: path.join(bin, 'tmux') })
    )
    backend.preloadLoginShellEnv()
    let resolved = false
    void backend.whenTmuxResolvable().then(() => (resolved = true))
    await Promise.resolve()
    await Promise.resolve()
    expect(resolved).toBe(true)
    expect(backend.isTmuxAvailable()).toBe(true)
    expect(shell.syncReads).toBe(0)
  })

  it('waits for the login shell when nothing is remembered, then remembers what it found', async () => {
    backend.preloadLoginShellEnv()
    let resolved = false
    void backend.whenTmuxResolvable().then(() => (resolved = true))
    await new Promise((r) => setTimeout(r, 10))
    expect(resolved).toBe(false)
    shell.answer!(env0({ PATH: bin, HOME: dir }))
    await new Promise((r) => setTimeout(r, 10))
    expect(resolved).toBe(true)
    expect(backend.isTmuxAvailable()).toBe(true)
    expect(shell.syncReads).toBe(0)
    const remembered = JSON.parse(
      fs.readFileSync(path.join(dir, backend.TMUX_PATH_DOCUMENT), 'utf8')
    )
    expect(remembered).toEqual({ path: path.join(bin, 'tmux') })
  })

  it('a remembered tmux that is gone is not used', async () => {
    fs.writeFileSync(
      path.join(dir, backend.TMUX_PATH_DOCUMENT),
      JSON.stringify({ path: path.join(bin, 'gone') })
    )
    backend.preloadLoginShellEnv()
    let resolved = false
    void backend.whenTmuxResolvable().then(() => (resolved = true))
    await new Promise((r) => setTimeout(r, 10))
    expect(resolved).toBe(false)
  })
})
