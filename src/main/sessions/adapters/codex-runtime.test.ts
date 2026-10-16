import { mkdtempSync, existsSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { fixtureConnection, fixtureShell, installFixtureCodex } from './codex-runtime-fixture'
import { spawnCodexAppServer, type CodexConnection } from './codex-app-server'

// These cases launch real Node children. Allow the full suite to share a busy
// host, while keeping each process scenario bounded.
vi.setConfig({ testTimeout: 15_000 })

const roots: string[] = []
const connections: CodexConnection[] = []
function fixture(): { root: string; install: string } {
  const root = mkdtempSync(join(tmpdir(), 'clave-runtime-test-'))
  roots.push(root)
  vi.stubEnv('SHELL', fixtureShell(root))
  return { root, install: installFixtureCodex(root) }
}
function connect(
  root: string,
  install: string,
  options?: Parameters<typeof fixtureConnection>[2]
): CodexConnection {
  const connection = fixtureConnection(root, install, options)
  connections.push(connection)
  return connection
}
afterEach(async () => {
  await Promise.all(connections.splice(0).map((c) => c.close()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

it('keeps a running Codex and its child helper usable after the installer removes its package', async () => {
  const { root, install } = fixture()
  const connection = connect(root, install)
  await connection.request('initialize')
  expect(await connection.request('helper')).toEqual({ output: 'helper-old:old' })
  rmSync(install, { recursive: true })
  expect(await connection.request('helper')).toEqual({ output: 'helper-old:old' })
  expect(await connection.request('child')).toEqual({ output: 'helper-old:old' })
})

it('shares a complete retained package until the last app-server exits', async () => {
  const { root, install } = fixture()
  const first = connect(root, install)
  const second = connect(root, install)
  const a = (await first.request('runtime')) as { file: string }
  const b = (await second.request('runtime')) as { file: string }
  expect(a.file).toBe(b.file)
  expect(a.file).not.toContain(install)
  await first.close()
  expect(existsSync(b.file)).toBe(true)
  rmSync(install, { recursive: true })
  expect(await second.request('helper')).toEqual({ output: 'helper-old:old' })
  await second.close()
  await vi.waitFor(() => expect(existsSync(b.file)).toBe(false))
})

it('retains coherent versions across installer replacements and symlink changes', async () => {
  const { root, install } = fixture()
  const link = join(root, 'codex')
  symlinkSync(join(install, 'bin', 'codex'), link)
  const callbacks = { notification: () => {}, request: () => {}, error: () => {}, exit: () => {} }
  const profile = {
    id: 'fixture',
    name: 'Fixture',
    family: 'codex' as const,
    command: [link],
    additionalArgs: []
  }
  const old = spawnCodexAppServer(root, callbacks, profile)
  connections.push(old)
  await old.request('initialize')
  const next = installFixtureCodex(root, 'new')
  rmSync(link)
  symlinkSync(join(next, 'bin', 'codex'), link)
  const fresh = spawnCodexAppServer(root, callbacks, profile)
  connections.push(fresh)
  await fresh.request('initialize')
  rmSync(install, { recursive: true })
  rmSync(next, { recursive: true })
  expect(await old.request('helper')).toEqual({ output: 'helper-old:old' })
  expect(await fresh.request('helper')).toEqual({ output: 'helper-new:new' })
})

it('preserves profile wrappers, arguments and tab/account bindings without leaking preparation mode', async () => {
  const { root, install } = fixture()
  const connection = connect(root, install, {
    prefix: ['/usr/bin/env', '-u', 'CLAVE_RUNTIME_MARKER'],
    env: {
      ...process.env,
      CODEX_HOME: '/fixture/account',
      CLAVE_SESSION_ID: 'fixture-tab',
      CLAVE_RUNTIME_MARKER: 'removed'
    } as Record<string, string>
  })
  expect(await connection.request('runtime')).toMatchObject({
    home: '/fixture/account',
    tab: 'fixture-tab',
    args: ['--config', 'fixture=value', 'app-server']
  })
  const context = (await connection.request('runtime')) as Record<string, unknown>
  expect(context.marker).toBeUndefined()
  expect(context.nodeMode).toBeUndefined()
})

it('dereferences resources before the installer removes their symlink target', async () => {
  const { root, install } = fixture()
  const external = join(root, 'resource-store')
  mkdirSync(external)
  writeFileSync(join(external, 'version'), 'external-old')
  rmSync(join(install, 'codex-resources'), { recursive: true })
  symlinkSync(external, join(install, 'codex-resources'))
  const connection = connect(root, install)
  await connection.request('initialize')
  rmSync(install, { recursive: true })
  rmSync(external, { recursive: true })
  expect(await connection.request('helper')).toEqual({ output: 'helper-old:external-old' })
})

it('refuses an incomplete standalone package with an actionable startup error', async () => {
  const { root, install } = fixture()
  rmSync(join(install, 'bin', 'codex-code-mode-host'))
  const exit = vi.fn()
  const connection = connect(root, install, { callbacks: { exit } })
  await expect(connection.request('initialize')).rejects.toThrow('disconnected')
  await vi.waitFor(() => expect(exit).toHaveBeenCalled())
  expect(exit.mock.calls[0][0]).not.toBe(0)
  expect(exit.mock.calls[0][1]).toContain('Clave could not retain the Codex runtime')
  expect(exit.mock.calls[0][1]).toContain('restart this chat')
})

it('cancels preparation that is blocked reading an installer artifact', async () => {
  const { root, install } = fixture()
  const manifest = join(install, 'codex-package.json')
  rmSync(manifest)
  execFileSync('/usr/bin/mkfifo', [manifest])
  const connection = connect(root, install)
  // The FIFO has no writer, so preparation cannot finish by itself.
  await new Promise((resolve) => setTimeout(resolve, 150))
  await Promise.race([
    connection.close(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Preparation was left running')), 2500)
    )
  ])
})

it('retains a legacy native executable and its sibling helper without copying its parent prefix', async () => {
  const { root, install } = fixture()
  rmSync(join(install, 'codex-package.json'))
  writeFileSync(join(install, 'bin', 'codex-code-mode-host'), '#!/bin/sh\nprintf legacy-helper', {
    mode: 0o755
  })
  const connection = connect(root, install)
  const runtime = (await connection.request('runtime')) as { file: string }
  expect(existsSync(join(dirname(runtime.file), 'codex-package.json'))).toBe(false)
  rmSync(install, { recursive: true })
  expect(await connection.request('helper')).toEqual({ output: 'legacy-helper' })
})
