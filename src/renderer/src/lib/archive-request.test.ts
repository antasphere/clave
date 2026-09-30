import { describe, expect, it } from 'vitest'
import { ARCHIVE_AND_KILL_PROMPT, ARCHIVE_COMMAND, archiveRefusal } from './archive-request'

describe('archive and kill session', () => {
  it('asks a live Claude tab', () => {
    expect(archiveRefusal({ alive: true }, 'claude')).toBeNull()
  })

  it('refuses a tab that is gone or has ended', () => {
    expect(archiveRefusal(undefined, undefined)).toBe('no-session')
    expect(archiveRefusal({ alive: false }, 'claude')).toBe('ended')
  })

  it('refuses every tab that is not a Claude conversation', () => {
    for (const mode of ['terminal', 'codex', 'antigravity', 'pi', 'claude-agents'] as const) {
      expect(archiveRefusal({ alive: true }, mode)).toBe('not-claude')
    }
  })

  it('opens with the archive command and leaves the close to the agent, on its own tab', () => {
    expect(ARCHIVE_AND_KILL_PROMPT.startsWith(`${ARCHIVE_COMMAND} `)).toBe(true)
    expect(ARCHIVE_AND_KILL_PROMPT).toContain('clave_close_session with sessionId "mine"')
    // A single line: a terminal tab receives it as one pasted turn.
    expect(ARCHIVE_AND_KILL_PROMPT).not.toMatch(/[\r\n]/)
  })
})
