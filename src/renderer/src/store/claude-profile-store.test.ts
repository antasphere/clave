import { describe, it, expect } from 'vitest'
import {
  resolveClaudeProfile,
  describeClaudeProfileAuth,
  claudeProfileSpawnFields,
  accountSpawnFields,
  accountSessionFields,
  sessionAccount,
  useClaudeProfileStore,
  type ClaudeProfile
} from './claude-profile-store'

const profiles: ClaudeProfile[] = [
  { id: 'default', label: 'Default', configDir: '', hasToken: false },
  { id: 'w1', label: 'Work', configDir: '', hasToken: true },
  { id: 'p1', label: 'Personal', configDir: '/Users/x/.claude-personal', hasToken: false },
  { id: 'p2', label: 'personal', configDir: '', hasToken: false }
]

/**
 * The rule an agent's `account` argument resolves by. It fails silently in the
 * worst way: a name that resolved to the wrong account spawns a session that
 * looks right and burns the wrong subscription.
 */
describe('resolveClaudeProfile', () => {
  it('takes an id first', () => {
    expect(resolveClaudeProfile(profiles, 'w1')?.label).toBe('Work')
    expect(resolveClaudeProfile(profiles, 'default')?.label).toBe('Default')
  })
  it('takes an exact label, then a case-insensitive one', () => {
    expect(resolveClaudeProfile(profiles, 'Work')?.id).toBe('w1')
    expect(resolveClaudeProfile(profiles, 'WORK')?.id).toBe('w1')
    expect(resolveClaudeProfile(profiles, 'Personal')?.id).toBe('p1')
    expect(resolveClaudeProfile(profiles, 'personal')?.id).toBe('p2')
  })
  it('refuses an ambiguous or unknown name', () => {
    expect(resolveClaudeProfile(profiles, 'PERSONAL')).toBeUndefined()
    expect(resolveClaudeProfile(profiles, 'Nobody')).toBeUndefined()
  })
})

describe('describeClaudeProfileAuth', () => {
  it('names each credential story', () => {
    expect(describeClaudeProfileAuth(profiles[0])).toBe('Machine login')
    expect(describeClaudeProfileAuth(profiles[1])).toBe('Token')
    expect(describeClaudeProfileAuth(profiles[2])).toBe('Config directory')
    expect(describeClaudeProfileAuth(profiles[3])).toBe('No credential yet')
  })
  it('names the token first when an account has both a token and a directory', () => {
    // The spawn takes the token ahead of the directory; the badge says the same.
    expect(
      describeClaudeProfileAuth({ id: 'b', label: 'Both', configDir: '/x', hasToken: true })
    ).toBe('Token')
  })
})

describe('sessionAccount', () => {
  it('names a live account, and a removed one by the label the session kept', () => {
    useClaudeProfileStore.setState({ profiles })
    expect(sessionAccount({ claudeProfileId: 'w1' })).toEqual({
      id: 'w1',
      label: 'Work',
      removed: false
    })
    expect(sessionAccount({})).toEqual({ id: 'default', label: 'Default', removed: false })
    expect(sessionAccount({ claudeProfileId: 'gone', claudeProfileLabel: 'Old' })).toEqual({
      id: 'gone',
      label: 'Old',
      removed: true
    })
    expect(sessionAccount({ claudeProfileId: 'gone' }).label).toBe('Removed account')
  })
})

describe('accountSpawnFields', () => {
  it('carries a clone or a resume onto its source’s account, and nothing for the Default', () => {
    expect(
      accountSpawnFields({ claudeProfileId: 'w1', claudeProfileLabel: 'Work', claudeConfigDir: '' })
    ).toEqual({ configDir: undefined, claudeProfileId: 'w1', claudeProfileLabel: 'Work' })
    expect(accountSpawnFields({ claudeProfileId: 'p1', claudeConfigDir: '/d' }).configDir).toBe(
      '/d'
    )
    expect(accountSpawnFields({})).toEqual({})
    expect(accountSessionFields({ claudeProfileId: 'w1', claudeProfileLabel: 'Work' })).toEqual({
      claudeProfileId: 'w1',
      claudeProfileLabel: 'Work',
      claudeConfigDir: undefined
    })
  })
})

describe('claudeProfileSpawnFields', () => {
  it('never sets a config dir on a passthrough or a token account', () => {
    expect(claudeProfileSpawnFields(profiles[0])).toEqual({
      configDir: undefined,
      claudeProfileId: 'default',
      claudeProfileLabel: 'Default'
    })
    expect(claudeProfileSpawnFields(profiles[1]).configDir).toBeUndefined()
    expect(claudeProfileSpawnFields(profiles[2]).configDir).toBe('/Users/x/.claude-personal')
  })
})
