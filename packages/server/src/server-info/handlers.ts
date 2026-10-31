/**
 * The server domain's handlers (issue #266). The version asked of an upgrade
 * is checked here, before the port sees it: a version a release tag cannot
 * name is `InvalidUpgradeVersion`, whatever stands behind the port. What the
 * port throws becomes the declared failure, never a 500.
 */
import { Effect } from 'effect'
import { CommandHandler, QueryHandler } from '@structure-ai/cqrs'
import { CapabilityUnavailable } from '@clave/contract/errors'
import {
  GetServerInfo,
  InvalidUpgradeVersion,
  RequestServerUpgrade,
  isReleaseVersion
} from '@clave/contract/server-info'
import { ServerInfoPort } from './port'

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const unavailable = (error: unknown): CapabilityUnavailable =>
  error instanceof CapabilityUnavailable
    ? error
    : new CapabilityUnavailable({ capability: 'server-upgrade', message: messageOf(error) })

const declared = (error: unknown): CapabilityUnavailable | InvalidUpgradeVersion =>
  error instanceof InvalidUpgradeVersion ? error : unavailable(error)

export const serverInfoHandlers = [
  QueryHandler.make(GetServerInfo, () =>
    Effect.flatMap(ServerInfoPort, (port) =>
      Effect.try({ try: () => port.info(), catch: unavailable })
    )
  ),
  CommandHandler.make(RequestServerUpgrade, (payload) =>
    isReleaseVersion(payload.version)
      ? Effect.flatMap(ServerInfoPort, (port) =>
          Effect.try({ try: () => port.requestUpgrade(payload), catch: declared })
        )
      : Effect.fail(
          new InvalidUpgradeVersion({
            message: 'An upgrade takes a release version such as 3.0.0 or 3.0.0-beta.9.'
          })
        )
  )
] as const
