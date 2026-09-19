import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { BrowserWindow } from 'electron'
import type { Server } from 'node:net'

const fixture = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { join } = await import('node:path')
  return { root: mkdtempSync(join(process.cwd(), '.launch-profile-test-')) }
})

vi.mock('electron', () => ({
  app: { getPath: () => fixture.root },
  dialog: { showMessageBox: vi.fn() }
}))
vi.mock('../ipc-handlers/clave-file-handlers', () => ({
  isUnderTrustedRoot: () => true,
  addTrustedRoot: vi.fn()
}))
vi.mock('../runtime-plugins/host', () => ({ revokePluginSessionViews: vi.fn() }))
vi.mock('../pty-manager', () => ({
  getLoginShellEnv: () => ({ PATH: process.env.PATH }),
  buildSpawnEnv: (env) => env,
  accountTokenForSpawn: () => undefined
}))
vi.mock('../mcp/mcp-runtime', () => ({
  writeSessionMcpConfig: () => undefined,
  deleteSessionMcpConfig: vi.fn()
}))
vi.mock('../window-registry', () => ({
  windowRegistry: {
    getWorkspaceForWindow: () => 'work',
    getKeyForWindow: () => 'window',
    getWindowForSession: () => null,
    bindSession: vi.fn(),
    listWindows: () => []
  }
}))
vi.mock('../window-state', () => ({ windowState: { list: () => [{ key: 'window' }] } }))

import { launchProfileManager } from '../launch-profile-manager'
import { runtimePluginRegistry } from '../runtime-plugins/registry-runtime'
import { createPluginAdapterFactory } from '../runtime-plugins/providers'
import { startDaemon } from './daemon'
import { ConversationClient } from './client'
import { servicePaths } from './wire'
import { createConversation, sendConversation, disconnectConversationClient } from './runtime'

let server: Server | undefined
let client: ConversationClient
const registry = runtimePluginRegistry()
const window = { id: 7 } as BrowserWindow
const command = (marker: string): string[] => [
  process.execPath,
  '-e',
  'console.log(JSON.stringify(process.argv.slice(1)))',
  '--',
  marker
]

beforeAll(async () => {
  const source = join(fixture.root, 'plugin')
  mkdirSync(source)
  writeFileSync(
    join(source, 'clave-plugin.json'),
    JSON.stringify({
      apiVersion: 1,
      id: 'test.launch',
      name: 'Launch fixture',
      version: '1.0.0',
      provider: {
        id: 'test.launch-provider',
        name: 'Launch provider',
        entry: 'provider.cjs',
        command: command('registry-default'),
        capabilities: { permissions: false, questions: false, resume: true }
      },
      views: []
    })
  )
  writeFileSync(
    join(source, 'provider.cjs'),
    `
    exports.createAdapter = (launch, emit) => ({
      capabilities: { permissions: false, questions: false, resume: true },
      async start() {},
      async send() {
        const text = require('node:child_process').execFileSync(
          launch.command[0], [...launch.command.slice(1), ...launch.additionalArgs],
          { encoding: 'utf8', env: launch.env }
        ).trim();
        emit({ type: 'message', message: { kind: 'message', id: 'argv', role: 'assistant', text } });
        emit({ type: 'turn-end', outcome: 'completed' });
      },
      async respond() {}, async interrupt() {}, async dispose() {}
    });
  `
  )
  registry.installPrepared(registry.inspectFolder(source))
  const pluginFactory = createPluginAdapterFactory(registry)
  server = await startDaemon(fixture.root, (launch, emit) => {
    if (launch.options.provider !== 'opencode') return pluginFactory(launch, emit)
    // A fake OpenCode adapter executes the selected command, without a model call.
    return {
      capabilities: { permissions: false, questions: false, resume: true },
      start: async () => {},
      send: async () => {
        const text = execFileSync(
          launch.command[0],
          [...launch.command.slice(1), ...launch.additionalArgs],
          {
            encoding: 'utf8',
            env: launch.env
          }
        ).trim()
        emit({ type: 'message', message: { kind: 'message', id: 'argv', role: 'assistant', text } })
        emit({ type: 'turn-end', outcome: 'completed' })
      },
      respond: async () => {},
      interrupt: async () => {},
      dispose: async () => {}
    }
  })
  const paths = servicePaths(fixture.root)
  client = await ConversationClient.attach(paths.socket, readFileSync(paths.token, 'utf8'))
  vi.spyOn(ConversationClient, 'connect').mockResolvedValue(client)
})

afterAll(async () => {
  disconnectConversationClient()
  client?.disconnect()
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
  vi.restoreAllMocks()
  if (process.platform !== 'win32')
    rmSync(servicePaths(fixture.root).socketDirectory, { recursive: true, force: true })
  rmSync(fixture.root, { recursive: true, force: true })
})

it.each(['opencode', 'test.launch-provider'])(
  'passes selected %s command and args through main, socket, and adapter',
  async (provider) => {
    for (const suffix of ['global', 'workspace', 'explicit']) {
      launchProfileManager.upsert({
        id: `${provider}-${suffix}`,
        name: suffix,
        family: provider,
        command: command(suffix),
        additionalArgs: ['space in one argument', '--fixture-option']
      })
    }
    launchProfileManager.setGlobalDefault(provider, `${provider}-global`)
    launchProfileManager.setWorkspaceDefault('work', provider, `${provider}-workspace`)
    for (const [workspaceId, requested, expected] of [
      ['other', undefined, 'global'],
      ['work', undefined, 'workspace'],
      ['work', `${provider}-explicit`, 'explicit']
    ]) {
      const { session } = await createConversation(window, {
        provider,
        cwd: fixture.root,
        workspaceId,
        launchProfileId: requested
      })
      expect(session.launchProfileId).toBe(`${provider}-${expected}`)
      await sendConversation(session.id, 'record argv', `send-${expected}`)
      await expect
        .poll(async () =>
          (await client.snapshot(session.id)).entries
            .filter((entry) => entry.kind === 'message' && entry.role === 'assistant')
            .map((entry) => (entry.kind === 'message' ? entry.text : ''))
        )
        .toContain(JSON.stringify([expected, 'space in one argument', '--fixture-option']))
      await client.close(session.id)
    }
  }
)

it('uses installed provider defaults and rejects unknown or mismatched explicit profiles before launch', async () => {
  launchProfileManager.setGlobalDefault('test.launch-provider', null)
  launchProfileManager.setWorkspaceDefault('work', 'test.launch-provider', null)
  const { session } = await createConversation(window, {
    provider: 'test.launch-provider',
    cwd: fixture.root
  })
  expect(session.launchProfileId).toBe('builtin-test.launch-provider')
  await sendConversation(session.id, 'default argv', 'default')
  await expect
    .poll(async () => JSON.stringify((await client.snapshot(session.id)).entries))
    .toContain('registry-default')
  await client.close(session.id)
  await expect(
    createConversation(window, {
      provider: 'opencode',
      cwd: fixture.root,
      launchProfileId: 'missing'
    })
  ).rejects.toThrow('Unknown launch profile')
  await expect(
    createConversation(window, {
      provider: 'opencode',
      cwd: fixture.root,
      launchProfileId: 'test.launch-provider-explicit'
    })
  ).rejects.toThrow('does not match provider opencode')
  await expect(
    createConversation(window, {
      provider: 'unknown.provider',
      cwd: fixture.root
    })
  ).rejects.toThrow('No launch profile')
})

it('keeps connected launch configuration and re-resolves the saved profile after daemon restart', async () => {
  const profile = {
    id: 'restart-profile',
    name: 'Restart profile',
    family: 'test.launch-provider',
    command: command('original'),
    additionalArgs: ['original-argument']
  }
  launchProfileManager.upsert(profile)
  const { session } = await createConversation(window, {
    provider: profile.family,
    cwd: fixture.root,
    launchProfileId: profile.id
  })
  await sendConversation(session.id, 'first', 'restart-first')
  launchProfileManager.upsert({
    ...profile,
    command: command('updated'),
    additionalArgs: ['updated-argument']
  })
  await sendConversation(session.id, 'connected', 'restart-connected')
  const connectedEntries = JSON.stringify((await client.snapshot(session.id)).entries)
  expect(connectedEntries).toContain('original-argument')
  expect(connectedEntries).not.toContain('updated')
  await new Promise<void>((resolve) => server!.close(() => resolve()))
  server = await startDaemon(fixture.root, createPluginAdapterFactory(registry))
  const paths = servicePaths(fixture.root)
  client = await ConversationClient.attach(paths.socket, readFileSync(paths.token, 'utf8'))
  vi.mocked(ConversationClient.connect).mockResolvedValue(client)
  await sendConversation(session.id, 'restarted', 'restart-new-process')
  await expect
    .poll(async () => JSON.stringify((await client.snapshot(session.id)).entries))
    .toContain('updated-argument')
  expect((await client.snapshot(session.id)).session.launchProfileId).toBe(profile.id)
  await client.close(session.id)
})

it('keeps pinned default commands after plugin update and disablement', async () => {
  const first = await createConversation(window, {
    provider: 'test.launch-provider',
    cwd: fixture.root
  })
  const second = await createConversation(window, {
    provider: 'test.launch-provider',
    cwd: fixture.root
  })
  const manifestPath = join(fixture.root, 'plugin', 'clave-plugin.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.version = '2.0.0'
  manifest.provider.command = command('updated-registry-default')
  writeFileSync(manifestPath, JSON.stringify(manifest))
  registry.installPrepared(registry.prepareUpdate('test.launch'))
  for (const [snapshot, disabled] of [
    [first, false],
    [second, true]
  ] as const) {
    registry.setEnabled('test.launch', !disabled)
    await sendConversation(snapshot.session.id, 'pinned default', `pinned-${disabled}`)
    const entries = JSON.stringify((await client.snapshot(snapshot.session.id)).entries)
    expect(entries).toContain('registry-default')
    expect(entries).not.toContain('updated-registry-default')
    await client.close(snapshot.session.id)
  }
  await expect(
    createConversation(window, {
      provider: 'test.launch-provider',
      cwd: fixture.root
    })
  ).rejects.toThrow()
})
