import { API_VERSION, type PluginAPI, type PluginCommandHandler, type PluginSession } from './api'
import type { PluginManifest, PluginPermission } from './manifest'

export type RPCId = string | number
export interface RPCRequest {
  jsonrpc: '2.0'
  id: RPCId
  method: string
  params?: unknown
}
export interface RPCNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}
export interface RPCError {
  code: number
  message: string
  data?: unknown
}
export type RPCResponse =
  | { jsonrpc: '2.0'; id: RPCId; result: unknown }
  | { jsonrpc: '2.0'; id: RPCId; error: RPCError }
export type RPCMessage = RPCRequest | RPCNotification | RPCResponse
export interface PluginTransport {
  postMessage(message: RPCMessage): void
  subscribe(listener: (message: unknown) => void): () => void
}

export class PluginPermissionError extends Error {
  readonly code = -32001
  readonly data: { permission: PluginPermission }
  constructor(readonly permission: PluginPermission) {
    super(`Plugin permission denied: ${permission}`)
    this.name = 'PluginPermissionError'
    this.data = { permission }
  }
}

const methodPermissions: Record<string, PluginPermission> = {
  'sessions.list': 'sessions.read',
  'sessions.get': 'sessions.read',
  'sessions.subscribe': 'sessions.read',
  'sessions.focused': 'sessions.read',
  'sessions.unsubscribe': 'sessions.read',
  'sessions.send': 'sessions.write',
  'secrets.request': 'secrets'
}

/** Called in the host for every request; the utility process is not trusted. */
export function assertMethodPermission(
  manifest: PluginManifest,
  grants: readonly PluginPermission[],
  method: string,
  params?: unknown
): void {
  const permission = methodPermissions[method]
  if (permission) {
    if (!manifest.permissions.includes(permission) || !grants.includes(permission)) {
      throw new PluginPermissionError(permission)
    }
    return
  }
  if (
    method === 'ui.registerPanel' ||
    method === 'ui.registerCommand' ||
    method === 'ui.registerToolbar'
  ) {
    const id = typeof params === 'object' && params !== null && 'id' in params ? params.id : null
    const contributions =
      method === 'ui.registerPanel'
        ? manifest.contributes.panels
        : method === 'ui.registerCommand'
          ? manifest.contributes.commands
          : manifest.contributes.toolbar
    if (!contributions.some((entry) => entry.id === id)) {
      throw Object.assign(new Error(`Undeclared contribution: ${String(id)}`), { code: -32001 })
    }
    return
  }
  if (method === 'notify' || method === 'log') return
  throw Object.assign(new Error(`Unknown plugin method: ${method}`), { code: -32601 })
}

export function createPluginAPI(
  transport: PluginTransport,
  options: { timeoutMs?: number } = {}
): { api: PluginAPI; dispose(): void } {
  let sequence = 0
  let disposed = false
  const pending = new Map<
    RPCId,
    {
      resolve(value: unknown): void
      reject(error: Error): void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  const commands = new Map<string, PluginCommandHandler>()
  const listeners = new Set<(sessions: PluginSession[]) => void>()
  const contextListeners = new Set<(session: PluginSession | null) => void>()
  const request = <T>(
    method: string,
    params: unknown = {},
    timeoutMs = options.timeoutMs ?? 30_000
  ): Promise<T> => {
    if (disposed) return Promise.reject(new Error('Plugin API has been disposed'))
    return new Promise<T>((resolve, reject) => {
      const id = ++sequence
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`Plugin request timed out: ${method}`))
      }, timeoutMs)
      pending.set(id, { resolve: (value) => resolve(value as T), reject, timer })
      try {
        transport.postMessage({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        clearTimeout(timer)
        pending.delete(id)
        reject(error)
      }
    })
  }
  const unsubscribe = transport.subscribe((raw) => {
    if (disposed || !raw || typeof raw !== 'object' || !('jsonrpc' in raw) || raw.jsonrpc !== '2.0')
      return
    const message = raw as RPCMessage
    if (!('method' in message)) {
      const entry = pending.get(message.id)
      if (!entry) return
      clearTimeout(entry.timer)
      pending.delete(message.id)
      if ('error' in message) {
        entry.reject(
          Object.assign(new Error(message.error.message), {
            code: message.error.code,
            data: message.error.data
          })
        )
      } else entry.resolve(message.result)
      return
    }
    // The host pushes the focused session unasked, to every plugin allowed to read
    // sessions: a surface that draws the focused folder must not have to poll for it.
    if (message.method === 'context.changed' && !('id' in message)) {
      const params = message.params as { session?: PluginSession | null } | undefined
      for (const listener of contextListeners) {
        try {
          listener(params?.session ?? null)
        } catch {
          /* A listener cannot break transport dispatch. */
        }
      }
    }
    if (
      message.method === 'sessions.changed' &&
      !('id' in message) &&
      Array.isArray(message.params)
    ) {
      for (const listener of listeners) {
        try {
          listener(message.params as PluginSession[])
        } catch {
          /* A listener cannot break transport dispatch. */
        }
      }
    }
    if (message.method === 'commands.execute' && 'id' in message) {
      const params = message.params as { id?: string; args?: unknown } | undefined
      const handler = params?.id ? commands.get(params.id) : undefined
      void Promise.resolve()
        .then(() => {
          if (!handler)
            throw Object.assign(new Error('Command is not registered'), { code: -32601 })
          return handler(params?.args)
        })
        .then(
          (result) => {
            if (!disposed)
              transport.postMessage({ jsonrpc: '2.0', id: message.id, result: result ?? null })
          },
          (error: unknown) => {
            if (!disposed)
              transport.postMessage({
                jsonrpc: '2.0',
                id: message.id,
                error: {
                  code:
                    typeof error === 'object' &&
                    error !== null &&
                    'code' in error &&
                    typeof error.code === 'number'
                      ? error.code
                      : -32603,
                  message: error instanceof Error ? error.message : String(error)
                }
              })
          }
        )
        .catch(() => {
          /* The host may have closed the port during command completion. */
        })
    }
  })
  const api: PluginAPI = {
    version: API_VERSION,
    sessions: {
      list: () => request('sessions.list'),
      get: (id) => request('sessions.get', { id }),
      send: (id, text) => request('sessions.send', { id, text }),
      focused: () => request('sessions.focused'),
      onContextChanged: (listener) => {
        contextListeners.add(listener)
        return () => contextListeners.delete(listener)
      },
      subscribe: async (listener) => {
        listeners.add(listener)
        try {
          await request('sessions.subscribe')
        } catch (error) {
          listeners.delete(listener)
          throw error
        }
        return () => {
          listeners.delete(listener)
          if (!listeners.size && !disposed) void request('sessions.unsubscribe').catch(() => {})
        }
      }
    },
    ui: {
      registerPanel: (id) => request('ui.registerPanel', { id }),
      registerToolbar: (id) => request('ui.registerToolbar', { id }),
      registerCommand: async (id, handler) => {
        const previous = commands.get(id)
        commands.set(id, handler)
        try {
          await request('ui.registerCommand', { id })
        } catch (error) {
          if (previous) commands.set(id, previous)
          else commands.delete(id)
          throw error
        }
      }
    },
    notify: (params) => request('notify', params),
    secrets: {
      request: (params) => request('secrets.request', params, options.timeoutMs ?? 125_000)
    },
    log: (level, message) => request('log', { level, message })
  }
  return {
    api,
    dispose() {
      if (disposed) return
      disposed = true
      unsubscribe()
      listeners.clear()
      contextListeners.clear()
      commands.clear()
      for (const entry of pending.values()) {
        clearTimeout(entry.timer)
        entry.reject(new Error('Plugin API has been disposed'))
      }
      pending.clear()
    }
  }
}
