/**
 * A provider connection (PRDCT-4426) as an instance of the one definition of
 * a connection (PRDCT-4493, `connection.ts`): a key stored once, in its
 * company's pool, reporting no usage.
 */
import type { ProviderConnectionView } from '@clave/contract/settings'
import { CONNECTION_POOL_BY_ID, type Connection, type ConnectionPool } from './connection'

/** A stored provider connection (PRDCT-4426) as the one shape every harness
 *  reads (PRDCT-4493): a key, in the company's pool, usable once its key is
 *  stored or when it needs none, reporting no usage. */
export function providerConnection(view: ProviderConnectionView): Connection {
  return {
    id: view.id,
    label: view.label,
    pool: view.company,
    company: view.company,
    kind: 'key',
    usable: view.hasKey || !view.needsKey,
    reportsUsage: false,
    usage: undefined
  }
}

/** The pool a stored provider connection belongs to: its company's. */
export function providerPoolOf(view: ProviderConnectionView): ConnectionPool {
  return CONNECTION_POOL_BY_ID[view.company]
}
