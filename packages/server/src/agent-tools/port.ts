/**
 * The agent tools port: what the server needs from whoever writes a Claude
 * session's `--mcp-config` and keeps the tokens those files carry (wave 4,
 * lane C, PRDCT-3376). Inside the app the shell's MCP runtime is that
 * writer, and nobody asks the server (main reads its own map); the standalone
 * entry gives the same store over its data directory, told the shell's MCP
 * address by `AnnounceAgentTools`. `none` is a server with no writer behind
 * it: an announce and a resolve say so rather than pretend.
 */
import { Context, Layer } from 'effect'
import { CapabilityUnavailable } from '@clave/contract/errors'
import type { AgentTokenOwner } from '@clave/contract/agent-tools'

export interface AgentTokensService {
  /** Where the tools answer, from now on: the per-session configs written
   *  after this point the address; the ones written before keep theirs. */
  readonly announce: (url: string) => void
  /** The session that minted the token and its window, undefined when no
   *  config of this host carries it. */
  readonly resolve: (token: string) => AgentTokenOwner | undefined
}

const NO_AGENT_TOOLS = new CapabilityUnavailable({
  capability: 'agent-tools',
  message: 'This server writes no agent tool config: nothing here mints or resolves a token.'
})

export class AgentTokens extends Context.Tag('@clave/server/AgentTokens')<
  AgentTokens,
  AgentTokensService
>() {
  static layer(service: AgentTokensService): Layer.Layer<AgentTokens> {
    return Layer.succeed(AgentTokens, service)
  }
  static readonly none: AgentTokensService = {
    announce: () => {
      throw NO_AGENT_TOOLS
    },
    resolve: () => {
      throw NO_AGENT_TOOLS
    }
  }
}
