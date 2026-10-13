import { resolveAntasphereIssuer } from './antasphere-account'
import type { AntasphereHandoff } from '../shared/antasphere-account-types'

/**
 * What the shell checks before it opens a browser on a handoff
 * (`ipc-handlers/antasphere-account-handlers.ts`), kept apart from the
 * handler so it runs under vitest without Electron. The shell's own check
 * of what it is about to hand the system, on top of the manager's: a URL at
 * the issuer this process is configured for and no other origin, no
 * credentials in it, and, where the shell holds the manager, the exact
 * handoff issued for the login in flight.
 */

/** A handoff as the preload sends one, or null for anything else. */
export function handoffShape(value: unknown): AntasphereHandoff | null {
  if (typeof value !== 'object' || value === null) return null
  const { url, generation } = value as Partial<AntasphereHandoff>
  if (typeof url !== 'string' || typeof generation !== 'number' || !Number.isInteger(generation))
    return null
  return { url, generation }
}

/** The URL the shell will open for a handoff, or null. */
export function acceptedHandoff(
  handoff: unknown,
  env: NodeJS.ProcessEnv,
  manager: { confirmHandoff(handoff: AntasphereHandoff): boolean } | null
): URL | null {
  const shape = handoffShape(handoff)
  if (!shape) return null
  const issuer = resolveAntasphereIssuer(env)
  if (!issuer.ok) return null
  let target: URL
  try {
    target = new URL(shape.url)
  } catch {
    return null
  }
  if (target.origin !== issuer.config.issuer.origin || target.username || target.password) {
    return null
  }
  if (manager && !manager.confirmHandoff(shape)) return null
  return target
}
