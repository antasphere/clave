import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Session } from '../../../src/renderer/src/store/session-types'

/** The ended notice's sentence reads the CLI's report when the poll shows no
 *  cap out (round 1, C6): the family and the return the CLI named, else the
 *  account out as its agent reported. */
const state = vi.hoisted(() => ({
  stopping: null as unknown,
  store: Object.assign((select: (s: unknown) => unknown) => select({ byAccount: {} }), {
    getState: () => ({ byAccount: {} })
  })
}))
vi.mock('../../../src/renderer/src/store/usage-store', async (original) => {
  const real = await original<typeof import('../../../src/renderer/src/store/usage-store')>()
  return {
    ...real,
    capStatus: () => (state.stopping ? { stopping: state.stopping } : null),
    useClaudeAccountsUsage: state.store,
    useCodexAccountsUsage: state.store
  }
})
vi.mock('../../../src/renderer/src/lib/switch-account', () => ({
  sessionAccountUsage: () => undefined
}))
import { useLimitSentence } from './limit-words'

// Plain calls, no JSX: the plugin's test files are `.ts`.
function Probe({ host }: { host: Partial<Session> }): React.JSX.Element {
  return createElement('span', null, useLimitSentence(host as Session))
}
// The hook reads the real clock: half an hour of margin keeps "2d 5h" true
// however long the file waits between collection and run on a loaded Mac.
const now = Date.now() + 30 * 60_000
const text = (host: Partial<Session>): string =>
  renderToStaticMarkup(createElement(Probe, { host })).replace(/<[^>]+>/g, '')

beforeEach(() => {
  state.stopping = null
})

describe('useLimitSentence', () => {
  it("names the family and the return from the CLI's report before the read shows a cap out", () => {
    expect(
      text({
        claudeProfileLabel: 'Work',
        claudeProfileId: 'work',
        limitReported: {
          scope: { family: 'Fable' },
          resetsAt: now + 2 * 86_400_000 + 5 * 3_600_000
        }
      })
    ).toBe('Work is out on Fable, back in 2d 5h.')
  })
  it('says the account is out as its agent reported for a report with no family, the credits included', () => {
    expect(text({ claudeProfileLabel: 'Work', limitReported: { scope: 'credits' } })).toBe(
      'Work is out, as its agent reported.'
    )
    expect(text({ claudeProfileLabel: 'Work', limitReported: { scope: 'shared' } })).toBe(
      'Work is out, as its agent reported.'
    )
    expect(text({ claudeProfileLabel: 'Work' })).toBe('Work is out, as its agent reported.')
  })
  it("names the cap the read shows out over the report's word", () => {
    state.stopping = {
      key: 'all',
      label: 'Weekly · all models',
      kind: 'weekly_all',
      scope: null,
      usedPercentage: 100,
      severity: 'critical',
      resetsAt: now + 2 * 86_400_000 + 5 * 3_600_000
    }
    expect(
      text({ claudeProfileLabel: 'Work', limitReported: { scope: { family: 'Fable' } } })
    ).toBe('Work is out on Overall, back in 2d 5h.')
  })
})
