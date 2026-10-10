/**
 * The agent tools domain's handlers: the announce and the resolve go to the
 * port, and what it throws becomes the declared failure. A token nobody
 * minted is `AgentTokenUnknown`, never a 500 and never a silent empty answer:
 * the caller is main's MCP server deciding whether to let a request in.
 */
import { Effect } from 'effect'
import { CommandHandler } from '@structure-ai/cqrs'
import { CapabilityUnavailable } from '@clave/contract/errors'
import {
  AgentTokenUnknown,
  AnnounceAgentTools,
  ResolveAgentToken
} from '@clave/contract/agent-tools'
import { AgentTokens } from './port'

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const unavailable = (error: unknown): CapabilityUnavailable =>
  error instanceof CapabilityUnavailable
    ? error
    : new CapabilityUnavailable({ capability: 'agent-tools', message: messageOf(error) })

export const agentToolsHandlers = [
  CommandHandler.make(AnnounceAgentTools, (payload) =>
    Effect.flatMap(AgentTokens, (tokens) =>
      Effect.try({ try: () => tokens.announce(payload.url), catch: unavailable })
    )
  ),
  CommandHandler.make(ResolveAgentToken, (payload) =>
    Effect.flatMap(AgentTokens, (tokens) =>
      Effect.try({ try: () => tokens.resolve(payload.token), catch: unavailable }).pipe(
        Effect.flatMap((owner) =>
          owner ? Effect.succeed(owner) : Effect.fail(new AgentTokenUnknown())
        )
      )
    )
  )
] as const
