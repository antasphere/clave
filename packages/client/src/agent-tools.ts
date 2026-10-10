/**
 * The agent tools domain of the client (wave 4, lane C): the attached shell
 * announces where its MCP server answers, and main asks which session a
 * token it does not know belongs to. A token nobody minted throws the
 * contract's `AgentTokenUnknown`, like every declared failure.
 */
import type { AgentTokenOwner } from '@clave/contract/agent-tools'
import type { Call } from './call'

export interface AgentToolsClient {
  readonly announce: (url: string) => Promise<void>
  readonly resolveToken: (token: string) => Promise<AgentTokenOwner>
}

export const agentToolsClient = (call: Call): AgentToolsClient => ({
  announce: (url) => call((c) => c.agentTools.announce({ payload: { url } })).then(() => undefined),
  resolveToken: (token) => call((c) => c.agentTools.resolveToken({ payload: { token } }))
})
