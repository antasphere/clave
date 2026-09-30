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
    heldBack: null,
    heldBackAt: null,
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

  it("does not show on a remote tab, which runs another machine's CLI", () => {
    expect(
      staleAgentRelease({ ...claudeTab, sessionType: 'remote-claude' }, [agent({})], undefined)
    ).toBeNull()
    expect(
      staleAgentRelease({ ...claudeTab, sessionType: 'local' }, [agent({})], undefined)
    ).not.toBeNull()
  })

  it('shows on the boundary only for a tab strictly older than the upgrade', () => {
    expect(staleAgentRelease({ ...claudeTab, spawnedAt: 500 }, [agent({})], undefined)).toBeNull()
    expect(
      staleAgentRelease({ ...claudeTab, spawnedAt: 499 }, [agent({})], undefined)
    ).not.toBeNull()
  })

  it("takes Claude's agents view as Claude, without a resume", () => {
    expect(
      staleAgentRelease(
        { alive: true, claudeAgentsMode: true, spawnedAt: 1 },
        [agent({})],
        undefined
      )
    ).toMatchObject({ agent: { id: 'claude' }, resumable: false })
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
    expect(agentStatusLine(agent({ installed: false, lastCheckedAt: null }), true)).toBe(
      'Not checked yet'
    )
  })

  it('never promises an install the installer does not have', () => {
    const lagging = agent({
      install: { kind: 'homebrew', name: 'codex', cask: true },
      currentVersion: '0.159.0',
      latestVersion: '0.159.1',
      updateAvailable: true,
      lastUpdatedAt: null,
      heldBack: '0.159.1',
      heldBackAt: 1
    })
    expect(agentStatusLine(lagging, true)).toBe(
      'Homebrew does not offer 0.159.1 yet. Clave tries again tomorrow.'
    )
    expect(agentStatusLine(lagging, false)).toBe('Homebrew does not offer 0.159.1 yet.')
    expect(agentStatusLine({ ...lagging, latestVersion: '0.160.0' }, true)).toBe(
      '0.160.0 is available and will be installed shortly'
    )
  })
})
