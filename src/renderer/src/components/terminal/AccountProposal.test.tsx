/**
 * The proposal badge offers the rungs in order as buttons (PRDCT-4302): the
 * cap that is out in the readouts' words, then `Continue on Opus 5.5`,
 * `Switch to Play`, `Continue on Codex`, the cross. A rung drawn out of
 * order, or under the wrong verb, sends the reader the wrong way; a missing
 * data attribute breaks the specs that click it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Session } from '../../store/session-types'

const state = vi.hoisted(() => ({
  session: null as Partial<Session> | null,
  mode: 'propose' as 'propose' | 'automatic',
  stopping: null as unknown,
  accepted: [] as unknown[],
  dismissed: [] as string[]
}))
vi.mock('../../store/session-store', () => ({
  useSessionStore: Object.assign(
    (select: (s: { sessions: Partial<Session>[] }) => unknown) =>
      select({ sessions: state.session ? [state.session] : [] }),
    { getState: () => ({ sessions: state.session ? [state.session] : [] }) }
  )
}))
vi.mock('../../store/account-policy-store', () => ({
  effectiveSwitchMode: () => state.mode
}))
vi.mock('../../lib/account-policy', () => ({
  acceptRung: (id: string, rung: unknown) => {
    state.accepted.push([id, rung])
    return Promise.resolve()
  },
  dismissAccountProposal: (id: string) => state.dismissed.push(id)
}))
vi.mock('../../lib/switch-account', () => ({ sessionAccountUsage: () => undefined }))
vi.mock('../../store/usage-store', async (original) => {
  const real = await original<typeof import('../../store/usage-store')>()
  const store = Object.assign((select: (s: unknown) => unknown) => select({ byAccount: {} }), {
    getState: () => ({ byAccount: {} })
  })
  return {
    ...real,
    capStatus: () => (state.stopping ? { stopping: state.stopping } : null),
    useClaudeAccountsUsage: store,
    useCodexAccountsUsage: store
  }
})
import { AccountProposal } from './AccountProposal'

// The render reads the real clock: half an hour of margin keeps "2d 5h" true
// however long the file waits between collection and run on a loaded Mac.
const now = Date.now() + 30 * 60_000
const fableOut = {
  key: 'fable',
  label: 'Weekly · Fable',
  kind: 'weekly_scoped',
  scope: 'Fable',
  usedPercentage: 100,
  severity: 'critical',
  resetsAt: now + 2 * 86_400_000 + 5 * 3_600_000
}
const rungs = [
  { kind: 'model', model: 'claude-opus-5-5', label: 'Opus 5.5' },
  { kind: 'account', accountId: 'play', label: 'Play' },
  { kind: 'provider', adapterId: 'codex-chat', label: 'Codex' }
] as const

const render = (): string => renderToStaticMarkup(<AccountProposal sessionId="s1" />)
const texts = (html: string): string[] =>
  [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((m) =>
    m[1].replace(/<[^>]+>/g, '').trim()
  )

beforeEach(() => {
  state.mode = 'propose'
  state.stopping = null
  state.accepted = []
  state.dismissed = []
  state.session = {
    id: 's1',
    accountProposal: { reason: 'limit', rungs: [...rungs] },
    limitReported: { scope: { family: 'Fable' }, resetsAt: fableOut.resetsAt }
  }
})

describe('AccountProposal', () => {
  it('draws nothing without a proposal, or with an empty ladder', () => {
    state.session = { id: 's1', accountProposal: null }
    expect(render()).toBe('')
    state.session = { id: 's1', accountProposal: { reason: 'limit', rungs: [] } }
    expect(render()).toBe('')
  })

  it('names the cap from the report before the read lands, and offers the rungs in order', () => {
    const html = render()
    expect(html).toContain('Fable out · back in 2d 5h')
    expect(texts(html)).toEqual(['Continue on Opus 5.5', 'Switch to Play', 'Continue on Codex', ''])
    expect(html).toContain('data-account-proposal="play"')
    expect(html).toContain('data-model-proposal="claude-opus-5-5"')
    expect(html).toContain('data-model-proposal-accept="claude-opus-5-5"')
    expect(html).toContain('data-account-proposal-accept="play"')
    expect(html).toContain('data-provider-proposal-accept="codex-chat"')
    expect(html).toContain('data-account-proposal-dismiss')
    expect(html).toContain('data-limit-proposal="limit"')
  })

  it("names the cap from the poll's read once it shows one out, in the readouts' words", () => {
    state.stopping = fableOut
    state.session = { ...state.session, limitReported: { scope: 'shared' } }
    expect(render()).toContain('Fable out · back in 2d 5h')
  })

  it('in automatic mode the first rung says what is about to happen', () => {
    state.mode = 'automatic'
    expect(texts(render())).toEqual([
      'Continuing on Opus 5.5',
      'Switch to Play',
      'Continue on Codex',
      ''
    ])
    state.session = {
      ...state.session,
      accountProposal: { reason: 'reported', rungs: [rungs[1]] }
    }
    const html = render()
    expect(texts(html)).toEqual(['Moving to Play', ''])
    expect(html).toContain('moves to Play as soon as the agent is idle')
  })

  it('an account rung alone carries no model attribute, and the word is Switch', () => {
    state.session = { ...state.session, accountProposal: { reason: 'limit', rungs: [rungs[1]] } }
    const html = render()
    expect(html).not.toContain('data-model-proposal=')
    expect(texts(html)).toEqual(['Switch to Play', ''])
  })
})
