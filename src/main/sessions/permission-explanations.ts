/**
 * The permission explainer's trigger (PRDCT-4331), where the session runs:
 * in the app's own process and on a standalone Clave server alike, so no
 * Electron here. Every permission request of every provider that is not a
 * question is read by the explainer helper; its answer goes back into the
 * session's stream as a `permission_explained` event keyed by the request's
 * id, so every client shows it, the server's history keeps it with the
 * conversation, and a view that subscribes late is handed what was read.
 *
 * The one rule of the level lives here, on the host: the rules' floor
 * (`permission-risk.ts`) is computed first, and the model's level can only
 * raise it. The reading never approves or refuses anything.
 */
import type { SessionHostService } from '@clave/server'
import type { SessionEvent, SessionStream } from '../../shared/session-model'
import type { HelperOutcome } from '../helpers/registry'
import { isExplainable, riskFloor, shownLevel, toolDescription } from '../../shared/permission-risk'
import {
  parseExplainerReply,
  type ExplainerInput,
  type ExplainerReading
} from '../../shared/permission-explainer'

export type PermissionExplained = Extract<SessionEvent, { type: 'permission_explained' }>
type PermissionRequest = Extract<SessionEvent, { type: 'permission_request' }>

/** How many readings a session keeps for its late views. */
export const HELD_PER_SESSION = 100
/** What of the agent's words the explainer reads: their end. */
const AGENT_WORDS_CHARS = 800

export interface ExplainingHostOptions {
  host: SessionHostService
  subscribeAll: (listener: (id: string, value: SessionStream) => void) => () => void
  subscribeRemoved?: (listener: (id: string) => void) => () => void
  /** Into the session's stream, as the adapter's own events go. */
  publish: (id: string, event: PermissionExplained) => void
  /** Run the explainer for a session (the helper on the session's account),
   *  under an owner of its own so it can be ended. */
  explain: (
    sessionId: string,
    input: ExplainerInput,
    owner: string
  ) => Promise<HelperOutcome<ExplainerReading>>
  /** End a reading nobody waits on any more (its request answered or
   *  withdrawn): waiting, it never starts; running, its CLI is ended. */
  cancel?: (owner: string) => void
  /** Every request that leaves pending, whoever settled it (an answer from
   *  any client, a withdrawal, the session's end): the pending-requests
   *  service's own word. */
  onSettled?: (listener: (sessionId: string, providerRequestId: string) => void) => () => void
}

const withLevel = (
  event: PermissionExplained,
  level: PermissionExplained['level'] | null
): PermissionExplained => (level ? { ...event, level } : event)

/** A request the explainer reads: a tool to allow, never a question, an
 *  elicitation or a question whose input did not parse (`permission-risk.ts`). */
export { isExplainable }

export function explainingSessionHost(options: ExplainingHostOptions): {
  host: SessionHostService
  close: () => void
  /** What was read for a session's requests, in the order they were read. */
  explanationsOf: (sessionId: string) => PermissionExplained[]
} {
  const { host: base } = options
  const held = new Map<string, Map<string, PermissionExplained>>()
  /** The request each key was asked for: a request asked again under the
   *  same id with the same content is not read twice; a different one (a
   *  restarted process counting its ids from the start) is. */
  const asked = new Map<string, string>()
  /** The reading in flight for each key, by its owner. */
  const inflight = new Map<string, string>()
  let readings = 0
  /** The request is answered or withdrawn: its reading, if still running or
   *  waiting, is ended, and whatever it would have said is dropped. */
  const settle = (sessionId: string, id: string): void => {
    const key = keyOf(sessionId, id)
    const owner = inflight.get(key)
    if (owner === undefined) return
    inflight.delete(key)
    options.cancel?.(owner)
  }
  const said = new Map<string, { asked?: string; words: string }>()
  const keyOf = (sessionId: string, id: string): string => `${sessionId}\u0000${id}`
  const contextOf = (sessionId: string): { asked?: string; words: string } => {
    let context = said.get(sessionId)
    if (!context) said.set(sessionId, (context = { words: '' }))
    return context
  }
  const hear = (sessionId: string, text: string): void => {
    const context = contextOf(sessionId)
    context.asked = text
    context.words = ''
  }

  const explain = (sessionId: string, request: PermissionRequest): void => {
    if (!isExplainable(request)) return
    const key = keyOf(sessionId, request.id)
    let signature: string
    try {
      signature = JSON.stringify([request.toolName, request.input ?? null])
    } catch {
      signature = `${request.toolName}:${Date.now()}`
    }
    if (asked.get(key) === signature) return
    asked.set(key, signature)
    const cwd = base.get(sessionId)?.cwd
    const toolName = request.toolName!
    const floor = riskFloor({ toolName, input: request.input, cwd })
    const context = contextOf(sessionId)
    const input: ExplainerInput = {
      toolName,
      toolDescription: toolDescription(toolName),
      input: request.input,
      ...(request.detail && { reason: request.detail }),
      ...(context.asked && { asked: context.asked }),
      ...(context.words.trim() && { agentWords: context.words.slice(-AGENT_WORDS_CHARS) }),
      ...(cwd && { cwd }),
      floor
    }
    const owner = `${key}\u0000${++readings}`
    const previous = inflight.get(key)
    if (previous !== undefined) options.cancel?.(previous)
    inflight.set(key, owner)
    void options
      .explain(sessionId, input, owner)
      .catch(
        (error: unknown): HelperOutcome<ExplainerReading> => ({
          ok: false,
          reason: 'failed',
          detail: error instanceof Error ? error.message : String(error)
        })
      )
      .then((outcome) => {
        // Answered or withdrawn meanwhile, a newer request took the id, or
        // the session went: nobody reads this one.
        if (inflight.get(key) !== owner) return
        inflight.delete(key)
        if (asked.get(key) !== signature) return
        if (!outcome.ok && outcome.reason === 'cancelled') return
        const event: PermissionExplained = outcome.ok
          ? withLevel(
              {
                type: 'permission_explained',
                id: request.id,
                sentence: outcome.value.sentence,
                asked: outcome.value.asked
              },
              // The model raises what the rules found, may give an unknown
              // request an upper level, never says "reads only" by itself.
              shownLevel(floor, outcome.value.level)
            )
          : withLevel(
              { type: 'permission_explained', id: request.id, failed: outcome.reason },
              shownLevel(floor)
            )
        let readings = held.get(sessionId)
        if (!readings) held.set(sessionId, (readings = new Map()))
        readings.delete(request.id)
        readings.set(request.id, event)
        while (readings.size > HELD_PER_SESSION) readings.delete(readings.keys().next().value!)
        try {
          options.publish(sessionId, event)
        } catch {
          /* the session is gone with its views */
        }
      })
  }

  const off = options.subscribeAll((sessionId, stream) => {
    if (stream.kind !== 'event') return
    const event = stream.event
    if ('parent' in event && event.parent) return
    if (event.type === 'user_message') {
      if (!event.form) hear(sessionId, event.text)
    } else if (event.type === 'assistant_text') {
      const context = contextOf(sessionId)
      context.words = (context.words + event.delta).slice(-4 * AGENT_WORDS_CHARS)
    } else if (event.type === 'permission_request') explain(sessionId, event)
    else if (event.type === 'permission_withdrawn') settle(sessionId, event.id)
  })
  const offSettled = options.onSettled?.(settle)
  const forget = (sessionId: string): void => {
    const prefix = keyOf(sessionId, '')
    for (const [key, owner] of [...inflight])
      if (key.startsWith(prefix)) {
        inflight.delete(key)
        options.cancel?.(owner)
      }
    held.delete(sessionId)
    said.delete(sessionId)
    for (const key of [...asked.keys()]) if (key.startsWith(prefix)) asked.delete(key)
  }
  const offRemoved = options.subscribeRemoved?.(forget)

  return {
    close: () => {
      off()
      offRemoved?.()
      offSettled?.()
    },
    explanationsOf: (sessionId) => [...(held.get(sessionId)?.values() ?? [])],
    host: {
      ...base,
      subscribe: (id, listener) => {
        const unsubscribe = base.subscribe(id, listener)
        // A view that subscribes late reads what was already read, after the
        // requests themselves (the request-aware host hands them first).
        for (const event of held.get(id)?.values() ?? []) listener({ kind: 'event', event })
        return unsubscribe
      },
      write: async (id, input) => {
        // The person's own message, as it leaves for the agent: what the
        // next request is matched against.
        const value = input as { type: string; text?: unknown; form?: unknown }
        if (value.type === 'user_message' && typeof value.text === 'string' && !value.form)
          hear(id, value.text)
        // The person answered: the reading of that request is no longer read.
        const answered = input as { type: string; id?: unknown }
        if (answered.type === 'permission_response' && typeof answered.id === 'string')
          settle(id, answered.id)
        return base.write(id, input)
      }
    }
  }
}

/** The harness's reading (PRDCT-4331): no model under the end-to-end
 *  harness. A spec hands the model's reply in CLAVE_E2E_EXPLAINER_REPLY,
 *  read the way a real one is, after a beat (CLAVE_E2E_EXPLAINER_DELAY_MS,
 *  800 ms by default) so the reading state shows; without one, no sentence. */
export function testReading(
  env: Record<string, string | undefined>
): Promise<HelperOutcome<ExplainerReading>> {
  const reply = env.CLAVE_E2E_EXPLAINER_REPLY
  if (!reply)
    return Promise.resolve({ ok: false, reason: 'disabled', detail: 'No model under test' })
  const delay = Number(env.CLAVE_E2E_EXPLAINER_DELAY_MS ?? 800)
  return new Promise((resolve) =>
    setTimeout(() => {
      const value = parseExplainerReply(reply)
      resolve(
        value
          ? { ok: true, value, attempts: 1, model: 'test' }
          : { ok: false, reason: 'unreadable', detail: 'Unreadable test reply' }
      )
    }, delay)
  )
}
