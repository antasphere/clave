/**
 * The clients domain of the typed client: the programs attached to a server,
 * which the Electron shell registers as at boot (ADR 0003).
 */
import type {
  Client,
  ClientKind,
  ClientRegistrationReservation,
  ShellRegistrationIdentity
} from '@clave/contract/clients'
import type { Call } from './call'

export interface RegisterClientInput {
  readonly kind: ClientKind
  readonly name: string
  readonly pid?: number
}

export interface ClientsClient {
  readonly reserveRegistration: (
    input: typeof ShellRegistrationIdentity.Type
  ) => Promise<ClientRegistrationReservation>
  readonly confirmRegistration: (id: string) => Promise<Client>
  readonly releaseRegistration: (id: string) => Promise<void>
  readonly register: (input: RegisterClientInput) => Promise<Client>
  readonly list: () => Promise<ReadonlyArray<Client>>
  readonly unregister: (id: string) => Promise<void>
}

export const clientsClient = (call: Call): ClientsClient => ({
  reserveRegistration: (input) => call((c) => c.clients.reserveRegistration({ payload: input })),
  confirmRegistration: (id) => call((c) => c.clients.confirmRegistration({ payload: { id } })),
  releaseRegistration: (id) =>
    call((c) => c.clients.releaseRegistration({ payload: { id } })).then(() => undefined),
  register: (input) => call((c) => c.clients.register({ payload: input })),
  list: () => call((c) => c.clients.list({ payload: {} })),
  unregister: (id) => call((c) => c.clients.unregister({ payload: { id } })).then(() => undefined)
})
