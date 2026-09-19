import { afterEach, expect, test } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:net'
import { ConversationClient } from './client'
import type { AdapterLaunch } from './adapter'
import { receive, servicePaths, transmit, type ServiceCommand } from './wire'
import { builtinPlugins } from '../runtime-plugins/builtins'

let server: Server | undefined
let client: ConversationClient | undefined
let root: string | undefined
afterEach(async () => {
  client?.disconnect()
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
  if (root) {
    if (process.platform !== 'win32')
      rmSync(servicePaths(root).socketDirectory, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})

async function connect(builtinRevision?: string): Promise<{
  client: ConversationClient
  commands: ServiceCommand[]
}> {
  root = mkdtempSync(join(tmpdir(), 'clave-runtime-version-'))
  const paths = servicePaths(root)
  mkdirSync(paths.socketDirectory, { recursive: true })
  const commands: ServiceCommand[] = []
  server = createServer((socket) =>
    receive(socket, (message) => {
      if ('hello' in message) {
        transmit(socket, { ready: 2, capabilities: ['legacy-import', 'shutdown'], builtinRevision })
      } else if ('command' in message) {
        commands.push(message.command)
        transmit(socket, { id: message.id, result: [] })
      }
    })
  )
  await new Promise<void>((resolve) => server!.listen(paths.socket, resolve))
  client = await ConversationClient.attach(paths.socket, 'fixture-only')
  return { client, commands }
}

function launch(
  pluginId = 'builtin.claude',
  revision = builtinPlugins()[0].revision
): AdapterLaunch {
  return {
    options: {
      provider: 'claude',
      cwd: '/fixture',
      pluginBindings: { provider: { pluginId, revision, version: '1.0.0' }, views: [] }
    },
    command: ['fixture'],
    additionalArgs: [],
    env: {},
    sessionDirectory: '/fixture'
  }
}

test.each(['older-build', undefined])(
  'rejects incompatible builtin mutations before sending them to runtime %s',
  async (revision) => {
    const { client, commands } = await connect(revision)
    const input = launch()
    await expect(client.create(input.options, input)).rejects.toThrow('Restart background service')
    await expect(client.send('conversation-fixture', 'unsent draft', 'one', input)).rejects.toThrow(
      'Restart background service'
    )
    await expect(
      client.prepareLegacyImport(input.options, input, {
        sourceId: 'legacy',
        recordKey: 'legacy',
        complete: false
      })
    ).rejects.toThrow('Restart background service')
    await expect(
      client.bindPlugins('conversation-fixture', input.options.pluginBindings!)
    ).rejects.toThrow('Restart background service')
    expect(commands).toEqual([])
    expect(client.isConnected()).toBe(true)
  }
)

test('keeps read, close and already-connected sends available on an older runtime', async () => {
  const { client, commands } = await connect('older-build')
  await client.list()
  await client.snapshot('existing')
  await client.send('existing', 'continue', 'one')
  await client.close('existing')
  expect(commands.map((command) => command.type)).toEqual(['list', 'snapshot', 'send', 'close'])
  expect(client.isConnected()).toBe(true)
})

test('accepts matching builtin launches and independently versioned local plugins', async () => {
  const { client, commands } = await connect(builtinPlugins()[0].revision)
  const builtin = launch()
  await client.create(builtin.options, builtin)
  const plugin = launch('example.provider', 'independent-revision')
  await client.create(plugin.options, plugin)
  expect(commands.map((command) => command.type)).toEqual(['create', 'create'])
})

test('does not tie a local plugin launch to the builtin runtime revision', async () => {
  const { client, commands } = await connect('older-build')
  const plugin = launch('example.provider', 'independent-revision')
  await client.create(plugin.options, plugin)
  expect(commands.map((command) => command.type)).toEqual(['create'])
})
