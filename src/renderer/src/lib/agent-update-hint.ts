import { agentUpdateIdOf, type AgentUpdateStatus } from '../../../shared/agent-updates'

export interface StaleAgentRelease {
  agent: AgentUpdateStatus
  /** The release the tab's process was started on, and the one it could run. */
  from: string
  to: string
  /** Whether a restart brings the conversation back (Claude, Codex). */
  resumable: boolean
}

/**
 * A tab whose process started before its agent CLI was upgraded is running
 * the old release: new models and fixes reach it only through a restart. Null
 * for a plain terminal, a dead tab, a tab started after the upgrade, a tab
 * whose hint was put away for this upgrade, or an agent Clave has not moved.
 */
export function staleAgentRelease(
  session: {
    alive: boolean
    spawnedAt?: number
    claudeMode?: boolean
    codexMode?: boolean
    antigravityMode?: boolean
    piMode?: boolean
  },
  agents: AgentUpdateStatus[],
  dismissedAt: number | undefined
): StaleAgentRelease | null {
  const id = agentUpdateIdOf(session)
  if (!id || !session.alive || session.spawnedAt === undefined) return null
  const agent = agents.find((a) => a.id === id)
  if (!agent?.lastUpdatedAt || !agent.updatedFrom || !agent.currentVersion) return null
  if (session.spawnedAt >= agent.lastUpdatedAt) return null
  if (dismissedAt !== undefined && dismissedAt >= agent.lastUpdatedAt) return null
  return {
    agent,
    from: agent.updatedFrom,
    to: agent.currentVersion,
    resumable: id === 'claude' || id === 'codex'
  }
}
