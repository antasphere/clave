import { describe, expect, it } from 'vitest'
import { accountOverrides } from './restart-overrides'

describe('the account a restart runs on', () => {
  it('keeps the stored account when the restart names none', () => {
    const previous = { claudeProfileId: 'acct-token-42', claudeProfileLabel: 'Work' }
    const restart = { claudeProfileId: undefined, claudeProfileLabel: undefined }
    expect({ ...previous, ...accountOverrides(restart) }).toEqual(previous)
  })

  it('moves to the account a switch names', () => {
    const previous = { codexAccountId: 'a', codexAccountLabel: 'A' }
    expect({
      ...previous,
      ...accountOverrides({ codexAccountId: 'b', codexAccountLabel: 'B' })
    }).toEqual({
      codexAccountId: 'b',
      codexAccountLabel: 'B'
    })
  })
})
