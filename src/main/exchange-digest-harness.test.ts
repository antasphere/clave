import { afterEach, describe, expect, it, vi } from 'vitest'

// The harness's stand-in for a digest read (PRDCT-4327): under
// --test-no-activate no model runs, but the account is resolved as the
// runner resolves it, through the helper's own config.
const mocks = vi.hoisted(() => ({ accounts: [] as Array<string | undefined> }))
vi.mock('electron', () => {
  throw new Error('the exchange digest imported electron')
})
vi.mock('./test-mode', () => ({ TEST_NO_ACTIVATE: true }))
vi.mock('./sessions/adapters/pty-backend', () => ({
  getLoginShellEnv: () => ({ PATH: '/bin' }),
  getUserShell: () => '/bin/zsh',
  accountTokenForSpawn: async (_kind: string, id?: string) => {
    mocks.accounts.push(id)
    if (id === 'unknown') throw new Error('The selected Claude account is no longer available.')
    return undefined
  }
}))
vi.mock('./ports', () => ({ settingsPorts: () => ({ storage: { pathOf: () => '/dev/null' } }) }))
vi.mock('./exchange-digest-store', () => ({
  DigestStore: class {
    of(): Record<string, unknown> {
      return {}
    }
    get(): undefined {
      return undefined
    }
    put(): void {}
    flush(): void {}
  }
}))

import { requestDigest, requestWorkDigest } from './exchange-digest'
import { setHelperConfigSource } from './helpers/registry'

const REPLY = JSON.stringify({ needs_you: false, message: null, summary: 'Read on {account}.' })
afterEach(() => {
  setHelperConfigSource()
  mocks.accounts.length = 0
  delete process.env.CLAVE_E2E_DIGEST_REPLY
  delete process.env.CLAVE_E2E_WORK_DIGEST_REPLY
})
let n = 0
const ask = (launch: { claudeProfileId?: string }) =>
  requestDigest({
    sessionId: `s${++n}`,
    key: `k${n}`,
    launch,
    messages: [{ from: 'a', text: 'b' }]
  })

describe('the harness resolves a read’s account as the runner does', () => {
  it('the account chosen for the helper wins over the tab’s', async () => {
    process.env.CLAVE_E2E_DIGEST_REPLY = REPLY
    setHelperConfigSource((id) =>
      id === 'exchange-digest' ? { claudeProfileId: 'helper-account' } : undefined
    )
    await expect(ask({ claudeProfileId: 'tab-account' })).resolves.toMatchObject({ ok: true })
    expect(mocks.accounts).toEqual(['helper-account'])
  })

  it('the machine login chosen for the helper (null) wins too', async () => {
    process.env.CLAVE_E2E_DIGEST_REPLY = REPLY
    setHelperConfigSource(() => ({ claudeProfileId: null }))
    await ask({ claudeProfileId: 'unknown' })
    expect(mocks.accounts).toEqual([undefined])
  })

  it('without a choice, the tab’s account; one this process lacks fails as auth', async () => {
    process.env.CLAVE_E2E_DIGEST_REPLY = REPLY
    await expect(ask({ claudeProfileId: 'unknown' })).resolves.toMatchObject({
      ok: false,
      reason: 'auth'
    })
    expect(mocks.accounts).toEqual(['unknown'])
  })

  it('a helper switched off answers disabled, without resolving anything', async () => {
    process.env.CLAVE_E2E_WORK_DIGEST_REPLY = '{"title": "T", "needs_you": false, "note": null}'
    setHelperConfigSource((id) => (id === 'work-digest' ? { enabled: false } : undefined))
    await expect(
      requestWorkDigest({ sessionId: 'w', key: 'w1', launch: {}, notes: ['n'], tools: 0 })
    ).resolves.toMatchObject({ ok: false, reason: 'disabled' })
    expect(mocks.accounts).toEqual([])
  })
})
