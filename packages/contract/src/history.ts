/**
 * The History of a server (PRDCT-4321): the conversations its own tabs ran,
 * read on its own disk, for every client connected to it.
 *
 * A server remembers each conversation one of its tabs held, and keeps it
 * after the tab is closed or deleted: the transcript stays on the server's
 * disk, so the conversation can still be reopened there. A client lists it
 * beside its own History, tagged with the server, and a Resume reopens it on
 * that server. The server lists only what its own tabs ran, never every
 * transcript its disk holds, so a client on the same machine as its server
 * never sees a conversation twice.
 *
 * Two reads, both queries: the list, and a search of the listed transcripts.
 * A server with nothing behind the port answers `CapabilityUnavailable`; a
 * server older than this domain answers the router's 404, which the client
 * turns into `HistoryMissing` (`packages/client/src/history.ts`).
 */
import { Schema } from 'effect'
import { Query } from '@structure-ai/cqrs'
import { ApiGroup, HttpCqrs } from '@structure-ai/http'
import { CapabilityUnavailable } from './errors'

/** What the conversation was last launched on, field by field, so a Resume
 *  brings it back the same way (the ledger's launch fields, PRDCT-4236). The
 *  account is the SERVER's own account id and label. */
export const HistoryLaunch = Schema.Struct({
  dangerous: Schema.optional(Schema.Boolean),
  permissionMode: Schema.optional(Schema.String),
  effort: Schema.optional(Schema.String),
  accountId: Schema.optional(Schema.String),
  accountLabel: Schema.optional(Schema.String)
})
export type HistoryLaunch = typeof HistoryLaunch.Type

/** One conversation a tab of this server ran. */
export const HistoryConversation = Schema.Struct({
  /** Claude Code's session id: the transcript's file name. */
  conversationId: Schema.NonEmptyString,
  /** The server tab that last held it. */
  sessionId: Schema.String,
  /** The tab's name as last seen. */
  name: Schema.String,
  /** Claude Code's own title, read from the transcript's tail. */
  title: Schema.NullOr(Schema.String),
  cwd: Schema.String,
  model: Schema.NullOr(Schema.String),
  /** The server group the tab last lived in: the server's own id and name. */
  groupId: Schema.NullOr(Schema.String),
  groupName: Schema.NullOr(Schema.String),
  /** The server workspace the tab belonged to, the server's own id. */
  workspaceId: Schema.NullOr(Schema.String),
  /** ISO timestamps: first seen, and the last human message (else the last
   *  sighting, else the file's time), so a client's sort is total. */
  firstSeenAt: Schema.String,
  lastHumanAt: Schema.String,
  lastPrompt: Schema.NullOr(Schema.String),
  /** Whether the transcript is still on the server's disk. */
  transcript: Schema.Literal('present', 'gone'),
  /** `running`: a tab of the server runs it now; `stopped`: a stopped tab
   *  still holds it (its Resume restarts that tab); `closed`: no tab holds
   *  it any more, a Resume opens a new tab on the conversation. */
  held: Schema.Literal('running', 'stopped', 'closed'),
  launch: Schema.optional(HistoryLaunch),
  /** The server's launch profile the tab ran on (its chat view, its own
   *  profile), so a Resume reopens it the same way. */
  launchProfileId: Schema.optional(Schema.String)
})
export type HistoryConversation = typeof HistoryConversation.Type

export const ServerHistory = Schema.Struct({
  conversations: Schema.Array(HistoryConversation)
})
export type ServerHistory = typeof ServerHistory.Type

export const HistorySearchScope = Schema.Literal('human', 'agent', 'tools')
export type HistorySearchScope = typeof HistorySearchScope.Type

export const HistorySearchHit = Schema.Struct({
  conversationId: Schema.String,
  ts: Schema.NullOr(Schema.String),
  scope: HistorySearchScope,
  /** A window of the matching text around the match. */
  excerpt: Schema.String
})
export type HistorySearchHit = typeof HistorySearchHit.Type

export const HistorySearchResult = Schema.Struct({
  hits: Schema.Array(HistorySearchHit),
  filesSearched: Schema.Number,
  /** The search stopped early: capped, or out of time. */
  truncated: Schema.Boolean
})
export type HistorySearchResult = typeof HistorySearchResult.Type

export const ListServerHistory = Query.define('ListServerHistory', {
  payload: Schema.Struct({}),
  success: ServerHistory,
  failure: CapabilityUnavailable
})

/** A search of the listed conversations' transcripts. The scopes and the ids
 *  travel comma-joined, as a query's payload is decoded from the URL. */
export const SearchServerHistory = Query.define('SearchServerHistory', {
  payload: Schema.Struct({
    query: Schema.String,
    scopes: Schema.optional(Schema.split(',')),
    /** The conversations to search, comma-joined; absent, every listed one. */
    ids: Schema.optional(Schema.split(',')),
    maxHits: Schema.optional(Schema.NumberFromString.pipe(Schema.int(), Schema.between(1, 500)))
  }),
  success: HistorySearchResult,
  failure: CapabilityUnavailable
})
export type SearchServerHistoryRequest = typeof SearchServerHistory.payload.Type

export const historyGroup = ApiGroup.make('history')
  .add(HttpCqrs.queryEndpoint('list', '/history/list', ListServerHistory))
  .add(HttpCqrs.queryEndpoint('search', '/history/search', SearchServerHistory))
