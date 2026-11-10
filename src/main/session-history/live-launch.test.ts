import { describe, expect, it } from 'vitest'
import type { SessionRecord } from '@clave/contract/sessions'
import { launchOfRecord, overlayLiveLaunch } from './live-launch'

/**
 * Round 5 F1 of PRDCT-4236: a chat launched in bypass and switched to plan
 * stamps no ledger row, so the History would reopen it in bypass while its
 * own Resume brings it back in plan. The live record wins for every
 * conversation a tab still holds.
 */
const record = (over: Partial<SessionRecord>): SessionRecord =>
  ({
    id: 'tab',
    cwd: '/w',
    folderName: 'w',
    claudeMode: true,
    antigravityMode: false,
    codexMode: false,
    piMode: false,
    claudeAgentsMode: false,
    dangerousMode: true,
    claudeSessionId: 'c1',
    claudeProfileId: 'acct-1',
    claudeProfileLabel: 'Anthropic',
    ...over
  }) as SessionRecord

describe('launchOfRecord', () => {
  it('reads the mode the chat moved to, bypass off, the account named', () => {
    expect(launchOfRecord(record({ permissionMode: 'plan', effort: 'high' }))).toEqual({
      dangerous: false,
      permissionMode: 'plan',
      effort: 'high',
      accountId: 'acct-1',
      accountLabel: 'Anthropic'
    })
  })

  it('keeps bypass when the chat stayed in it, or never reported a mode', () => {
    expect(launchOfRecord(record({ permissionMode: 'bypassPermissions' }))).toMatchObject({
      dangerous: true,
      permissionMode: 'bypassPermissions'
    })
    expect(launchOfRecord(record({}))).toEqual({
      dangerous: true,
      accountId: 'acct-1',
      accountLabel: 'Anthropic'
    })
  })

  it('names the Codex account for a Codex tab', () => {
    expect(
      launchOfRecord(
        record({
          claudeMode: false,
          codexMode: true,
          claudeProfileId: undefined,
          claudeProfileLabel: undefined,
          codexAccountId: 'cx-2',
          codexAccountLabel: 'Work'
        })
      )
    ).toMatchObject({ accountId: 'cx-2', accountLabel: 'Work' })
  })
})

describe('overlayLiveLaunch', () => {
  const entries = [
    { claudeSessionId: 'c1', launch: { dangerous: true, permissionMode: 'bypassPermissions' } },
    { claudeSessionId: 'c2', launch: { dangerous: true } },
    { claudeSessionId: 'c3' }
  ]

  it('lays the live record over the ledger for a held conversation, and leaves the others', () => {
    const out = overlayLiveLaunch(entries, [record({ permissionMode: 'plan', running: true })])
    expect(out[0].launch).toEqual({
      dangerous: false,
      permissionMode: 'plan',
      accountId: 'acct-1',
      accountLabel: 'Anthropic'
    })
    expect(out[1]).toEqual(entries[1])
    expect(out[2]).toEqual(entries[2])
  })

  it('prefers the running holder when two records carry one conversation', () => {
    const out = overlayLiveLaunch(entries, [
      record({ id: 'old', permissionMode: 'acceptEdits', running: false }),
      record({ id: 'new', permissionMode: 'plan', running: true })
    ])
    expect(out[0].launch?.permissionMode).toBe('plan')
  })

  it('a stopped holder counts too, and a conversation nobody holds keeps the ledger', () => {
    const out = overlayLiveLaunch(entries, [
      record({ claudeSessionId: 'c3', permissionMode: 'acceptEdits', running: false })
    ])
    expect(out[2].launch).toMatchObject({ dangerous: false, permissionMode: 'acceptEdits' })
    expect(out[0]).toEqual(entries[0])
  })
})
