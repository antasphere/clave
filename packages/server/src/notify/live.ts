/**
 * The notifier as a service of the server (the mobile wave, lane B): built
 * from the ports the entry gave (`PushTargetsPort`, `PushTransportsPort`,
 * `NotifyOptionsPort`), the pending requests, the session host and the
 * settings; subscribed to the server's own events (a session's state, a
 * usage read) and to the requests service's change signal for the life of
 * the server. What the server's events do not carry, the frames of a
 * session's stream and a process's exit, reach it through `NotifySignals`,
 * which the entries feed from where the sessions live
 * (`src/main/server/session-events.ts`).
 */
import { Context, Effect, Layer } from 'effect'
import { hostname } from 'node:os'
import type { SessionEvent } from '@clave/contract/sessions'
import { ServerEvents } from '../events'
import { RequestsPort } from '../requests/port'
import { SessionHost } from '../sessions/port'
import { SettingsSource } from '../settings/port'
import { Notifier } from './dispatcher'
import { NotifyOptionsPort, PushTargetsPort, PushTransportsPort } from './port'

/** What the process hosting the sessions tells the notifier. */
export interface NotifySignals {
  /** A frame of a session's stream, as it passes. */
  readonly streamEvent: (sessionId: string, event: SessionEvent) => void
  /** The session's process ended with `code`; `deliberate` when a stop or a
   *  restart asked for it. */
  readonly exited: (sessionId: string, code: number, deliberate: boolean) => void
  /** A permission_response reached the session for that provider request. */
  readonly requestAnswered: (sessionId: string, providerRequestId: string) => void
}

export class Notify extends Context.Tag('@clave/server/Notify')<Notify, Notifier>() {}

/** The machine's name as a notification says it: the hostname, `.local` dropped. */
export const machineName = (): string => hostname().replace(/\.local$/i, '') || 'Clave'

export const NotifyLive = (options: {
  readonly serverId: string
  readonly log?: (line: string) => void
}): Layer.Layer<
  Notify,
  never,
  | ServerEvents
  | RequestsPort
  | SessionHost
  | SettingsSource
  | PushTargetsPort
  | PushTransportsPort
  | NotifyOptionsPort
> =>
  Layer.scoped(
    Notify,
    Effect.gen(function* () {
      const events = yield* ServerEvents
      const requests = yield* RequestsPort
      const host = yield* SessionHost
      const settings = yield* SettingsSource
      const targets = yield* PushTargetsPort
      const transports = yield* PushTransportsPort
      const opts = yield* NotifyOptionsPort
      const log = options.log ?? ((line: string) => console.log(`[clave-server] ${line}`))
      // A server with no requests service answers CapabilityUnavailable to a
      // snapshot: the notifier then reads the sessions' frames instead.
      const pendingRequests = ((): (() => ReturnType<typeof requests.snapshot>) | null => {
        try {
          requests.snapshot()
          return () => requests.snapshot()
        } catch {
          return null
        }
      })()
      const notifier = new Notifier({
        serverId: options.serverId,
        serverName: opts.serverName ?? machineName(),
        targets,
        transports,
        fake: opts.fake === true,
        session: (id) => {
          const session = host.get(id)
          return session ? { title: session.title, cwd: session.cwd } : undefined
        },
        workspaceName: async (cwd) => {
          const { workspaces } = await settings.workspaces.load()
          let best: { name: string; rootDir: string } | undefined
          for (const w of workspaces)
            if (
              (cwd === w.rootDir || cwd.startsWith(`${w.rootDir.replace(/\/+$/, '')}/`)) &&
              (!best || w.rootDir.length > best.rootDir.length)
            )
              best = w
          return best?.name
        },
        accountLabel: async (provider, accountId) => {
          const accounts =
            provider === 'claude'
              ? await settings.claudeAccounts.list()
              : await settings.codexAccounts.list()
          return accounts.find((a) => a.id === accountId)?.label
        },
        pendingRequests,
        ...(opts.requestGraceMs !== undefined && { requestGraceMs: opts.requestGraceMs }),
        log
      })
      const offRequests = requests.subscribe(() => notifier.requestsChanged())
      const offEvents = events.subscribe(({ event }) => {
        if (event._tag === 'session.state_changed') notifier.sessionState(event.id, event.state)
        else if (event._tag === 'usage.claude_read')
          notifier.usageRead('claude', event.accountId, event.result)
        else if (event._tag === 'usage.codex_read')
          notifier.usageRead('codex', event.accountId, event.result)
      })
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          offRequests()
          offEvents()
          notifier.close()
        })
      )
      return notifier
    })
  )

/** The signals of a notifier, for an entry to feed. */
export const signalsOf = (notifier: Notifier): NotifySignals => ({
  streamEvent: (sessionId, event) => notifier.streamEvent(sessionId, event),
  exited: (sessionId, code, deliberate) => notifier.exited(sessionId, code, deliberate),
  requestAnswered: (sessionId, providerRequestId) =>
    notifier.requestAnswered(sessionId, providerRequestId)
})
