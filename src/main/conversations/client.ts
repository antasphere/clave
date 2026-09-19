import { createConnection, type Socket } from 'node:net'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SESSION_PROTOCOL_VERSION,
  type ConversationOptions,
  type ConversationSnapshot,
  type ConversationSession,
  type ConversationEnvelope,
  type AgentResponse
} from '../../shared/agent-session'
import type { AdapterLaunch } from './adapter'
import type {
  ArtifactInput,
  ConversationArtifact,
  PluginBindings,
  PluginJob,
  PluginPin
} from '../../shared/runtime-plugins'
import { servicePaths, receive, transmit, type ServiceCommand } from './wire'
import type { AttachedSessionView, LegacyImportState } from '../../shared/session-migration'
import { builtinPlugins } from '../runtime-plugins/builtins'

interface ClientOptions {
  userData: string
  daemonPath?: string
  executablePath?: string
}

export class ConversationClient {
  private nextId = 0
  private serverInfo: {
    protocolVersion: number
    pid?: number
    capabilities: string[]
    builtinRevision?: string
  } = {
    protocolVersion: SESSION_PROTOCOL_VERSION,
    capabilities: []
  }
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >()
  private listeners = new Set<(event: ConversationEnvelope) => void>()
  private constructor(private socket: Socket) {
    socket.on('error', () => {})
    socket.on('close', () => {
      for (const request of this.pending.values()) {
        clearTimeout(request.timer)
        request.reject(
          new Error('Conversation service disconnected; command outcome may be unknown')
        )
      }
      this.pending.clear()
    })
  }

  static async connect(options: ClientOptions): Promise<ConversationClient> {
    const paths = servicePaths(options.userData)
    let spawned = false
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        const token = readFileSync(paths.token, 'utf8')
        return await this.attach(paths.socket, token)
      } catch (error) {
        if ((error as Error).message === 'Conversation protocol mismatch') throw error
        if ((error as Error).message === 'Conversation handshake rejected') {
          let old: ConversationClient | undefined
          try {
            old = await this.attach(paths.socket, readFileSync(paths.token, 'utf8'), 1)
          } catch {
            /* Not a legacy owner. */
          }
          if (old) {
            old.disconnect()
            throw new Error(
              'This profile has a conversation service from an older build. Its sessions were left running. Use Settings → Agents → Restart background service, or use a separate dev:ui profile.'
            )
          }
        }
        if (!spawned) {
          spawned = true
          const child = spawn(
            options.executablePath ?? process.execPath,
            [
              options.daemonPath ?? join(__dirname, 'conversation-daemon.js'),
              '--conversation-daemon',
              options.userData
            ],
            { detached: true, stdio: 'ignore', env: daemonEnvironment() }
          )
          child.on('error', () => {})
          child.unref()
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
    throw new Error('Could not connect to the conversation service')
  }

  static attach(
    path: string,
    token: string,
    protocolVersion = SESSION_PROTOCOL_VERSION
  ): Promise<ConversationClient> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(path)
      const client = new ConversationClient(socket)
      let ready = false
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error('Conversation handshake timed out'))
      }, 2000)
      socket.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      socket.once('close', () => {
        clearTimeout(timer)
        if (!ready) reject(new Error('Conversation handshake rejected'))
      })
      socket.once('connect', () => transmit(socket, { hello: protocolVersion, token }))
      receive(socket, (message) => {
        if (!ready) {
          if (!('ready' in message) || message.ready !== protocolVersion) {
            clearTimeout(timer)
            socket.destroy()
            reject(new Error('Conversation protocol mismatch'))
            return
          }
          ready = true
          client.serverInfo = {
            protocolVersion: message.ready,
            pid: message.pid,
            capabilities: message.capabilities ?? [],
            builtinRevision: message.builtinRevision
          }
          clearTimeout(timer)
          resolve(client)
        } else if ('event' in message) {
          for (const listener of client.listeners) {
            try {
              listener(message.event)
            } catch {
              /* independent subscribers */
            }
          }
        } else if ('id' in message && !('command' in message)) {
          const request = client.pending.get(message.id)
          if (!request) return
          client.pending.delete(message.id)
          clearTimeout(request.timer)
          if (message.error) request.reject(new Error(message.error))
          else request.resolve(message.result)
        }
      })
    })
  }

  private request<T>(command: ServiceCommand, launch?: AdapterLaunch): Promise<T> {
    if (this.socket.destroyed) return Promise.reject(new Error('Conversation service disconnected'))
    const providerPin =
      command.type === 'create' || command.type === 'prepare-legacy-import'
        ? command.options.pluginBindings?.provider
        : command.type === 'bind-plugins'
          ? command.bindings.provider
          : launch?.options.pluginBindings?.provider
    // Protocol compatibility does not mean the detached process loaded the same
    // provider code. Reject before it records a prompt or consumes its command ID.
    // Existing connected adapters send without a launch and remain usable.
    if (
      providerPin &&
      builtinPlugins().some((plugin) => plugin.manifest.id === providerPin.pluginId) &&
      providerPin.revision !== this.serverInfo.builtinRevision
    ) {
      return Promise.reject(
        new Error(
          'The background service is running a different Clave build. No message was submitted. Use Settings → Agents → Restart background service before starting this provider. Existing agents were left running.'
        )
      )
    }
    if (
      ['legacy-import-mappings', 'prepare-legacy-import', 'complete-legacy-import'].includes(
        command.type
      ) &&
      !this.serverInfo.capabilities.includes('legacy-import')
    ) {
      return Promise.reject(
        new Error(
          'This background service does not support session migration. Use Settings → Agents → Restart background service. Its sessions have been left running.'
        )
      )
    }
    if (this.pending.size >= 64) return Promise.reject(new Error('Too many conversation requests'))
    const id = ++this.nextId
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(
          new Error('Conversation command timed out; outcome may be unknown. It was not replayed.')
        )
      }, 30000)
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer })
      transmit(this.socket, { id, command, launch })
    })
  }
  create(options: ConversationOptions, launch: AdapterLaunch): Promise<ConversationSnapshot> {
    return this.request({ type: 'create', options }, launch)
  }
  getServerInfo(): {
    protocolVersion: number
    pid?: number
    capabilities: string[]
    builtinRevision?: string
  } {
    return structuredClone(this.serverInfo)
  }
  shutdown(): Promise<void> {
    return this.request({ type: 'shutdown' })
  }
  legacyImportMappings(): Promise<Record<string, string>> {
    return this.request({ type: 'legacy-import-mappings' })
  }
  prepareLegacyImport(
    options: ConversationOptions,
    launch: AdapterLaunch,
    legacyImport: LegacyImportState,
    view?: AttachedSessionView
  ): Promise<ConversationSnapshot> {
    return this.request({ type: 'prepare-legacy-import', options, legacyImport, view }, launch)
  }
  completeLegacyImport(sessionId: string): Promise<ConversationSnapshot> {
    return this.request({ type: 'complete-legacy-import', sessionId })
  }
  list(): Promise<ConversationSession[]> {
    return this.request({ type: 'list' })
  }
  snapshot(sessionId: string): Promise<ConversationSnapshot> {
    return this.request({ type: 'snapshot', sessionId })
  }
  send(sessionId: string, text: string, commandId: string, launch?: AdapterLaunch): Promise<void> {
    return this.request({ type: 'send', sessionId, text, commandId }, launch)
  }
  interrupt(sessionId: string): Promise<void> {
    return this.request({ type: 'interrupt', sessionId })
  }
  respond(sessionId: string, response: AgentResponse): Promise<void> {
    return this.request({ type: 'respond', sessionId, response })
  }
  close(sessionId: string): Promise<void> {
    return this.request({ type: 'close', sessionId })
  }
  bindPlugins(sessionId: string, bindings: PluginBindings): Promise<void> {
    return this.request({ type: 'bind-plugins', sessionId, bindings })
  }
  pinView(sessionId: string, pin: PluginPin): Promise<PluginPin> {
    return this.request({ type: 'pin-view', sessionId, pin })
  }
  publishArtifact(
    sessionId: string,
    artifact: ArtifactInput,
    commandId: string
  ): Promise<ConversationArtifact> {
    return this.request({ type: 'publish-artifact', sessionId, artifact, commandId })
  }
  executePluginJob(
    sessionId: string,
    plugin: PluginPin,
    argv: string[],
    requestId: string,
    env: Record<string, string>
  ): Promise<PluginJob> {
    return this.request({ type: 'plugin-job-execute', sessionId, plugin, argv, requestId, env })
  }
  readPluginJob(sessionId: string, plugin: PluginPin, jobId: string): Promise<PluginJob> {
    return this.request({ type: 'plugin-job-read', sessionId, plugin, jobId })
  }
  cancelPluginJob(sessionId: string, plugin: PluginPin, jobId: string): Promise<PluginJob> {
    return this.request({ type: 'plugin-job-cancel', sessionId, plugin, jobId })
  }
  updateMetadata(
    sessionId: string,
    metadata: {
      title?: string
      workspaceId?: string | null
      windowKey?: string
      view?: AttachedSessionView | null
    }
  ): Promise<void> {
    return this.request({ type: 'update-metadata', sessionId, metadata })
  }
  onEvent(callback: (event: ConversationEnvelope) => void): () => void {
    this.listeners.add(callback)
    return () => {
      this.listeners.delete(callback)
    }
  }
  isConnected(): boolean {
    return !this.socket.destroyed && this.socket.writable
  }
  disconnect(): void {
    this.socket.destroy()
    this.listeners.clear()
  }
}

function daemonEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1' }
  for (const key of [
    'HOME',
    'USERPROFILE',
    'PATH',
    'SystemRoot',
    'WINDIR',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG'
  ]) {
    if (process.env[key]) env[key] = process.env[key]
  }
  return env
}
