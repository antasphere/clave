import { describe, expect, it } from 'vitest'
import { continueList } from '../../../../plugins/chat-view/src/lists'

/* The composer carries a list on across a new line, so the reader types the
   items and never the markers. */
const atEnd = (text: string): ReturnType<typeof continueList> => continueList(text, text.length)

describe('continueList', () => {
  it('leaves a plain line to the textarea', () => {
    expect(atEnd('just a sentence')).toBeNull()
    expect(atEnd('')).toBeNull()
    expect(atEnd('-not a list')).toBeNull()
    expect(atEnd('1.not a list')).toBeNull()
  })

  it('carries a bullet on with the same marker and indent', () => {
    expect(atEnd('- first')).toEqual({ text: '- first\n- ', caret: 10 })
    expect(atEnd('* first')).toEqual({ text: '* first\n* ', caret: 10 })
    expect(atEnd('  - nested')).toEqual({ text: '  - nested\n  - ', caret: 15 })
  })

  it('counts a numbered list up, keeping its delimiter', () => {
    expect(atEnd('1. first')).toEqual({ text: '1. first\n2. ', caret: 12 })
    expect(atEnd('9) ninth')).toEqual({ text: '9) ninth\n10) ', caret: 13 })
    expect(atEnd('1. a\n2. b')).toEqual({ text: '1. a\n2. b\n3. ', caret: 13 })
  })

  it('ends the list on an empty item, taking the marker with it', () => {
    expect(atEnd('- a\n- ')).toEqual({ text: '- a\n', caret: 4 })
    expect(atEnd('1. a\n2. ')).toEqual({ text: '1. a\n', caret: 5 })
    expect(atEnd('  - ')).toEqual({ text: '  ', caret: 2 })
  })

  it('splits an item at the caret, the tail moving to the new item', () => {
    expect(continueList('- one two', 5)).toEqual({ text: '- one\n- two', caret: 8 })
    // A selection is replaced by the new line.
    expect(continueList('- one XXX two', 6, 9)).toEqual({ text: '- one \n- two', caret: 9 })
  })
})
