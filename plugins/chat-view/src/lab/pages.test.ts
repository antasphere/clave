import { describe, expect, it } from 'vitest'
import { emptyConversation, reduceConversation, type Entry } from '../reducer'
import type { SessionEvent } from '../../../../src/shared/session-model'
import { pageTitleKey } from '../../../../src/shared/page-title'
import { ANONYMOUS_PROVENANCE_HEADER } from '../../../../src/shared/exchange-provenance'
import {
  briefFor,
  buildPages,
  currentPage,
  headline,
  titleKeyOf,
  turnPage,
  type Page
} from './pages'

const reduce = (events: SessionEvent[]): Entry[] =>
  events.reduce((c, event) => reduceConversation(c, { event, at: 1 }), emptyConversation).entries
const ordinalOf =
  (entries: Entry[]) =>
  (entry: Entry): number =>
    entries.indexOf(entry)
const pagesOf = (
  events: SessionEvent[],
  state: 'idle' | 'working' | 'blocked' = 'idle'
): Page[] => {
  const entries = reduce(events)
  return buildPages(entries, ordinalOf(entries), state)
}

describe('headline', () => {
  it('keeps a short message whole', () => {
    expect(headline('Fix the login bug')).toBe('Fix the login bug')
  })
  it('stops at the first sentence when it ends early enough', () => {
    expect(headline('Why does the build fail? It worked yesterday, then I upgraded node.')).toBe(
      'Why does the build fail?'
    )
  })
  it('cuts a long line at a word, with an ellipsis', () => {
    const title = headline(
      'please go through every file in the renderer and rename each component that still uses the old prefix to the new one'
    )
    expect(title.endsWith('…')).toBe(true)
    expect(title.length).toBeLessThanOrEqual(85)
    expect(title).not.toMatch(/\s…$/)
  })
  it('reads past markdown, code and attachment markers', () => {
    expect(headline('[Image #1]\n\n## **Look** at `this` [screen](http://x)')).toBe(
      'Look at this screen'
    )
    expect(headline('```\ncode only\n```')).toBe('')
  })
})

describe('buildPages', () => {
  it('makes one page per question, the answer written on it', () => {
    const pages = pagesOf([
      { type: 'user_message', text: 'First question' },
      { type: 'assistant_text', delta: 'First answer', final: true },
      { type: 'user_message', text: 'Second question' },
      { type: 'assistant_text', delta: 'Second answer', final: true }
    ])
    expect(pages.map((p) => [p.number, p.title, p.answer])).toEqual([
      [1, 'First question', 'First answer'],
      [2, 'Second question', 'Second answer']
    ])
    expect(pages.every((p) => p.status === 'done')).toBe(true)
  })

  it('puts the work in the margin beside the paragraph it led to', () => {
    const [page] = pagesOf([
      { type: 'user_message', text: 'Read it' },
      { type: 'assistant_text', delta: 'Looking.', final: true },
      { type: 'tool_call', id: 't1', name: 'Read', input: { file_path: 'a.ts' } },
      { type: 'tool_result', id: 't1', output: 'x' },
      { type: 'tool_call', id: 't2', name: 'Bash', input: { command: 'npm test' } },
      { type: 'tool_result', id: 't2', output: 'ok', error: true },
      { type: 'assistant_text', delta: 'Done.', final: true }
    ])
    expect(page.rows.map((r) => [r.notes.length, r.prose?.text ?? null])).toEqual([
      [0, 'Looking.'],
      [2, 'Done.']
    ])
    expect(page.tools).toBe(2)
    expect(page.failed).toBe(1)
    expect(page.answer).toBe('Looking.\n\nDone.')
  })

  it('joins a message sent before any answer to the question it follows', () => {
    const pages = pagesOf([
      { type: 'user_message', text: 'Do the thing' },
      { type: 'user_message', text: 'and the other one too' },
      { type: 'assistant_text', delta: 'On it', final: true }
    ])
    expect(pages).toHaveLength(1)
    expect(pages[0].question).toHaveLength(2)
    expect(pages[0].brief).toContain('and the other one too')
  })

  it('reads the last page as being written while the agent works', () => {
    const writing = pagesOf(
      [
        { type: 'user_message', text: 'Q' },
        { type: 'assistant_text', delta: 'partial', final: false }
      ],
      'working'
    )
    expect(writing[0].status).toBe('writing')
    const working = pagesOf(
      [
        { type: 'user_message', text: 'Q' },
        { type: 'tool_call', id: 't', name: 'Read', input: {} }
      ],
      'working'
    )
    expect(working[0].status).toBe('working')
  })

  it('says a page waits on the reader only while a request is open', () => {
    const [page] = pagesOf(
      [
        { type: 'user_message', text: 'Q' },
        {
          type: 'permission_request',
          id: 'p1',
          toolName: 'Bash',
          description: 'Run',
          input: {},
          options: [{ id: 'allow', label: 'Allow' }]
        } as SessionEvent
      ],
      'blocked'
    )
    expect(page.status).toBe('waiting')
    expect(page.rows[0].notes[0].kind).toBe('permission')
  })

  it('marks a stopped page interrupted, whatever the state', () => {
    const [page] = pagesOf(
      [
        { type: 'user_message', text: 'Q' },
        { type: 'assistant_text', delta: 'half', final: false },
        { type: 'turn_interrupted' } as SessionEvent
      ],
      'idle'
    )
    expect(page.status).toBe('interrupted')
  })

  it('keeps what came before the first message on a page of its own', () => {
    const pages = pagesOf([
      { type: 'assistant_text', delta: 'resumed tail', final: true },
      { type: 'user_message', text: 'Next' }
    ])
    expect(pages.map((p) => p.title)).toEqual(['Before the first question', 'Next'])
  })

  it('keys a page by its first entry, so the past put in front moves no key', () => {
    const events: SessionEvent[] = [
      { type: 'user_message', text: 'A' },
      { type: 'assistant_text', delta: 'a', final: true }
    ]
    const entries = reduce(events)
    const before = buildPages(entries, (e) => 10 + entries.indexOf(e), 'idle')
    const after = buildPages(
      [
        ...reduce([
          { type: 'user_message', text: 'older' },
          { type: 'assistant_text', delta: 'old answer', final: true }
        ]),
        ...entries
      ],
      (e) => (entries.includes(e) ? 10 + entries.indexOf(e) : 9),
      'idle'
    )
    expect(after.at(-1)!.key).toBe(before[0].key)
    expect(after.at(-1)!.number).toBe(2)
  })

  it('keeps the reader on a page with no question when its question arrives in front', () => {
    // History is cut mid-answer: the oldest loaded page has no question yet.
    const tail = reduce([
      { type: 'assistant_text', delta: 'the end of an old answer', final: true },
      { type: 'user_message', text: 'New question' },
      { type: 'assistant_text', delta: 'new answer', final: true }
    ])
    const at = (list: typeof tail, base: number) => (e: (typeof tail)[number]) =>
      list.includes(e) ? base + list.indexOf(e) : undefined
    const before = buildPages(tail, at(tail, 2), 'idle')
    const held = before[0].key
    expect(currentPage(before, held)?.title).toBe('Before the first question')

    const head = reduce([{ type: 'user_message', text: 'Old question' }])
    const all = [...head, ...tail]
    const after = buildPages(all, (e) => (head.includes(e) ? 1 : at(tail, 2)(e)), 'idle')
    expect(after[0].key).not.toBe(held)
    expect(currentPage(after, held)?.title).toBe('Old question')
    expect(turnPage(after, held, 1)?.title).toBe('New question')
  })

  it('names a message from another tab by its sender', () => {
    const [page] = pagesOf([
      {
        type: 'user_message',
        text: '[Message from Clave tab "Lane A" — reply with clave_send_to_session sessionId="abc"]\nThe build is green'
      }
    ])
    expect(page.title).toBe('The build is green')
    expect(page.from).toEqual({ name: 'Lane A', id: 'abc' })
  })
})

describe('turning pages', () => {
  const pages = pagesOf([
    { type: 'user_message', text: 'one' },
    { type: 'user_message', text: 'x' },
    { type: 'assistant_text', delta: 'a', final: true },
    { type: 'user_message', text: 'two' },
    { type: 'assistant_text', delta: 'b', final: true },
    { type: 'user_message', text: 'three' }
  ])
  it('follows the last page unless one is held', () => {
    expect(currentPage(pages, null)?.title).toBe('three')
    expect(currentPage(pages, pages[0].key)?.title).toBe('one')
    expect(currentPage(pages, 'gone')?.title).toBe('three')
    expect(currentPage([], null)).toBeNull()
  })
  it('turns by steps, clamped to the book', () => {
    expect(turnPage(pages, null, -1)?.title).toBe('two')
    expect(turnPage(pages, pages[0].key, -1)?.title).toBe('one')
    expect(turnPage(pages, pages[1].key, 5)?.title).toBe('three')
  })
})

describe('a page titled by a helper (PRDCT-4412)', () => {
  it('carries the question as the reader wrote it, and the key of its title', () => {
    const [page] = pagesOf([
      { type: 'user_message', text: 'Do the thing' },
      { type: 'user_message', text: 'and the other one too' },
      { type: 'assistant_text', delta: 'On it', final: true }
    ])
    expect(page.message).toBe('Do the thing\n\nand the other one too')
    expect(page.titleKey).toBe(pageTitleKey(page.message))
    expect(page.title).toBe('Do the thing')
  })

  it('takes the delivery header out of the message it titles', () => {
    const [page] = pagesOf([
      { type: 'user_message', text: `${ANONYMOUS_PROVENANCE_HEADER}\nCheck the build please` }
    ])
    expect(page.message).toBe('Check the build please')
    expect(page.titleKey).toBe(titleKeyOf('Check the build please'))
  })

  it('keys a long message as the host does, on its clipped text', () => {
    const long = 'word '.repeat(600)
    const [page] = pagesOf([{ type: 'user_message', text: long }])
    expect(page.titleKey).toBe(titleKeyOf(long.trimEnd()))
    expect(titleKeyOf(long)).toBe(titleKeyOf(`${long}and more past the clip`))
  })

  it('sends a long question clipped, so what is sent is what is keyed', () => {
    const long = 'a'.repeat(2270)
    const [page] = pagesOf([{ type: 'user_message', text: long }])
    expect(page.message).toHaveLength(1501)
    expect(page.titleKey).toBe(titleKeyOf(page.message))
    expect(page.titleKey).toBe(pageTitleKey(page.message))
    // The brief under a written title still reads the whole question.
    expect(page.fullMessage).toBe(long)
    expect(briefFor(page, 'A written title')).toBe(long)
  })

  it('has no title to ask for a page with no question', () => {
    const [page] = pagesOf([{ type: 'assistant_text', delta: 'Before anything', final: true }])
    expect(page.titleKey).toBeNull()
    expect(page.message).toBe('')
    expect(page.fullMessage).toBe('')
  })

  it('shows the whole message under a written title, the brief under the stand-in', () => {
    const [short] = pagesOf([{ type: 'user_message', text: 'tell me about the weather' }])
    expect(short.brief).toBe('')
    expect(briefFor(short, short.title)).toBe('')
    expect(briefFor(short, 'The weather')).toBe('tell me about the weather')
    // A written title that says exactly the reader's words adds nothing.
    expect(briefFor(short, 'tell me about the weather')).toBe('')
    const [long] = pagesOf([
      { type: 'user_message', text: 'Why does the build fail? It worked yesterday.' }
    ])
    expect(long.title).toBe('Why does the build fail?')
    expect(briefFor(long, long.title)).toBe(long.brief)
    expect(briefFor(long, 'A failing build')).toBe('Why does the build fail? It worked yesterday.')
  })
})
