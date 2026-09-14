import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/clave-usage-manager-test' },
  safeStorage: { isEncryptionAvailable: () => false }
}))

import {
  credentialFor,
  normalize,
  parseUnifiedRateLimitEntries,
  parseUnifiedRateLimitHeaders
} from './usage-manager'

/**
 * The probe's headers → the same windows the usage endpoint yields. This is
 * the read a token account lives on, and it fails silently: a header spelled
 * wrong renders no window at all, and a fraction taken as a percentage says
 * "0% used" on an exhausted account.
 */
describe('parseUnifiedRateLimitHeaders', () => {
  const headers: Record<string, string> = {
    'anthropic-ratelimit-unified-5h-status': 'allowed',
    'anthropic-ratelimit-unified-5h-utilization': '0.03',
    'anthropic-ratelimit-unified-5h-reset': '1789428600',
    'anthropic-ratelimit-unified-7d-status': 'allowed_warning',
    'anthropic-ratelimit-unified-7d-utilization': '0.21',
    'anthropic-ratelimit-unified-7d-reset': '1789718400',
    'anthropic-ratelimit-unified-status': 'allowed',
    'anthropic-ratelimit-unified-representative-claim': 'five_hour'
  }
  const get = (name: string): string | null => headers[name] ?? null

  it('reads the session and weekly windows, in that order', () => {
    const windows = parseUnifiedRateLimitHeaders(get)
    expect(windows.map((w) => w.kind)).toEqual(['session', 'weekly_all'])
    expect(windows[0].label).toBe('Current session (5h)')
    expect(windows[1].label).toBe('Weekly · all models')
  })

  it('turns a fraction into a percentage and epoch seconds into milliseconds', () => {
    const [session, weekly] = parseUnifiedRateLimitHeaders(get)
    expect(session.usedPercentage).toBe(3)
    expect(weekly.usedPercentage).toBe(21)
    expect(session.resetsAt).toBe(1789428600 * 1000)
    expect(weekly.resetsAt).toBe(1789718400 * 1000)
  })

  it("carries the service's verdict as the severity", () => {
    const [session, weekly] = parseUnifiedRateLimitHeaders(get)
    expect(session.severity).toBe('normal')
    expect(weekly.severity).toBe('warning')
    expect(
      parseUnifiedRateLimitEntries([
        ['anthropic-ratelimit-unified-5h-utilization', '1'],
        ['anthropic-ratelimit-unified-5h-status', 'rejected']
      ])[0]
    ).toMatchObject({ usedPercentage: 100, severity: 'critical' })
  })

  it('is empty when the response carried no such headers', () => {
    expect(parseUnifiedRateLimitHeaders(() => null)).toEqual([])
    expect(parseUnifiedRateLimitEntries([['content-type', 'application/json']])).toEqual([])
  })

  it('takes a value above one as a percentage already', () => {
    expect(
      parseUnifiedRateLimitEntries([['anthropic-ratelimit-unified-7d-utilization', '42']])[0]
        .usedPercentage
    ).toBe(42)
  })

  it('renders a window it has never seen, scoped by its name', () => {
    const windows = parseUnifiedRateLimitEntries([
      ['anthropic-ratelimit-unified-7d-opus-utilization', '0.5'],
      ['anthropic-ratelimit-unified-7d-utilization', '0.1']
    ])
    expect(windows.map((w) => w.kind)).toEqual(['weekly_all', 'weekly_scoped'])
    expect(windows[1]).toMatchObject({ scope: 'Opus', label: 'Weekly · Opus' })
  })

  it('ignores a utilization that is not a number, and a reset that is', () => {
    const windows = parseUnifiedRateLimitEntries([
      ['anthropic-ratelimit-unified-5h-utilization', 'n/a'],
      ['anthropic-ratelimit-unified-7d-utilization', '0.1'],
      ['anthropic-ratelimit-unified-7d-reset', 'soon']
    ])
    expect(windows).toHaveLength(1)
    expect(windows[0].resetsAt).toBeNull()
  })
})

describe('credentialFor', () => {
  const account = { id: 'a', label: 'Work', configDir: '', hasToken: true }
  it('takes the pasted token ahead of everything', () => {
    expect(credentialFor({ ...account, configDir: '/x' }, 'sk-ant-x')).toEqual({
      kind: 'token',
      token: 'sk-ant-x'
    })
  })
  it('falls back to the config dir; only the Default reads the keychain', () => {
    expect(credentialFor({ ...account, configDir: '/x' }, undefined)).toEqual({
      kind: 'config-dir',
      dir: '/x'
    })
    expect(credentialFor(undefined, undefined)).toEqual({ kind: 'keychain' })
    expect(
      credentialFor({ id: 'default', label: 'Default', configDir: '', hasToken: false }, undefined)
    ).toEqual({ kind: 'keychain' })
  })
  it('never reads the machine login for an account that has no credential yet', () => {
    // The settings page asks for a new account's usage the instant it exists;
    // before the paste that read must fail as "no token", not show the
    // machine's quota under the new name.
    expect(credentialFor({ ...account, hasToken: false }, undefined)).toEqual({ kind: 'none' })
  })
})

describe('normalize (the endpoint)', () => {
  it('still reads the self-describing limits array', () => {
    const windows = normalize({
      limits: [
        { kind: 'session', percent: 12, severity: 'normal', resets_at: '2026-09-14T22:00:00Z' },
        { kind: 'weekly_scoped', percent: 3, scope: { model: { display_name: 'Fable' } } }
      ]
    })
    expect(windows.map((w) => w.label)).toEqual(['Current session (5h)', 'Weekly · Fable'])
  })
})
