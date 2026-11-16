/**
 * The loopback pages this server lets a client reach through
 * `/forward/<lease>/…` (PRDCT-4473). Whoever starts such a page on this
 * machine (a Slideless preview, later others) registers its port and hands
 * the lease to the client; the route resolves the lease and nothing else.
 *
 * The target is always `127.0.0.1`: there is no way to register a host, so a
 * lease can never be turned into a road to another machine. A lease is 16
 * random bytes, which a caller holding the server's token still cannot guess
 * for a page it was never told about.
 *
 * Imports `node:crypto` only, so the entries build it without Effect
 * (`@clave/server/forward-registry`).
 */
import { randomBytes } from 'node:crypto'

export interface ForwardTarget {
  readonly port: number
}

export class ForwardRegistry {
  private readonly targets = new Map<string, ForwardTarget>()

  /** Register a loopback port this server itself serves; the lease is 16 random bytes in hex. */
  register(port: number): { readonly lease: string; readonly release: () => void } {
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error(`A forward needs a port between 1 and 65535, not ${String(port)}.`)
    const lease = randomBytes(16).toString('hex')
    const target: ForwardTarget = { port }
    this.targets.set(lease, target)
    return {
      lease,
      // Idempotent, and it only ever removes its own entry.
      release: () => {
        if (this.targets.get(lease) === target) this.targets.delete(lease)
      }
    }
  }

  resolve(lease: string): ForwardTarget | undefined {
    return this.targets.get(lease)
  }

  size(): number {
    return this.targets.size
  }
}
