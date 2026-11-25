/**
 * The decisions domain (PRDCT-5179): the questions a server asks Jev,
 * TypeSafe's decision model, with the Jev key sealed on its machine. The
 * client names the tabs; the server reads them, asks, keeps each answer on
 * the tab's record and publishes `session.projects_read`, and the client
 * never sees the key.
 *
 * - `ReadTabProjects`: which projects each named tab works on, among the
 *   groups of its workspace's `.clave` files. Each tab is answered on its
 *   own, none failing the others: a reading, or the record's old one (or
 *   null) with the reason no new one was made. A tab whose record already
 *   holds a reading made on the same basis is answered from it, unasked.
 */
import { Schema } from 'effect'
import { Command } from '@structure-ai/cqrs'
import { ApiGroup, HttpCqrs } from '@structure-ai/http'
import { CapabilityUnavailable } from './errors'
import { TabProjects } from './tab-projects'

/** Why a tab got no new reading: the runner's own reasons
 *  (`src/main/decisions/runner.ts`, `DecisionFailureReason`; its host's test
 *  holds the two lists equal). `nothing` also says the tab is none this
 *  server can read: not an agent tab of Claude Code, Codex or Pi, no record,
 *  no workspace. */
export const DECISION_FAILURE_REASONS = [
  'no-key',
  'disabled',
  'nothing',
  'refused',
  'unreachable',
  'limit',
  'unreadable',
  'failed',
  'cancelled'
] as const
export type DecisionFailureReason = (typeof DECISION_FAILURE_REASONS)[number]

/** The most tabs one call may name. */
export const READ_TAB_PROJECTS_MAX = 50

const SessionId = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256))

/** One tab's answer. */
export const TabProjectsRead = Schema.Struct({
  sessionId: Schema.String,
  /** The reading the record now holds; null when it holds none. */
  projects: Schema.NullOr(TabProjects),
  /** Absent when a reading was made or the record's was still good. */
  reason: Schema.optional(Schema.Literal(...DECISION_FAILURE_REASONS))
})
export type TabProjectsRead = typeof TabProjectsRead.Type

export const ReadTabProjects = Command.define('ReadTabProjects', {
  payload: Schema.Struct({
    sessionIds: Schema.Array(SessionId).pipe(
      Schema.minItems(1),
      Schema.maxItems(READ_TAB_PROJECTS_MAX)
    )
  }),
  success: Schema.Struct({ tabs: Schema.Array(TabProjectsRead) }),
  failure: CapabilityUnavailable
})

export type ReadTabProjectsRequest = typeof ReadTabProjects.payload.Type
export type ReadTabProjectsResult = typeof ReadTabProjects.success.Type

export const decisionsGroup = ApiGroup.make('decisions').add(
  HttpCqrs.commandEndpoint('readTabProjects', '/decisions/tab-projects', ReadTabProjects)
)
