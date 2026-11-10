/**
 * A work card whose title could not be read (PRDCT-4327): the card draws the
 * failure line with its reason in the work card's words, and its Ask again
 * asks THAT card again (its session and the key of its own notes). Rendered
 * on the server, the line's props are captured as the card draws it, so a
 * card that drops the line, or wires Ask again to nothing, is red here and
 * not only in the end-to-end spec.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { workDigestKey } from '../../../shared/work-digest'

// The plugin's components compile with the classic JSX runtime here, and the
// real DeliveryStack reaches the session store, which reads localStorage.
vi.hoisted(() => {
  const memory = new Map<string, string>()
  Object.assign(globalThis, {
    localStorage: {
      getItem: (k: string) => memory.get(k) ?? null,
      setItem: (k: string, v: string) => void memory.set(k, v),
      removeItem: (k: string) => void memory.delete(k),
      clear: () => memory.clear()
    }
  })
})
Object.assign(globalThis, { React })

const state = vi.hoisted(() => ({
  digest: { state: 'failed', reason: 'limit', at: 1 } as Record<string, unknown>,
  retried: [] as Array<[string, string]>,
  lines: [] as Array<{ reason: unknown; card: unknown; onRetry: () => void }>
}))
vi.mock('../../../../plugins/chat-view/src/digest', async (original) => ({
  ...(await original<typeof import('../../../../plugins/chat-view/src/digest')>()),
  useWorkDigestState: () => state.digest,
  retryWorkDigest: (sessionId: string, key: string) => state.retried.push([sessionId, key])
}))
vi.mock('../../../../plugins/chat-view/src/DeliveryStack', () => ({
  DigestSlow: () => null,
  DigestUnread: (props: { reason: unknown; card: unknown; onRetry: () => void }) => {
    state.lines.push(props)
    return null
  }
}))

import { WorkStretch } from '../../../../plugins/chat-view/src/WorkStretch'
import { StretchContext } from '../../../../plugins/chat-view/src/stretch-context'
import { DigestUnread as RealUnread } from '../../../../plugins/chat-view/src/DeliveryStack'

let at = 0
const step = (text: string): { note: object; work: object[] } => ({
  note: { kind: 'assistant', text, final: true, at: ++at },
  work: [{ kind: 'tool', id: `t${at}`, name: 'Bash', input: {}, complete: true, at: ++at }]
})
const NOTES = ['Reading the code.', 'The fix is in.', 'The tests pass.']
const stretch = { kind: 'work-stretch', steps: NOTES.map(step) }

const draw = (): string =>
  renderToStaticMarkup(
    createElement(
      StretchContext.Provider,
      { value: { sessionId: 'tab-1', recent: new Set(['card-1']), launch: {} } },
      createElement(WorkStretch, {
        stretch: stretch as never,
        id: 'card-1',
        render: () => null
      })
    )
  )

beforeEach(() => {
  state.digest = { state: 'failed', reason: 'limit', at: 1 }
  state.retried.length = 0
  state.lines.length = 0
})

describe('a work card that could not be titled', () => {
  it('draws the failure line with its reason, in the work card’s words', () => {
    const html = draw()
    expect(html).toContain('data-digest="failed"')
    expect(state.lines).toHaveLength(1)
    expect(state.lines[0]).toMatchObject({ reason: 'limit', card: 'work' })
  })

  it('its Ask again asks that card again: its session, the key of its notes', () => {
    draw()
    state.lines[0].onRetry()
    expect(state.retried).toEqual([['tab-1', workDigestKey(NOTES)]])
  })

  it('draws no line while the title is read, nor once it is', () => {
    state.digest = { state: 'reading' }
    draw()
    state.digest = { state: 'done', result: { ok: true, title: 'T', needsYou: false, note: null } }
    draw()
    expect(state.lines).toEqual([])
  })
})

describe('the Ask again control', () => {
  it('is a native button, so Enter and Space ask from the keyboard', async () => {
    const { DigestUnread } = await vi.importActual<
      typeof import('../../../../plugins/chat-view/src/DeliveryStack')
    >('../../../../plugins/chat-view/src/DeliveryStack')
    const html = renderToStaticMarkup(
      createElement(DigestUnread, { reason: 'limit', card: 'work', onRetry: () => {} })
    )
    expect(html).toContain('No title: this account is at its limit.')
    expect(html).toMatch(/<button type="button" class="digest-unread-retry">Ask again<\/button>/)
    expect(RealUnread).not.toBe(DigestUnread)
  })
})
