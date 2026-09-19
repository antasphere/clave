import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { Socket } from 'node:net'
import type { ConversationCommand, ConversationEnvelope } from '../../shared/agent-session'
import type { AdapterLaunch } from './adapter'
import type { PluginBindings, PluginPin } from '../../shared/runtime-plugins'
import type { ConversationOptions } from '../../shared/agent-session'
import type { AttachedSessionView, LegacyImportState } from '../../shared/session-migration'

export const MAX_FRAME = 8 * 1024 * 1024
export type ServiceCommand =
  | ConversationCommand
  | { type: 'shutdown' }
  | { type: 'legacy-import-mappings' }
  | {
      type: 'prepare-legacy-import'
      options: ConversationOptions
      legacyImport: LegacyImportState
      view?: AttachedSessionView
    }
  | { type: 'complete-legacy-import'; sessionId: string }
  | {
      type: 'update-metadata'
      sessionId: string
      metadata: {
        title?: string
        workspaceId?: string | null
        windowKey?: string
        view?: AttachedSessionView | null
      }
    }
  | { type: 'bind-plugins'; sessionId: string; bindings: PluginBindings }
  | { type: 'pin-view'; sessionId: string; pin: PluginPin }
  | {
      type: 'plugin-job-execute'
      sessionId: string
      plugin: PluginPin
      argv: string[]
      requestId: string
      env: Record<string, string>
    }
  | { type: 'plugin-job-read'; sessionId: string; plugin: PluginPin; jobId: string }
  | { type: 'plugin-job-cancel'; sessionId: string; plugin: PluginPin; jobId: string }
export interface WireRequest {
  id: number
  command: ServiceCommand
  launch?: AdapterLaunch
}
export type WireMessage =
  | { hello: number; token: string }
  | { ready: number; pid?: number; capabilities?: string[]; builtinRevision?: string }
  | WireRequest
  | { id: number; result?: unknown; error?: string }
  | { event: ConversationEnvelope }

export function servicePaths(userData: string): {
  directory: string
  socketDirectory: string
  socket: string
  token: string
} {
  const directory = join(userData, 'conversation-service')
  const hash = createHash('sha256').update(userData).digest('hex').slice(0, 24)
  // macOS sockaddr_un is only 104 bytes. userData can exceed that before the filename.
  const socketDirectory =
    process.platform === 'win32' ? directory : `/tmp/clave-${process.getuid?.() ?? 'user'}-${hash}`
  return {
    directory,
    socketDirectory,
    token: join(directory, 'token'),
    socket:
      process.platform === 'win32'
        ? `\\\\.\\pipe\\clave-conversations-${hash}`
        : join(socketDirectory, 'daemon.sock')
  }
}

/** Length-prefixed UTF-8 avoids unbounded partial-line buffering. */
export function receive(socket: Socket, callback: (message: WireMessage) => void): void {
  let buffer = Buffer.alloc(0)
  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    while (buffer.length >= 4) {
      const length = buffer.readUInt32BE(0)
      if (!length || length > MAX_FRAME) {
        socket.destroy()
        return
      }
      if (buffer.length < length + 4) break
      const frame = buffer.subarray(4, length + 4)
      buffer = buffer.subarray(length + 4)
      try {
        callback(JSON.parse(frame.toString('utf8')))
      } catch {
        socket.destroy()
        return
      }
    }
    if (buffer.length > MAX_FRAME + 4) socket.destroy()
  })
}

export function transmit(socket: Socket, message: WireMessage): void {
  const body = Buffer.from(JSON.stringify(message))
  if (body.length > MAX_FRAME || socket.writableLength > MAX_FRAME) {
    socket.destroy(new Error('Conversation connection exceeded buffer limit'))
    return
  }
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length)
  socket.write(Buffer.concat([header, body]))
}
