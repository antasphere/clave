import type { PermissionModeOption } from '../../../src/shared/session-model'

/** The mode after `mode` in the provider's cycle: what Shift+Tab moves to. */
export function nextPermissionMode(mode: string, modes: PermissionModeOption[]): string | null {
  if (!modes.length) return null
  const index = modes.findIndex((m) => m.id === mode)
  return modes[(index + 1) % modes.length].id
}
