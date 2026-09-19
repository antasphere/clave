import { createServer, createConnection, type Server, type Socket } from 'node:net'
import {
  mkdirSync,
  chmodSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  lstatSync
} from 'node:fs'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import { SESSION_PROTOCOL_VERSION } from '../../shared/agent-session'
import type { AdapterFactory } from './adapter'
import { ConversationService } from './service'
import { receive, transmit, servicePaths, type WireRequest } from './wire'
import { RuntimePluginJobs } from '../runtime-plugins/jobs'
import { RuntimePluginRegistry } from '../runtime-plugins/registry'
import { createPluginAdapterFactory } from '../runtime-plugins/providers'
import { builtinPlugins } from '../runtime-plugins/builtins'

function isAlive(socket: string): Promise<boolean> {
  return new Promise((resolve) => {
    const connection = createConnection(socket)
    connection.setTimeout(1000)
    connection.once('connect', () => {
      connection.destroy()
      resolve(true)
    })
    connection.once('error', () => resolve(false))
    connection.once('timeout', () => {
      connection.destroy()
      resolve(true)
    })
  })
}

/** A kernel-held loopback listener elects the owner. It accepts no commands.
 * A hash collision fails closed rather than replacing another owner's socket.
 */
export async function startDaemon(
  userData: string,
  factory: AdapterFactory
): Promise<Server | undefined> {
  const paths = servicePaths(userData)
  mkdirSync(paths.directory, { recursive: true, mode: 0o700 })
  chmodSync(paths.directory, 0o700)
  mkdirSync(paths.socketDirectory, { recursive: true, mode: 0o700 })
  const socketDirectory = lstatSync(paths.socketDirectory)
  if (
    !socketDirectory.isDirectory() ||
    (process.getuid && socketDirectory.uid !== process.getuid())
  )
    throw new Error('Unsafe conversation socket directory')
  chmodSync(paths.socketDirectory, 0o700)
  const lock = join(paths.directory, 'owner.json')
  const election = createServer((socket) => socket.destroy())
  const port = 49152 + (createHash('sha256').update(paths.socket).digest().readUInt16BE(0) % 16384)
  try {
    await new Promise<void>((resolve, reject) => {
      election.once('error', reject)
      election.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
        election.removeListener('error', reject)
        resolve()
      })
    })
  } catch {
    if (await isAlive(paths.socket)) return
    throw new Error(
      `Conversation owner election port ${port} is occupied. Wait for startup or choose another user-data directory.`
    )
  }
  const release = (): void => {
    try {
      if (JSON.parse(readFileSync(lock, 'utf8')).pid === process.pid) unlinkSync(lock)
    } catch {
      /* already removed */
    }
    election.close()
  }
  try {
    if (await isAlive(paths.socket)) {
      election.close()
      return
    }
    writeFileSync(
      lock,
      JSON.stringify({ pid: process.pid, port, protocolVersion: SESSION_PROTOCOL_VERSION }),
      { mode: 0o600 }
    )
    if (process.platform !== 'win32' && existsSync(paths.socket)) unlinkSync(paths.socket)
    let token: string
    if (existsSync(paths.token)) token = readFileSync(paths.token, 'utf8')
    else {
      token = randomBytes(32).toString('hex')
      writeFileSync(paths.token, token, { flag: 'wx', mode: 0o600 })
    }
    chmodSync(paths.token, 0o600)
    const service = new ConversationService(join(paths.directory, 'records'), factory)
    const jobs = new RuntimePluginJobs(join(paths.directory, 'plugin-jobs'))
    const sockets = new Set<Socket>()
    const server = createServer((socket) => {
      if (closing) {
        socket.destroy()
        return
      }
      sockets.add(socket)
      let authenticated = false
      let inFlight = 0
      let off: (() => void) | undefined
      const timer = setTimeout(() => socket.destroy(), 5000)
      socket.on('error', () => {})
      socket.on('close', () => {
        sockets.delete(socket)
        clearTimeout(timer)
        off?.()
      })
      receive(socket, (message) => {
        if (!authenticated) {
          if (
            !('hello' in message) ||
            message.hello !== SESSION_PROTOCOL_VERSION ||
            typeof message.token !== 'string'
          ) {
            socket.destroy()
            return
          }
          const actual = Buffer.from(message.token)
          const expected = Buffer.from(token)
          if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
            socket.destroy()
            return
          }
          authenticated = true
          clearTimeout(timer)
          off = service.onEvent((event) => transmit(socket, { event }))
          transmit(socket, {
            ready: SESSION_PROTOCOL_VERSION,
            pid: process.pid,
            capabilities: ['legacy-import', 'shutdown'],
            builtinRevision: builtinPlugins()[0].revision
          })
          return
        }
        if (!('command' in message) || !Number.isSafeInteger(message.id) || ++inFlight > 64) {
          socket.destroy()
          return
        }
        const request = message as WireRequest
        if (request.command.type === 'shutdown') {
          transmit(socket, { id: request.id, result: undefined })
          // Flush the acknowledgement before close destroys subscribed sockets.
          socket.end(() => server.close())
          return
        }
        void dispatch(service, jobs, request)
          .then(
            (result) => transmit(socket, { id: request.id, result }),
            (error: Error) => transmit(socket, { id: request.id, error: error.message })
          )
          .finally(() => {
            --inFlight
          })
      })
    })
    const close = server.close.bind(server)
    let closing = false
    server.close = (callback?: (error?: Error) => void): Server => {
      if (callback) server.once('close', callback)
      if (closing) return server
      closing = true
      for (const socket of sockets) socket.destroy()
      let timer: NodeJS.Timeout | undefined
      void Promise.race([
        Promise.allSettled([service.shutdown(), jobs.dispose()]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 2000)
        })
      ]).finally(() => {
        clearTimeout(timer)
        close()
      })
      return server
    }
    server.maxConnections = 32
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(paths.socket, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    if (process.platform !== 'win32') chmodSync(paths.socket, 0o600)
    server.on('close', release)
    return server
  } catch (error) {
    release()
    throw error
  }
}

async function dispatch(
  service: ConversationService,
  jobs: RuntimePluginJobs,
  { command, launch }: WireRequest
): Promise<unknown> {
  switch (command.type) {
    case 'legacy-import-mappings':
      return service.legacyImportMappings()
    case 'prepare-legacy-import':
      if (!launch) throw new Error('Trusted launch required')
      return service.prepareLegacyImport(
        command.options,
        launch,
        command.legacyImport,
        command.view
      )
    case 'complete-legacy-import':
      return service.completeLegacyImport(command.sessionId)
    case 'create':
      if (!launch) throw new Error('Trusted launch required')
      return service.create(command.options, launch)
    case 'list':
      return service.list()
    case 'snapshot':
      return service.snapshot(command.sessionId)
    case 'send':
      return service.send(command.sessionId, command.text, command.commandId, launch)
    case 'respond':
      return service.respond(command.sessionId, command.response)
    case 'interrupt':
      return service.interrupt(command.sessionId)
    case 'close':
      await jobs.cancelSession(command.sessionId)
      return service.close(command.sessionId)
    case 'update-metadata':
      return service.updateMetadata(command.sessionId, command.metadata)
    case 'bind-plugins':
      return service.bindPlugins(command.sessionId, command.bindings)
    case 'pin-view':
      return service.pinView(command.sessionId, command.pin)
    case 'publish-artifact':
      return service.publishArtifact(command.sessionId, command.artifact, command.commandId)
    case 'plugin-job-execute':
    case 'plugin-job-read':
    case 'plugin-job-cancel': {
      const snapshot = service.snapshot(command.sessionId)
      if (
        !snapshot.session.pluginBindings?.views.some(
          (pin) =>
            pin.pluginId === command.plugin.pluginId &&
            pin.revision === command.plugin.revision &&
            pin.version === command.plugin.version
        )
      ) {
        throw new Error('Plugin job is outside the conversation scope')
      }
      const scope = { sessionId: command.sessionId, plugin: command.plugin }
      if (command.type === 'plugin-job-read') return jobs.read(scope, command.jobId)
      if (command.type === 'plugin-job-cancel') return jobs.cancel(scope, command.jobId)
      if (snapshot.session.status === 'closed') throw new Error('Conversation is closed')
      return jobs.execute({
        ...scope,
        cwd: snapshot.session.cwd,
        argv: command.argv,
        requestId: command.requestId,
        env: command.env
      })
    }
    default:
      throw new Error('Unknown conversation command')
  }
}

if (process.argv.includes('--conversation-daemon')) {
  const userData = process.argv[process.argv.indexOf('--conversation-daemon') + 1]
  if (!userData) process.exit(1)
  void startDaemon(userData, createPluginAdapterFactory(new RuntimePluginRegistry(userData)))
    .then((server) => {
      if (!server) return
      server.once('close', () => process.exit(0))
      const stop = (): void => {
        server.close(() => process.exit(0))
      }
      process.once('SIGTERM', stop)
      process.once('SIGINT', stop)
    })
    .catch(() => {
      // No raw exception logging: spawn errors may contain credentials from provider arguments.
      process.exitCode = 1
    })
}
