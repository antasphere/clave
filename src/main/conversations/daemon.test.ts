import { mkdtempSync, readFileSync, rmSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import type { Server } from 'node:net'
import { createConnection, createServer } from 'node:net'
import { createHash } from 'node:crypto'
import { startDaemon } from './daemon'
import { ConversationClient } from './client'
import { servicePaths, transmit, receive } from './wire'
import type { AdapterFactory, EmitConversationEvent } from './adapter'

let server: Server | undefined
const clients: ConversationClient[] = []
let directory: string
afterEach(async () => {
  for (const client of clients.splice(0)) client.disconnect()
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
  server = undefined
  if (directory && process.platform !== 'win32')
    rmSync(servicePaths(directory).socketDirectory, { recursive: true, force: true })
  if (directory) rmSync(directory, { recursive: true, force: true })
})

test('socket authenticates, survives disconnect, and rejects a second owner', async () => {
  directory = mkdtempSync(join(tmpdir(), 'cv-'))
  let emit: EmitConversationEvent = () => {}
  const dispose = vi.fn(async () => {})
  const factory: AdapterFactory = (_launch, callback) => {
    emit = callback
    return {
      capabilities: { permissions: true, questions: true, resume: true },
      start: async () => {},
      send: async () => {},
      respond: async () => {},
      interrupt: async () => {},
      dispose
    }
  }
  server = await startDaemon(directory, factory)
  const paths = servicePaths(directory)
  if (process.platform !== 'win32') {
    expect(statSync(paths.directory).mode & 0o777).toBe(0o700)
    expect(statSync(paths.socket).mode & 0o777).toBe(0o600)
  }
  await expect(ConversationClient.attach(paths.socket, 'wrong-token')).rejects.toThrow()
  expect(await startDaemon(directory, factory)).toBeUndefined()
  const token = readFileSync(paths.token, 'utf8')
  const first = await ConversationClient.attach(paths.socket, token)
  clients.push(first)
  const options = { provider: 'claude' as const, cwd: '/tmp' }
  const created = await first.create(options, {
    options,
    command: ['fake'],
    additionalArgs: [],
    env: {},
    sessionDirectory: directory
  })
  await first.send(created.session.id, 'hello', '1')
  first.disconnect()
  emit({ type: 'text-delta', messageId: 'answer', text: 'after disconnect' })
  const second = await ConversationClient.attach(paths.socket, token)
  clients.push(second)
  const restored = await second.snapshot(created.session.id)
  expect(restored.entries.at(-1)).toMatchObject({ text: 'after disconnect' })
  expect(dispose).not.toHaveBeenCalled()
  await second.close(created.session.id)
  expect(dispose).toHaveBeenCalledTimes(1)
})

test('additive handshake advertises imports and shutdown acknowledges before disconnect', async () => {
  directory = mkdtempSync(join(tmpdir(), 'cv-'))
  const factory = vi.fn() as AdapterFactory
  server = await startDaemon(directory, factory)
  const paths = servicePaths(directory)
  const client = await ConversationClient.attach(paths.socket, readFileSync(paths.token, 'utf8'))
  clients.push(client)
  expect(client.getServerInfo()).toEqual({
    protocolVersion: 2,
    pid: process.pid,
    capabilities: ['legacy-import', 'shutdown'],
    builtinRevision: 'test-builtins-v1'
  })
  const closed = new Promise<void>((resolve) => server!.once('close', resolve))
  await client.shutdown()
  await closed
  server = undefined
  expect(factory).not.toHaveBeenCalled()
})

test('a pre-migration v2 service returns an actionable error without receiving new commands', async () => {
  directory = mkdtempSync(join(tmpdir(), 'cv-'))
  const paths = servicePaths(directory)
  mkdirSync(paths.socketDirectory, { recursive: true })
  const commands: string[] = []
  server = createServer((socket) =>
    receive(socket, (message) => {
      if ('hello' in message) transmit(socket, { ready: 2 })
      else if ('command' in message) {
        commands.push(message.command.type)
        transmit(socket, { id: message.id, result: [] })
      }
    })
  )
  await new Promise<void>((resolve) => server!.listen(paths.socket, resolve))
  const client = await ConversationClient.attach(paths.socket, 'test-only')
  clients.push(client)
  await expect(client.legacyImportMappings()).rejects.toThrow('Restart background service')
  expect(await client.list()).toEqual([])
  expect(commands).toEqual(['list'])
  expect(client.isConnected()).toBe(true)
})

test('invalid protocol and oversized frame are disconnected before commands execute', async () => {
  directory = mkdtempSync(join(tmpdir(), 'cv-'))
  const factory = vi.fn() as AdapterFactory
  server = await startDaemon(directory, factory)
  const paths = servicePaths(directory)
  await new Promise<void>((resolve) => {
    const socket = createConnection(paths.socket)
    socket.on('connect', () =>
      transmit(socket, { hello: 999, token: readFileSync(paths.token, 'utf8') })
    )
    socket.on('close', () => resolve())
  })
  await new Promise<void>((resolve) => {
    const socket = createConnection(paths.socket)
    socket.on('connect', () => {
      const header = Buffer.alloc(4)
      header.writeUInt32BE(0xffffffff)
      socket.write(header)
    })
    socket.on('close', () => resolve())
  })
  expect(factory).not.toHaveBeenCalled()
})

test('dead owner recovery preserves history and does not replay accepted commands', async () => {
  directory = mkdtempSync(join(tmpdir(), 'cv-'))
  const send = vi.fn(async () => {})
  const factory: AdapterFactory = () => ({
    capabilities: { permissions: true, questions: true, resume: true },
    start: async () => {},
    send,
    respond: async () => {},
    interrupt: async () => {},
    dispose: async () => {}
  })
  const paths = servicePaths(directory)
  mkdirSync(paths.directory, { recursive: true })
  // An impossible PID represents a daemon terminated without releasing its owner file.
  writeFileSync(join(paths.directory, 'owner.json'), JSON.stringify({ pid: 2147483647 }))
  writeFileSync(join(paths.directory, 'owner.json.recovery'), '')
  server = await startDaemon(directory, factory)
  const token = readFileSync(paths.token, 'utf8')
  const client = await ConversationClient.attach(paths.socket, token)
  clients.push(client)
  const options = { provider: 'claude' as const, cwd: '/tmp' }
  const launch = {
    options,
    command: ['fake'],
    additionalArgs: [],
    env: {},
    sessionDirectory: directory
  }
  const { session } = await client.create(options, launch)
  await client.send(session.id, 'hello', '1')
  client.disconnect()
  await new Promise<void>((resolve) => server!.close(() => resolve()))
  server = await startDaemon(directory, factory)
  const reconnected = await ConversationClient.attach(paths.socket, token)
  clients.push(reconnected)
  expect((await reconnected.snapshot(session.id)).session.status).toBe('stopped')
  await reconnected.send(session.id, 'hello', '1', launch)
  expect(send).toHaveBeenCalledTimes(1)
})

test('server close disposes owned providers and disconnects clients', async () => {
  directory = mkdtempSync(join(tmpdir(), 'cv-'))
  const dispose = vi.fn(async () => {})
  server = await startDaemon(directory, () => ({
    capabilities: { permissions: true, questions: true, resume: true },
    start: async () => {},
    send: async () => {},
    respond: async () => {},
    interrupt: async () => {},
    dispose
  }))
  const paths = servicePaths(directory)
  const client = await ConversationClient.attach(paths.socket, readFileSync(paths.token, 'utf8'))
  clients.push(client)
  const options = { provider: 'claude' as const, cwd: '/tmp' }
  const { session } = await client.create(options, {
    options,
    command: ['fake'],
    additionalArgs: [],
    env: {},
    sessionDirectory: directory
  })
  await client.send(session.id, 'hello', '1')
  await new Promise<void>((resolve) => server!.close(() => resolve()))
  server = undefined
  expect(dispose).toHaveBeenCalledTimes(1)
  server = await startDaemon(directory, () => {
    throw new Error('Should not resume')
  })
  expect(server).toBeDefined()
})

test('an occupied election port fails explicitly without taking ownership', async () => {
  directory = mkdtempSync(join(tmpdir(), 'cv-'))
  const paths = servicePaths(directory)
  const port = 49152 + (createHash('sha256').update(paths.socket).digest().readUInt16BE(0) % 16384)
  const blocker = createServer((socket) => socket.destroy())
  await new Promise<void>((resolve) => blocker.listen(port, '127.0.0.1', resolve))
  const factory = vi.fn() as AdapterFactory
  try {
    await expect(startDaemon(directory, factory)).rejects.toThrow(/election port .* occupied/)
    expect(factory).not.toHaveBeenCalled()
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()))
  }
})
