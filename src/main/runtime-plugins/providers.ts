import { createRequire } from 'node:module'
import { z } from 'zod'
import type { ConversationEvent } from '../../shared/agent-session'
import type { AdapterFactory, ConversationAdapter } from '../conversations/adapter'
import { capabilitiesSchema } from './manifest'
import type { RuntimePluginRegistry } from './registry'

const id = z.string().min(1).max(256)
const text = z.string().max(4 * 1024 * 1024)
const short = z.string().max(4096)
const eventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('status'),
    status: z.enum(['starting', 'idle', 'running', 'waiting', 'stopped', 'error', 'closed']),
    error: short.optional()
  }),
  z.strictObject({ type: z.literal('capabilities'), capabilities: capabilitiesSchema }),
  z.strictObject({ type: z.literal('provider-session'), providerSessionId: id }),
  z.strictObject({
    type: z.literal('message'),
    message: z.strictObject({
      kind: z.literal('message'),
      id,
      role: z.literal('assistant'),
      text
    })
  }),
  z.strictObject({ type: z.literal('text-delta'), messageId: id, text }),
  z.strictObject({
    type: z.literal('tool'),
    tool: z.strictObject({
      kind: z.literal('tool'),
      id,
      name: short,
      input: text.optional(),
      output: text.optional(),
      status: z.enum(['running', 'completed', 'failed'])
    })
  }),
  z.strictObject({
    type: z.literal('artifact'),
    artifact: z.strictObject({
      kind: z.literal('artifact'),
      id,
      title: short,
      mimeType: z.enum(['text/html', 'text/markdown', 'text/plain', 'application/json']),
      content: text,
      fallback: text,
      sourceUrl: z.string().max(4096).optional()
    })
  }),
  z.strictObject({
    type: z.literal('request'),
    request: z.strictObject({
      id,
      kind: z.enum(['permission', 'question']),
      title: short,
      description: short.optional(),
      choices: z.array(short).max(100).optional()
    })
  }),
  z.strictObject({ type: z.literal('request-resolved'), requestId: id }),
  z.strictObject({
    type: z.literal('turn-end'),
    outcome: z.enum(['completed', 'interrupted', 'failed']),
    error: short.optional()
  })
])

/** Provider entry IDs cannot overwrite host-owned user messages or artifacts. */
export function normalizeProviderEvent(value: unknown): ConversationEvent {
  const event = eventSchema.parse(value)
  switch (event.type) {
    case 'message':
      event.message.id = `plugin:${event.message.id}`
      break
    case 'text-delta':
      event.messageId = `plugin:${event.messageId}`
      break
    case 'tool':
      event.tool.id = `plugin:${event.tool.id}`
      break
    case 'artifact':
      event.artifact.id = `plugin:${event.artifact.id}`
      break
  }
  return event
}

function validateAdapter(value: unknown): ConversationAdapter {
  if (!value || typeof value !== 'object')
    throw new Error('Plugin createAdapter must return an adapter')
  for (const method of ['start', 'send', 'interrupt', 'respond', 'dispose'])
    if (typeof value[method] !== 'function')
      throw new Error(`Plugin adapter is missing ${method}()`)
  capabilitiesSchema.parse(value['capabilities'])
  return value as ConversationAdapter
}

/**
 * Native provider code has full daemon privileges. Validation is a protocol
 * boundary, not containment against malicious code. No module is loaded until start.
 */
export function createPluginAdapterFactory(registry: RuntimePluginRegistry): AdapterFactory {
  return (launch, emit) => {
    const resolved = registry.resolveProvider(
      launch.options.provider,
      launch.options.pluginBindings?.provider
    )
    // Builtins are registered factories, with the same lookup and revision rules.
    if (resolved.factory) return resolved.factory(launch, emit)
    let adapter: ConversationAdapter | undefined
    let disposed = false
    const requireAdapter = (): ConversationAdapter => {
      if (!adapter) throw new Error('Plugin adapter has not started')
      return adapter
    }
    return {
      capabilities: resolved.capabilities,
      async start() {
        if (disposed || adapter) throw new Error('Plugin adapter cannot be started again')
        // Recheck stored bytes immediately before module evaluation.
        const current = registry.resolveProvider(
          launch.options.provider,
          resolved.descriptor.plugin
        )
        if (!current.entryPath) throw new Error('Missing plugin provider entry')
        const module: unknown = createRequire(current.entryPath)(current.entryPath)
        if (!module || typeof module !== 'object' || typeof module['createAdapter'] !== 'function')
          throw new Error('Plugin module must export createAdapter(launch, emit)')
        const safeEmit = (value: unknown): void => {
          if (disposed) return
          let event: ConversationEvent
          try {
            event = normalizeProviderEvent(value)
          } catch {
            emit({
              type: 'status',
              status: 'error',
              error: 'Plugin emitted an invalid conversation event'
            })
            return
          }
          emit(event)
        }
        adapter = validateAdapter(module['createAdapter'](launch, safeEmit))
        const actual = adapter.capabilities
        for (const key of ['permissions', 'questions', 'resume'] as const) {
          if (actual[key] !== resolved.capabilities[key])
            throw new Error(`Plugin capability differs from manifest: ${key}`)
        }
        await adapter.start()
      },
      async send(text) {
        await requireAdapter().send(text)
      },
      async interrupt() {
        await requireAdapter().interrupt()
      },
      async respond(response) {
        await requireAdapter().respond(response)
      },
      async dispose() {
        disposed = true
        await adapter?.dispose()
      }
    }
  }
}
