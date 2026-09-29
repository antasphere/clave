import { describe, expect, it } from 'vitest'
import { staleAgentRelease } from './agent-update-hint'
import { agentStatusLine } from './agent-update-status'
import type { AgentUpdateStatus } from '../../../shared/agent-updates'

function agent(patch: Partial<AgentUpdateStatus>): AgentUpdateStatus {
  return {
    id: 'claude',
    name: 'Claude',
    command: 'claude',
    installed: true,
    path: '/bin/claude',
    realPath: '/bin/claude',
    install: { kind: 'claude-native' },
    currentVersion: '2.1.290',
    latestVersion: '2.1.290',
    updateAvailable: false,
    phase: 'idle',
    lastCheckedAt: 100,
    lastUpdatedAt: 500,
    updatedFrom: '2.1.285',
    note: null,
    error: null,
    ...patch
  }
}

const claudeTab = { alive: true, claudeMode: true, spawnedAt: 400 }

describe('the restart hint on a tab', () => {
  it('shows on a tab started before its agent was upgraded', () => {
    expect(staleAgentRelease(claudeTab, [agent({})], undefined)).toMatchObject({
      from: '2.1.285',
      to: '2.1.290',
      resumable: true
    })
  })

  it('does not show on a tab started after, a dead tab, or a plain terminal', () => {
    expect(staleAgentRelease({ ...claudeTab, spawnedAt: 600 }, [agent({})], undefined)).toBeNull()
    expect(staleAgentRelease({ ...claudeTab, alive: false }, [agent({})], undefined)).toBeNull()
    expect(staleAgentRelease({ alive: true, spawnedAt: 1 }, [agent({})], undefined)).toBeNull()
  })

  it('does not show for an agent Clave has not moved', () => {
    expect(
      staleAgentRelease(claudeTab, [agent({ lastUpdatedAt: null, updatedFrom: null })], undefined)
    ).toBeNull()
  })

  it('stays put away for the upgrade it was dismissed on, and comes back on the next', () => {
    expect(staleAgentRelease(claudeTab, [agent({})], 500)).toBeNull()
    expect(staleAgentRelease(claudeTab, [agent({ lastUpdatedAt: 900 })], 500)).not.toBeNull()
  })

  it('reads the agent from the tab: a Pi tab takes Pi and cannot resume', () => {
    const pi = agent({ id: 'pi', name: 'Pi', command: 'pi' })
    expect(
      staleAgentRelease({ alive: true, piMode: true, spawnedAt: 1 }, [agent({}), pi], undefined)
    ).toMatchObject({ agent: { id: 'pi' }, resumable: false })
  })
})

describe("an agent row's line", () => {
  it('says what is happening, then what is available, then what moved', () => {
    expect(agentStatusLine(agent({ phase: 'updating' }), true)).toBe('Updating to 2.1.290…')
    expect(agentStatusLine(agent({ installed: false, lastCheckedAt: 1 }), true)).toBe(
      'Not installed'
    )
    expect(agentStatusLine(agent({ updateAvailable: true, latestVersion: '2.1.300' }), false)).toBe(
      '2.1.300 is available'
    )
    expect(agentStatusLine(agent({}), true)).toMatch(
      /^Updated from 2\.1\.285 .*Open tabs stay on 2\.1\.285 until restarted\.$/
    )
    expect(
      agentStatusLine(agent({ lastUpdatedAt: null, note: 'Homebrew does not have 1 yet.' }), true)
    ).toBe('Homebrew does not have 1 yet.')
    expect(agentStatusLine(agent({ lastUpdatedAt: null }), true)).toBe('Up to date')
  })
})
