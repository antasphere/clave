/**
 * The decisions domain on the server (PRDCT-5179): each command one call on
 * the port. A tab that got no reading is an answer (`reason`), not a failure
 * of the call; what the port THROWS is the server saying it asks no decision
 * at all, `CapabilityUnavailable`. Every tab whose record the host wrote is
 * published as `session.projects_read`, once the host wrote, never before,
 * as `ChangeSessionWork` publishes `session.work_changed`.
 */
import { Effect } from 'effect'
import { CommandHandler } from '@structure-ai/cqrs'
import { CapabilityUnavailable } from '@clave/contract/errors'
import { ReadTabProjects } from '@clave/contract/decisions'
import { ServerEvents } from '../events'
import { DecisionsPort } from './port'

const unavailable = (error: unknown): CapabilityUnavailable =>
  error instanceof CapabilityUnavailable
    ? error
    : new CapabilityUnavailable({
        capability: 'decisions',
        message: error instanceof Error && error.message ? error.message : String(error)
      })

export const decisionHandlers = [
  CommandHandler.make(ReadTabProjects, (p) =>
    Effect.gen(function* () {
      const port = yield* DecisionsPort
      const read = yield* Effect.tryPromise({
        try: () => port.readTabProjects(p.sessionIds),
        catch: unavailable
      })
      const events = yield* ServerEvents
      for (const tab of read)
        if (tab.written)
          yield* events.publish({
            _tag: 'session.projects_read',
            id: tab.sessionId,
            projects: tab.projects
          })
      return {
        tabs: read.map(({ sessionId, projects, reason }) => ({
          sessionId,
          projects,
          ...(reason !== undefined && { reason })
        }))
      }
    })
  )
] as const
