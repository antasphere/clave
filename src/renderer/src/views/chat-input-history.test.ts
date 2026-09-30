import { describe, expect, it } from 'vitest'
import { recallMessage } from '../../../../plugins/chat-view/src/history'
import type { Entry } from '../../../../plugins/chat-view/src/reducer'

const entries: Entry[] = [
  { kind: 'user', text: 'first\nsecond line', at: 1, final: true },
  { kind: 'assistant', text: 'reply', at: 2, final: true },
  { kind: 'user', text: 'latest', at: 3, final: true },
  { kind: 'user', text: '', at: 4, final: true }
]
const up = { key: 'ArrowUp' }
const down = { key: 'ArrowDown' }

describe('chat input history', () => {
  it('recalls user text in both directions, stops at oldest, then returns to empty', () => {
    const latest = recallMessage(entries, null, '', up)!
    expect(latest.text).toBe('latest')
    const oldest = recallMessage(entries, latest.browsing, latest.text, up)!
    expect(oldest.text).toBe('first\nsecond line')
    expect(recallMessage(entries, oldest.browsing, oldest.text, up)).toEqual(oldest)
    expect(recallMessage(entries, oldest.browsing, oldest.text, down)).toEqual(latest)
    expect(recallMessage(entries, latest.browsing, latest.text, down)).toEqual({
      text: '',
      browsing: null
    })
  })

  it('leaves drafts, empty history and Down without browsing alone', () => {
    expect(recallMessage(entries, null, 'draft', up)).toBeNull()
    expect(recallMessage(entries, null, ' ', up)).toBeNull()
    expect(recallMessage([], null, '', up)).toBeNull()
    expect(recallMessage(entries, null, '', down)).toBeNull()
  })

  it.each(['shiftKey', 'altKey', 'ctrlKey', 'metaKey', 'isComposing'])(
    'ignores arrows with %s',
    (flag) => {
      expect(recallMessage(entries, null, '', { ...up, [flag]: true })).toBeNull()
    }
  )

  it('ignores unrelated keys while browsing', () => {
    const latest = recallMessage(entries, null, '', up)!
    expect(recallMessage(entries, latest.browsing, latest.text, { key: 'Enter' })).toBeNull()
  })

  it('keeps the browsing snapshot stable when new messages arrive', () => {
    const latest = recallMessage(entries, null, '', up)!
    const updated: Entry[] = [...entries, { kind: 'user', text: 'new', at: 5, final: true }]
    expect(recallMessage(updated, latest.browsing, latest.text, up)?.text).toBe(
      'first\nsecond line'
    )
    expect(recallMessage(updated, null, '', up)?.text).toBe('new')
  })
})
