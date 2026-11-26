/**
 * The decisions port (PRDCT-5179): what the server needs from whoever asks
 * Jev, TypeSafe's decision model, with the Jev key of its machine. The app's
 * implementation (`src/main/decisions/host.ts`, `hostDecisions`) reads a tab
 * from its record and its transcript, asks, and writes the reading on the
 * record; a server with nothing behind it runs on `DecisionsPort.none`, which
 * refuses every call as unavailable.
 */
import { Context, Layer } from 'effect'
import { CapabilityUnavailable } from '@clave/contract/errors'
import type { TabProjectsRead } from '@clave/contract/decisions'

/** One tab's answer, and whether its record was written by this call: the
 *  handler publishes `session.projects_read` for the written ones alone. */
export type TabProjectsReadOnHost = TabProjectsRead & { readonly written: boolean }

export interface DecisionsService {
  /** Which projects each tab works on, each tab on its own, none failing
   *  the others. */
  readonly readTabProjects: (
    sessionIds: ReadonlyArray<string>
  ) => Promise<ReadonlyArray<TabProjectsReadOnHost>>
}

const NO_DECISIONS = new CapabilityUnavailable({
  capability: 'decisions',
  message: 'This server asks no decision.'
})
const refuse = (): Promise<never> => Promise.reject(NO_DECISIONS)

export class DecisionsPort extends Context.Tag('@clave/server/Decisions')<
  DecisionsPort,
  DecisionsService
>() {
  static layer(service: DecisionsService): Layer.Layer<DecisionsPort> {
    return Layer.succeed(DecisionsPort, service)
  }
  /** A server with no decisions behind it: every call says so. */
  static readonly none: DecisionsService = { readTabProjects: refuse }
}
