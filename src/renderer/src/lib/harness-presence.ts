import { chatProfileSource, type LaunchProfile } from '../../../shared/agent-launch'
import type { AgentUpdateStatus } from '../../../shared/agent-updates'

/**
 * Whether a harness counts as present on this Mac (PRDCT-4423): the launcher
 * lists it and Settings → Harnesses shows its settings. Present until a
 * CHECK said otherwise (before the first check main reports every harness as
 * not installed with no check time), and present whatever the check said
 * when the person saved a launch profile of their own for it: a profile's
 * command may be a wrapper that brings the binary itself (a container, a
 * recorder, a server's own), which the PATH check never sees. The built-in
 * profiles and the chat forms derived from a saved one are not a person's
 * own.
 */
export function harnessPresent(
  status: AgentUpdateStatus | undefined,
  profiles: readonly LaunchProfile[]
): boolean {
  if (!status || status.lastCheckedAt === null || status.installed) return true
  return profiles.some((profile) => !profile.builtIn && !chatProfileSource(profile.id))
}
