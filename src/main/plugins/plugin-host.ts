import {
  MessageChannelMain,
  utilityProcess,
  type MessagePortMain,
  type UtilityProcess
} from 'electron'
import { watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { assertMethodPermission, type RPCMessage, type PluginSession } from '@clave/plugin-sdk'
import { pluginFile, PluginStore, type PluginRecord } from './plugin-store'

interface RunningPlugin {
  child: UtilityProcess
  port: MessagePortMain
  stopping: boolean
  subscribed: boolean
  snapshot?: string
  /** Last `context.changed` payload sent, so an unchanged focus is not re-pushed. */
  context?: string
  pending: Map<
    number,
    { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >
}
export interface PluginServices {
  sessions: {
    list: () => PluginSession[]
    send: (id: string, text: string) => void
    /** The session the user is looking at, reported by the renderer that holds it. */
    focused: () => PluginSession | null
  }
  notify: (id: string, title: string, body?: string) => void
  requestSecret: (id: string, title: string, description?: string) => Promise<string | null>
  changed: () => void
  stopped: (id: string) => void
}

export class PluginHost {
  private running = new Map<string, RunningPlugin>()
  private retries = new Map<string, number>()
  private timers = new Map<string, NodeJS.Timeout>()
  private watchers: FSWatcher[] = []
  private poll: NodeJS.Timeout
  private nextId = 1
  private generation = 0
  private closing = false
  constructor(
    readonly store: PluginStore,
    private services: PluginServices,
    private runner = join(__dirname, 'plugin-runner.js')
  ) {
    this.poll = setInterval(() => {
      this.publishSessions()
      this.publishContext()
    }, 500)
    this.poll.unref()
  }
  startAll(): void {
    for (const record of this.store.list()) this.start(record.id)
    this.watchLinks()
  }
  start(id: string): void {
    const record = this.store.get(id)
    if (this.closing || this.running.has(id) || !record.enabled || record.error || !record.manifest)
      return
    if (record.manifest.kind === 'skin') return // The skin lane owns token activation.
    record.generation = ++this.generation
    record.panels = []
    record.commands = []
    record.toolbar = []
    if (!record.manifest.main) {
      record.panels =
        record.manifest.ui === 'surface'
          ? record.manifest.contributes.panels.map((panel) => panel.id)
          : []
      record.status = 'active'
      this.services.changed()
      return
    }
    record.status = 'starting'
    try {
      const main = pluginFile(record.directory, record.manifest.main)
      const { port1, port2 } = new MessageChannelMain()
      // Deliberately do not pass the application's credential-bearing environment.
      const env = Object.fromEntries(
        ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'SystemRoot'].flatMap((key) =>
          process.env[key] ? [[key, process.env[key]!]] : []
        )
      )
      const child = utilityProcess.fork(this.runner, [], {
        cwd: record.directory,
        env,
        stdio: 'pipe',
        serviceName: `Clave plugin: ${id}`
      })
      const running: RunningPlugin = {
        child,
        port: port1,
        stopping: false,
        subscribed: false,
        pending: new Map()
      }
      this.running.set(id, running)
      child.stdout?.on('data', (data) => console.info(`[plugin:${id}] ${data}`))
      child.stderr?.on('data', (data) => console.error(`[plugin:${id}] ${data}`))
      port1.on('message', (event) => {
        void this.receive(record, running, event.data).catch((error) => {
          record.error = `Plugin bridge failed: ${String(error)}`
          this.services.changed()
          child.kill()
        })
      })
      port1.start()
      const startup = setTimeout(() => {
        if (record.status === 'starting' && this.running.get(id) === running) {
          record.error = 'Plugin activation timed out'
          child.kill()
        }
      }, 15_000)
      child.on('exit', (code) => {
        clearTimeout(startup)
        port1.close()
        this.rejectPending(running)
        if (this.running.get(id) !== running) return
        this.running.delete(id)
        record.panels = []
        record.commands = []
        record.toolbar = []
        this.services.stopped(id)
        if (!running.stopping && !this.closing && record.enabled) {
          record.status = 'error'
          const runError = record.error
          record.error = runError ?? `Plugin exited (${code}); restarting with backoff`
          console.error(`[plugins] ${id}: ${record.error}`)
          const attempt = (this.retries.get(id) ?? 0) + 1
          this.retries.set(id, attempt)
          if (attempt <= 5)
            this.timers.set(
              id,
              setTimeout(
                () => {
                  this.timers.delete(id)
                  record.error = undefined
                  this.start(id)
                },
                Math.min(1000 * 2 ** (attempt - 1), 30_000)
              )
            )
          else
            record.error =
              runError ??
              `Plugin exited (${code}); restart limit reached. Disable and enable to retry.`
        }
        this.services.changed()
      })
      child.postMessage({ main }, [port2])
    } catch (error) {
      const running = this.running.get(id)
      if (running) {
        running.stopping = true
        this.running.delete(id)
        this.rejectPending(running)
        running.port.close()
        running.child.kill()
      }
      record.status = 'error'
      record.error = `Plugin startup failed: ${String(error)}`
      console.error(`[plugins] ${id}: ${error}`)
    }
    this.services.changed()
  }
  private async receive(
    record: PluginRecord,
    running: RunningPlugin,
    value: unknown
  ): Promise<void> {
    if (this.running.get(record.id) !== running || running.stopping || !record.enabled) return
    if (!value || typeof value !== 'object' || !('jsonrpc' in value) || value.jsonrpc !== '2.0')
      return
    const message = value as RPCMessage
    if (!('method' in message)) {
      const pending = running.pending.get(Number(message.id))
      if (!pending) return
      running.pending.delete(Number(message.id))
      clearTimeout(pending.timer)
      if ('error' in message)
        pending.reject(new Error(message.error?.message ?? 'Malformed plugin error'))
      else pending.resolve()
      return
    }
    if (!('id' in message)) {
      if (message.method === 'plugin.ready') {
        this.retries.delete(record.id)
        record.status = 'active'
        record.error = undefined
        this.services.changed()
      }
      if (message.method === 'plugin.failed') {
        record.error = String((message.params as { message?: string })?.message)
        record.status = 'error'
        this.services.changed()
        running.child.kill()
      }
      return
    }
    const canReply = (): boolean =>
      this.running.get(record.id) === running && !running.stopping && record.enabled
    try {
      assertMethodPermission(
        record.manifest!,
        record.permissionsGranted,
        message.method,
        message.params
      )
      const params = (message.params ?? {}) as Record<string, unknown>
      const string = (key: string, max = 64_000): string => {
        const v = params[key]
        if (typeof v !== 'string' || !v || v.length > max) throw new Error(`Invalid ${key}`)
        return v
      }
      let result: unknown = null
      switch (message.method) {
        case 'sessions.list':
          result = this.services.sessions.list()
          break
        case 'sessions.get':
          result = this.services.sessions.list().find((s) => s.id === string('id')) ?? null
          break
        case 'sessions.focused':
          result = this.services.sessions.focused()
          break
        case 'sessions.subscribe':
          running.subscribed = true
          running.snapshot = undefined
          this.publishSessions()
          break
        case 'sessions.unsubscribe':
          running.subscribed = false
          break
        case 'sessions.send':
          this.services.sessions.send(string('id'), string('text'))
          break
        case 'ui.registerPanel':
          if (!record.panels.includes(string('id'))) record.panels.push(string('id'))
          this.services.changed()
          break
        case 'ui.registerCommand':
          if (!record.commands.includes(string('id'))) record.commands.push(string('id'))
          this.services.changed()
          break
        case 'ui.registerToolbar':
          if (!record.toolbar.includes(string('id'))) record.toolbar.push(string('id'))
          this.services.changed()
          break
        case 'notify': {
          const title = string('title', 200)
          const body = params.body === undefined ? undefined : string('body', 4000)
          record.lastNotification = { title, body }
          this.services.notify(record.id, title, body)
          this.services.changed()
          break
        }
        case 'secrets.request':
          result = await this.services.requestSecret(
            record.id,
            string('title', 200),
            params.description === undefined ? undefined : string('description', 4000)
          )
          break
        case 'log': {
          const level = string('level')
          if (!['debug', 'info', 'warn', 'error'].includes(level))
            throw new Error('Invalid log level')
          console.info(`[plugin:${record.id}:${level}] ${string('message')}`)
          break
        }
        default:
          throw new Error(`Unknown host method ${message.method}`)
      }
      if (canReply()) running.port.postMessage({ jsonrpc: '2.0', id: message.id, result })
    } catch (error) {
      const e = error as Error & { code?: number; data?: unknown }
      if (canReply()) {
        try {
          running.port.postMessage({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: e.code ?? -32602, message: e.message, data: e.data }
          })
        } catch {
          /* The process may have closed its port while handling this request. */
        }
      }
    }
  }
  private publishSessions(): void {
    for (const [id, running] of this.running) {
      const record = this.store.get(id)
      if (
        !running.subscribed ||
        running.stopping ||
        !record.enabled ||
        !record.permissionsGranted.includes('sessions.read')
      )
        continue
      const snapshot = this.services.sessions.list()
      const serialized = JSON.stringify(snapshot)
      if (serialized !== running.snapshot) {
        running.snapshot = serialized
        running.port.postMessage({ jsonrpc: '2.0', method: 'sessions.changed', params: snapshot })
      }
    }
  }
  /** Push the focused session to every plugin allowed to read sessions, whenever it
   *  changes. Unlike the session list this needs no subscribe: a panel surface is meant
   *  to follow the user's focus from the moment it is opened, and the payload is the same
   *  class of data `sessions.read` already governs. */
  private publishContext(): void {
    for (const [id, running] of this.running) {
      const record = this.store.get(id)
      if (
        running.stopping ||
        !record.enabled ||
        !record.permissionsGranted.includes('sessions.read')
      )
        continue
      const session = this.services.sessions.focused()
      const serialized = JSON.stringify(session)
      if (serialized !== running.context) {
        running.context = serialized
        running.port.postMessage({
          jsonrpc: '2.0',
          method: 'context.changed',
          params: { session }
        })
      }
    }
  }
  /** The renderer reported a new focused session: push it now rather than at the next
   *  poll, so a surface opened by a click draws the folder that click was about. */
  contextChanged(): void {
    this.publishContext()
  }
  execute(id: string, command: string): Promise<void> {
    const record = this.store.get(id)
    const running = this.running.get(id)
    if (
      !record.enabled ||
      record.status !== 'active' ||
      !record.commands.includes(command) ||
      !running
    )
      return Promise.reject(new Error('Command is not active'))
    const requestId = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        running.pending.delete(requestId)
        reject(new Error('Command timed out'))
      }, 125_000)
      running.pending.set(requestId, { resolve, reject, timer })
      try {
        running.port.postMessage({
          jsonrpc: '2.0',
          id: requestId,
          method: 'commands.execute',
          params: { id: command }
        })
      } catch (error) {
        clearTimeout(timer)
        running.pending.delete(requestId)
        reject(error)
      }
    })
  }
  private rejectPending(running: RunningPlugin): void {
    for (const pending of running.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Plugin stopped'))
    }
    running.pending.clear()
  }
  stop(id: string): void {
    clearTimeout(this.timers.get(id))
    this.timers.delete(id)
    const hadRuntimeFailure = this.retries.has(id)
    this.retries.delete(id)
    const record = this.store.get(id)
    record.panels = []
    record.commands = []
    record.toolbar = []
    record.status = 'disabled'
    record.error =
      record.manifest && (hadRuntimeFailure || record.error?.startsWith('Plugin '))
        ? undefined
        : record.error
    this.services.stopped(id)
    const running = this.running.get(id)
    if (running) {
      running.stopping = true
      this.running.delete(id)
      this.rejectPending(running)
      try {
        running.port.postMessage({ jsonrpc: '2.0', method: 'host.deactivate' })
      } catch {
        running.child.kill()
        this.services.changed()
        return
      }
      const timer = setTimeout(() => running.child.kill(), 1000)
      running.child.once('exit', () => clearTimeout(timer))
    }
    this.services.changed()
  }
  reload(): void {
    for (const id of this.running.keys()) this.stop(id)
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.store.discover()
    this.startAll()
    this.services.changed()
  }
  private watchLinks(): void {
    for (const watcher of this.watchers) watcher.close()
    this.watchers = []
    let debounce: NodeJS.Timeout | undefined
    for (const record of this.store.list().filter((r) => r.source === 'link')) {
      try {
        const watcher = watch(record.directory, { recursive: true }, (_event, filename) => {
          if (
            filename
              ?.toString()
              .split(/[\\/]/)
              .some((p) => p === 'node_modules' || p === '.git')
          )
            return
          clearTimeout(debounce)
          debounce = setTimeout(() => {
            if (!this.closing) this.reload()
          }, 300)
        })
        watcher.on('error', (error) => {
          record.error = `Watch failed: ${error.message}`
          this.services.changed()
        })
        this.watchers.push(watcher)
      } catch (error) {
        record.error = `Watch failed: ${String(error)}`
        this.services.changed()
      }
    }
  }
  close(): void {
    this.closing = true
    clearInterval(this.poll)
    for (const watcher of this.watchers) watcher.close()
    for (const timer of this.timers.values()) clearTimeout(timer)
    for (const id of this.running.keys()) this.stop(id)
  }
}
