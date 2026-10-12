/**
 * The agent tools domain (wave 4, lane C, PRDCT-3376): how a Claude session
 * the SERVER starts reaches Clave's agent tools, which run in the desktop
 * app. The tools' MCP server lives in Electron main and recognises a caller
 * by a per-session bearer token the session's `--mcp-config` file carries.
 * That file is written by whichever process spawns the session: inside the
 * app, main's own MCP runtime; on a server running apart from the app, the
 * server, under its own data directory. For that the server must know where
 * the tools answer, and main must be able to read a token it did not mint:
 *
 * - `AnnounceAgentTools`: the attached shell tells the server its MCP
 *   address, once its MCP server listens. Until then the server writes no
 *   config and a Claude session starts without the flag (no tools, said in
 *   the ADR), never with a wrong address.
 * - `ResolveAgentToken`: main, on a token it does not know, asks the server
 *   which session minted it, and in which window that session lives; the
 *   server answers from the configs it wrote. A command rather than a
 *   query, so the token travels in a request body and never in a URL. Main
 *   asks on every call and caches nothing: the server stays the authority
 *   on a session that ended.
 */
import { Schema } from 'effect'
import { Command } from '@structure-ai/cqrs'
import { ApiGroup, HttpCqrs } from '@structure-ai/http'
import { CapabilityUnavailable } from './errors'

/** No session's config carries that token on this server. */
export class AgentTokenUnknown extends Schema.TaggedError<AgentTokenUnknown>()(
  'AgentTokenUnknown',
  {}
) {}

/** Where Clave's agent tools answer: the shell's MCP server address. */
export const AnnounceAgentTools = Command.define('AnnounceAgentTools', {
  payload: Schema.Struct({ url: Schema.NonEmptyString }),
  success: Schema.Void,
  failure: CapabilityUnavailable
})

/** The session a per-session token belongs to, and the window it lives in
 *  (null when the server never bound it to one). */
export const AgentTokenOwner = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  windowKey: Schema.NullOr(Schema.String)
})
export type AgentTokenOwner = typeof AgentTokenOwner.Type

export const ResolveAgentToken = Command.define('ResolveAgentToken', {
  payload: Schema.Struct({ token: Schema.NonEmptyString }),
  success: AgentTokenOwner,
  failure: Schema.Union(AgentTokenUnknown, CapabilityUnavailable)
})

export const agentToolsGroup = ApiGroup.make('agentTools')
  .add(HttpCqrs.commandEndpoint('announce', '/agent-tools/announce', AnnounceAgentTools))
  .add(HttpCqrs.commandEndpoint('resolveToken', '/agent-tools/resolve-token', ResolveAgentToken))
