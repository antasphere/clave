/**
 * What every domain module of the client is built on: the request client the
 * framework derives from the shared `ClaveApi` type, and `call`, which runs
 * one request on it and turns the Effect's failure into a thrown error (the
 * two transport errors, or the declared business failure as the tagged error
 * it is). `api.ts` makes one `call` per endpoint and hands it to each domain.
 */
import type { Effect } from 'effect'
import * as StructureClient from '@structure-ai/client'
import { ClaveApi } from '@clave/contract/api'

/** How the request client is derived. Its return type is left to inference
 *  on purpose: it is the framework's mapped type over every group of the
 *  API, and naming it by hand is what `DerivedClient` below exists to avoid. */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export const deriveClient = (options: StructureClient.ClientOptions) =>
  StructureClient.make(ClaveApi, options)

export type DerivedClient = Effect.Effect.Success<ReturnType<typeof deriveClient>>

export type Call = <A, E>(run: (client: DerivedClient) => Effect.Effect<A, E>) => Promise<A>
