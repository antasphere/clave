/**
 * What a window's `pty:restart` may ask of a restart, read off the IPC
 * message in its own shape only (PRDCT-4300): the account fields, the
 * resend of the message a limit rejected, the Resume precondition, and the
 * provider switch (the adapter, the model, the thread to resume or the first
 * message to send, the note the first card reads). Anything else, or a field
 * of the wrong shape, is left out, never thrown on. The server's road is the
 * contract's `RestartSession` payload; this is the IPC road's twin.
 */
import type { ContinuedFrom } from '@clave/contract/sessions'
import type { RestartOverrides } from '../pty-manager'

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/** The first card's note, taken only in its own shape. */
export function continuedFromOf(v: unknown): ContinuedFrom | undefined {
  if (!v || typeof v !== 'object') return undefined
  const { provider, road } = v as { provider?: unknown; road?: unknown }
  return typeof provider === 'string' && (road === 'converted' || road === 'handoff')
    ? { provider, road }
    : undefined
}

export function restartOverridesFromWire(raw: unknown): RestartOverrides {
  const overrides = (raw ?? {}) as Record<string, unknown>
  return {
    claudeProfileId: str(overrides.claudeProfileId),
    claudeProfileLabel: str(overrides.claudeProfileLabel),
    codexAccountId: str(overrides.codexAccountId),
    codexAccountLabel: str(overrides.codexAccountLabel),
    resendRejected: overrides.resendRejected === true,
    onlyIfStopped: overrides.onlyIfStopped === true,
    adapterId: str(overrides.adapterId),
    model: str(overrides.model),
    resume: str(overrides.resume),
    firstMessage: str(overrides.firstMessage),
    continuedFrom: continuedFromOf(overrides.continuedFrom)
  }
}
