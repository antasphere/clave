import type { AgentInstall, AgentUpdateStatus } from '../../../shared/agent-updates'

/** The install, as a quiet badge beside the name. */
export function installLabel(install: AgentInstall | null): string | null {
  if (!install) return null
  switch (install.kind) {
    case 'claude-native':
      return 'Native installer'
    case 'homebrew':
      return install.cask ? 'Homebrew cask' : 'Homebrew'
    case 'package':
      return `${install.manager} global`
    case 'app':
      return install.app
    case 'unknown':
      return 'Unknown installer'
  }
}

export function timeOf(at: number): string {
  const date = new Date(at)
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return date.toDateString() === new Date().toDateString()
    ? `today at ${time}`
    : `${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} at ${time}`
}

/** The row's one line of state, in the order a reader needs it. */
export function agentStatusLine(agent: AgentUpdateStatus, autoUpdate: boolean): string {
  if (agent.phase === 'updating') {
    return agent.latestVersion ? `Updating to ${agent.latestVersion}…` : 'Updating…'
  }
  if (!agent.installed) {
    return agent.lastCheckedAt ? 'Not installed' : 'Not checked yet'
  }
  if (agent.updateAvailable && agent.latestVersion && agent.heldBack === agent.latestVersion) {
    const who = agent.install?.kind === 'homebrew' ? 'Homebrew does not' : 'Its installer does not'
    return autoUpdate
      ? `${who} offer ${agent.latestVersion} yet. Clave tries again tomorrow.`
      : `${who} offer ${agent.latestVersion} yet.`
  }
  if (agent.updateAvailable && agent.latestVersion) {
    return autoUpdate
      ? `${agent.latestVersion} is available and will be installed shortly`
      : `${agent.latestVersion} is available`
  }
  if (agent.lastUpdatedAt && agent.updatedFrom) {
    return `Updated from ${agent.updatedFrom} ${timeOf(agent.lastUpdatedAt)}. Open tabs stay on ${agent.updatedFrom} until restarted.`
  }
  if (agent.note) return agent.note
  if (agent.latestVersion) return 'Up to date'
  return agent.phase === 'checking' ? 'Checking…' : 'Latest release unknown'
}
