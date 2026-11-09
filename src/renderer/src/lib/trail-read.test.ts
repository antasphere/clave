/** The message trail reads a Claude tab's conversation under its own account directory (PRDCT-4207). */
import { describe, expect, it, vi } from 'vitest'
import { readTrail } from './trail-read'

const g = globalThis as unknown as Record<string, unknown>

describe('the message trail read', () => {
  it("takes a Claude tab's account directory from the tab, and none for Pi or the shared home", async () => {
    const historyConversation = vi.fn(async () => ({ exists: true, turns: [] }))
    g.window = { electronAPI: { historyConversation } }
    await readTrail({ cwd: '/w', claudeSessionId: 'c1', claudeConfigDir: '/acct' })
    await readTrail({ cwd: '/w', claudeSessionId: 'c2' })
    await readTrail({ cwd: '/w', piSessionId: 'p1', piMode: true, claudeConfigDir: '/acct' })
    expect(historyConversation.mock.calls).toEqual([
      ['/w', 'c1', 'claude', '/acct'],
      ['/w', 'c2', 'claude', undefined],
      ['/w', 'p1', 'pi', undefined]
    ])
  })

  it('reads nothing for a tab with no conversation yet', () => {
    const historyConversation = vi.fn()
    g.window = { electronAPI: { historyConversation } }
    expect(readTrail({ cwd: '/w' })).toBeNull()
    expect(readTrail({ claudeSessionId: 'c1' })).toBeNull()
    expect(historyConversation).not.toHaveBeenCalled()
  })
})
