import { describe, it, expect } from 'vitest'
import {
  resolveClaudeProfile,
  describeClaudeProfileAuth,
  describeTokenLife,
  claudeProfileUsable,
  claudeProfileSpawnFields,
  accountSpawnFields,
  accountSessionFields,
  sessionAccount,
  useClaudeProfileStore,
  type ClaudeProfile
} from './claude-profile-store'

const bare = { tokenSetAt: null, tokenExpiresAt: null, tokenInvalid: false }
const DAY = 86_400_000
const profiles: ClaudeProfile[] = [
  { id: 'default', label: 'Default', hasToken: false, ...bare },
  {
    id: 'w1',
    label: 'Work',
    hasToken: true,
    tokenSetAt: 0,
    tokenExpiresAt: 365 * DAY,
    tokenInvalid: false
  },
  {
    id: 'p1',
    label: 'Personal',
    hasToken: true,
    tokenSetAt: 0,
    tokenExpiresAt: 365 * DAY,
    tokenInvalid: true
  },
  { id: 'p2', label: 'personal', hasToken: false, ...bare }
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
    expect(describeClaudeProfileAuth(profiles[2])).toBe('Token refused')
    expect(describeClaudeProfileAuth(profiles[3])).toBe('No credential yet')
  })
})

describe('describeTokenLife', () => {
  it('says how long the token has, in months then days, then that it is gone', () => {
    expect(describeTokenLife(profiles[0])).toBeNull()
    expect(describeTokenLife(profiles[1], 0)).toBe('expires in 12 months')
    expect(describeTokenLife(profiles[1], 365 * DAY - 45 * DAY)).toBe('expires in 45 days')
    expect(describeTokenLife(profiles[1], 365 * DAY - DAY / 2)).toBe('expires in 1 day')
    expect(describeTokenLife(profiles[1], 366 * DAY)).toBe('expired')
  })
})

describe('claudeProfileUsable', () => {
  it('is the machine login, or a token that has not been refused', () => {
    expect(claudeProfileUsable(profiles[0])).toBe(true)
    expect(claudeProfileUsable(profiles[1])).toBe(true)
    expect(claudeProfileUsable(profiles[2])).toBe(false)
    expect(claudeProfileUsable(profiles[3])).toBe(false)
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
    // A session started on the retired config-dir shape keeps its directory
    // for its own life.
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
  it('names the account and nothing else: the token is read by id in main', () => {
    expect(claudeProfileSpawnFields(profiles[0])).toEqual({
      claudeProfileId: 'default',
      claudeProfileLabel: 'Default'
    })
    expect(claudeProfileSpawnFields(profiles[1])).toEqual({
      claudeProfileId: 'w1',
      claudeProfileLabel: 'Work'
    })
  })
})
