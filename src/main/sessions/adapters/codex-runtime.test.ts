import {
  mkdtempSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  openSync,
  closeSync,
  promises as fs,
  symlinkSync,
  writeFileSync,
  rmSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { fixtureConnection, fixtureShell, installFixtureCodex } from './codex-runtime-fixture'
import { spawnCodexAppServer, type CodexConnection } from './codex-app-server'
import { shellSingleQuote } from '../../shell-launch'

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
  expect(existsSync(b.file)).toBe(false)
})

it('releases the runtime when the provider exits without a caller closing it', async () => {
  const { root, install } = fixture()
  const exit = vi.fn()
  const connection = connect(root, install, { callbacks: { exit } })
  const runtime = (await connection.request('runtime')) as { file: string }
  connection.notify('fixtureExit')
  await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0, ''), { timeout: 3000 })
  await vi.waitFor(() => expect(existsSync(runtime.file)).toBe(false), { timeout: 3000 })
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

it('starts a new runtime when an installer replaces the same canonical package path', async () => {
  const { root, install } = fixture()
  const old = connect(root, install)
  await old.request('initialize')
  const next = installFixtureCodex(root, 'new')
  rmSync(install, { recursive: true })
  renameSync(next, install)
  const fresh = connect(root, install)
  await fresh.request('initialize')
  rmSync(install, { recursive: true })
  expect(await old.request('helper')).toEqual({ output: 'helper-old:old' })
  expect(await fresh.request('helper')).toEqual({ output: 'helper-new:new' })
})

it('separates package roots when metadata reorganizes around an unchanged executable', async () => {
  const { root, install } = fixture()
  const old = connect(root, install)
  await old.request('initialize')
  const nextRoot = join(install, 'bin')
  mkdirSync(join(nextRoot, 'codex-resources'))
  writeFileSync(join(nextRoot, 'codex-resources', 'version'), 'new-root')
  writeFileSync(
    join(nextRoot, 'codex-package.json'),
    JSON.stringify({ layoutVersion: 2, entrypoint: 'codex' })
  )
  const fresh = connect(root, install)
  await fresh.request('initialize')
  rmSync(install, { recursive: true })
  expect(await old.request('helper')).toEqual({ output: 'helper-old:old' })
  expect(await fresh.request('helper')).toEqual({ output: 'helper-old:new-root' })
})

it.each([
  ['launch', false],
  ['libexec/bin', false],
  ['', false],
  ['launch', true]
] as const)(
  'retains an unfamiliar package with entrypoint directory %j, omitted metadata key %j',
  async (directory, omitEntrypoint) => {
    const { root, install } = fixture()
    const entrypoint = directory ? `${directory}/codex` : 'codex'
    const manifest = {
      layoutVersion: 2,
      ...(omitEntrypoint ? {} : { entrypoint }),
      assets: { format: 'future' }
    }
    writeFileSync(join(install, 'codex-package.json'), JSON.stringify(manifest))
    if (directory) {
      mkdirSync(dirname(join(install, directory)), { recursive: true })
      renameSync(join(install, 'bin'), join(install, directory))
    } else {
      for (const file of readdirSync(join(install, 'bin')))
        renameSync(join(install, 'bin', file), join(install, file))
      rmSync(join(install, 'bin'), { recursive: true })
    }
    const connection = spawnCodexAppServer(
      root,
      {
        notification: () => {},
        request: () => {},
        error: () => {},
        exit: () => {}
      },
      {
        id: 'future-package',
        name: 'Fixture',
        family: 'codex',
        command: [join(install, directory, 'codex')],
        additionalArgs: []
      }
    )
    connections.push(connection)
    const runtime = (await connection.request('runtime')) as { file: string }
    const retainedRoot = directory
      ? runtime.file.slice(0, -entrypoint.length)
      : dirname(runtime.file)
    const retainedManifest = join(retainedRoot, 'codex-package.json')
    expect(JSON.parse(readFileSync(retainedManifest, 'utf8'))).toEqual(manifest)
    expect(runtime.file).not.toContain(install)
    rmSync(install, { recursive: true })
    expect(await connection.request('helper')).toEqual({ output: 'helper-old:old' })
    expect(await connection.request('child')).toEqual({ output: 'helper-old:old' })
  }
)

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
  expect(context.nodeMode).toBe(process.env.ELECTRON_RUN_AS_NODE)
  rmSync(install, { recursive: true })
  expect(await connection.request('helper')).toEqual({ output: 'helper-old:old' })
})

it('restores account and MCP bindings after a login profile clobbers the public variables', async () => {
  const { root, install } = fixture()
  writeFileSync(
    join(root, 'sh'),
    `#!/bin/sh
export CODEX_HOME=/wrong CLAVE_SESSION_ID=wrong CLAVE_CODEX_MCP_TOKEN=wrong
[ "$1" = -l ] && shift
exec /bin/sh "$@"
`,
    { mode: 0o755 }
  )
  const connection = connect(root, install, {
    env: {
      ...process.env,
      CODEX_HOME: '/fixture/account',
      CLAVE_SESSION_ID: 'fixture-tab',
      CLAVE_CODEX_MCP_TOKEN: 'runtime-fixture-token'
    } as Record<string, string>
  })
  expect(await connection.request('runtime')).toMatchObject({
    home: '/fixture/account',
    tab: 'fixture-tab',
    authenticated: true
  })
})

it('isolates preparation Node settings from env -i while preserving the provider environment', async () => {
  const { root } = fixture()
  const executable = join(root, 'codex')
  writeFileSync(
    executable,
    `#!/bin/sh
while IFS= read -r line; do
  runtime_mode="$ELECTRON_RUN_AS_NODE"
  if [ -z "$runtime_mode" ]; then runtime_mode=unset; fi
  printf '{"id":1,"result":{"mode":"%s","options":"%s"}}\\n' "$runtime_mode" "$NODE_OPTIONS"
done
`,
    { mode: 0o755 }
  )
  // A safe stand-in for Electron rejects preparation without Node mode.
  // This pins the production requirement even when Vitest runs on plain Node.
  const guardedNode = join(root, 'guarded-node')
  writeFileSync(
    guardedNode,
    `#!/bin/sh
[ "$ELECTRON_RUN_AS_NODE" = 1 ] || exit 77
exec ${shellSingleQuote(process.execPath)} "$@"
`,
    { mode: 0o755 }
  )
  const descriptor = Object.getOwnPropertyDescriptor(process, 'execPath')!
  let connection: CodexConnection
  try {
    Object.defineProperty(process, 'execPath', { ...descriptor, value: guardedNode })
    connection = spawnCodexAppServer(
      root,
      {
        notification: () => {},
        request: () => {},
        error: () => {},
        exit: () => {}
      },
      {
        id: 'isolated-env',
        name: 'Fixture',
        family: 'codex',
        command: [
          '/usr/bin/env',
          '-i',
          'NODE_OPTIONS=--require=/missing-fixture-preload',
          executable
        ],
        additionalArgs: []
      }
    )
  } finally {
    Object.defineProperty(process, 'execPath', descriptor)
  }
  connections.push(connection)
  expect(await connection.request('initialize')).toEqual({
    mode: 'unset',
    options: '--require=/missing-fixture-preload'
  })
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
  const runtime = (await connection.request('runtime')) as { file: string }
  const resources = join(dirname(runtime.file), '..', 'codex-resources')
  expect(lstatSync(resources).isSymbolicLink()).toBe(false)
  expect(readFileSync(join(resources, 'version'), 'utf8')).toBe('external-old')
  rmSync(install, { recursive: true })
  rmSync(external, { recursive: true })
  expect(readFileSync(join(resources, 'version'), 'utf8')).toBe('external-old')
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

it('refuses current-layout resources outside the retained package before starting work', async () => {
  const { root, install } = fixture()
  const external = join(root, 'outside-package')
  mkdirSync(external)
  const manifestFile = join(install, 'codex-package.json')
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  manifest.resourcesDir = relative(install, external)
  writeFileSync(manifestFile, JSON.stringify(manifest))
  const exit = vi.fn()
  const connection = connect(root, install, { callbacks: { exit } })
  await expect(connection.request('initialize')).rejects.toThrow()
  await vi.waitFor(() => expect(exit).toHaveBeenCalled())
  expect(exit.mock.calls[0][1]).toContain('Invalid Codex standalone resource path')
})

it('refuses a resource symlink cycle before starting an incomplete runtime', async () => {
  const { root, install } = fixture()
  symlinkSync(install, join(install, 'codex-resources', 'cycle'))
  const exit = vi.fn()
  const connection = connect(root, install, { callbacks: { exit } })
  await expect(connection.request('initialize')).rejects.toThrow()
  await vi.waitFor(() => expect(exit).toHaveBeenCalled())
  expect(exit.mock.calls[0][1]).toContain('Cyclic Codex runtime resource link')
})

it('cancels preparation that is blocked reading an installer artifact', async () => {
  const { root, install } = fixture()
  const manifest = join(install, 'codex-package.json')
  rmSync(manifest)
  execFileSync('/usr/bin/mkfifo', [manifest])
  const connection = connect(root, install)
  // Opening the writer completes only when preparation has opened the reader.
  // Keep it open on partial JSON so the read cannot finish before cancellation.
  const opening = fs.open(manifest, 'w')
  let handshakeTimer: ReturnType<typeof setTimeout> | undefined
  const writer = await Promise.race([
    opening,
    new Promise<never>((_, reject) => {
      handshakeTimer = setTimeout(() => {
        const unblock = openSync(manifest, 'r+')
        void opening.then(async (handle) => {
          await handle.close()
          closeSync(unblock)
        })
        reject(new Error('Preparation never opened the installer artifact'))
      }, 5000)
    })
  ]).finally(() => clearTimeout(handshakeTimer))
  await writer.write('{')
  const closing = connection.close()
  let closeTimer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      closing,
      new Promise<never>((_, reject) => {
        closeTimer = setTimeout(() => reject(new Error('Preparation was left running')), 2500)
      })
    ])
  } finally {
    clearTimeout(closeTimer)
    await writer.close()
    await closing
  }
})

it('retains a legacy native executable and its sibling helper without copying its parent prefix', async () => {
  const { root, install } = fixture()
  rmSync(join(install, 'codex-package.json'))
  // A nearby package marker for another executable must not capture this CLI.
  writeFileSync(join(dirname(install), 'unrelated-codex'), 'unrelated fixture executable')
  writeFileSync(
    join(dirname(install), 'codex-package.json'),
    JSON.stringify({ layoutVersion: 2, entrypoint: 'unrelated-codex' })
  )
  writeFileSync(
    join(install, 'bin', 'unrelated-prefix-file'),
    'fixture data outside the executable/helper pair'
  )
  writeFileSync(join(install, 'bin', 'codex-code-mode-host'), '#!/bin/sh\nprintf legacy-helper', {
    mode: 0o755
  })
  const connection = connect(root, install)
  const runtime = (await connection.request('runtime')) as { file: string }
  expect(existsSync(join(dirname(runtime.file), 'codex-package.json'))).toBe(false)
  expect(existsSync(join(dirname(runtime.file), 'unrelated-prefix-file'))).toBe(false)
  rmSync(install, { recursive: true })
  expect(await connection.request('helper')).toEqual({ output: 'legacy-helper' })
})

it.each([
  'distant matching marker',
  'escaping entrypoint',
  'absolute entrypoint',
  'missing entrypoint at executable'
])('keeps legacy retention confined to its pair with %s', async (marker) => {
  const { root, install } = fixture()
  rmSync(join(install, 'codex-package.json'))
  let commandInstall = install
  let manifestDirectory = join(install, 'bin')
  let entrypoint: string | undefined
  if (marker === 'distant matching marker') {
    // This matching manifest is six parents above the executable directory,
    // outside the nearby-package search. Its tree contains unrelated data.
    commandInstall = join(install, 'a', 'b', 'c', 'd', 'e')
    mkdirSync(commandInstall, { recursive: true })
    renameSync(join(install, 'bin'), join(commandInstall, 'bin'))
    manifestDirectory = install
    entrypoint = relative(install, join(commandInstall, 'bin', 'codex'))
  } else if (marker === 'escaping entrypoint') {
    // Canonical equality alone must not let an outside alias claim this CLI.
    const alias = join(root, 'outside-alias')
    symlinkSync(join(install, 'bin', 'codex'), alias)
    entrypoint = relative(manifestDirectory, alias)
  } else if (marker === 'absolute entrypoint') {
    entrypoint = join(install, 'bin', 'codex')
  }
  writeFileSync(
    join(manifestDirectory, 'codex-package.json'),
    JSON.stringify({ layoutVersion: 2, entrypoint })
  )
  writeFileSync(join(commandInstall, 'bin', 'unrelated-prefix-file'), 'outside the legacy pair')
  writeFileSync(
    join(commandInstall, 'bin', 'codex-code-mode-host'),
    '#!/bin/sh\nprintf legacy-helper',
    { mode: 0o755 }
  )
  const connection = connect(root, commandInstall)
  const runtime = (await connection.request('runtime')) as { file: string }
  expect(runtime.file).not.toContain(install)
  expect(readdirSync(dirname(runtime.file)).sort()).toEqual(['codex', 'codex-code-mode-host'])
  rmSync(install, { recursive: true })
  expect(await connection.request('helper')).toEqual({ output: 'legacy-helper' })
  expect(await connection.request('child')).toEqual({ output: 'legacy-helper' })
})
