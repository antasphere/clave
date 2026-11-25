import { describe, expect, it } from 'vitest'
import {
  STATUS_CARD_RULE,
  STATUS_DECIDE_MAX,
  STATUS_FIELD_MAX,
  holdStatusTail,
  readStatusCard,
  statusCardLines,
  statusNeedsYou
} from './status-card'

const block = (...lines: string[]): string => ['```clave-status', ...lines, '```'].join('\n')

describe('readStatusCard', () => {
  it('takes the block off the end of a message and reads its four fields', () => {
    const text = [
      'Yes, rename it.',
      '',
      block(
        'doing: renaming the default branch',
        'where: Nothing changed yet. The rename is three commands.',
        'decide: Does any tool still name main? I would check the pipeline first.',
        'next: Tell me the host of the repository.'
      )
    ].join('\n')
    expect(readStatusCard(text)).toEqual({
      body: 'Yes, rename it.',
      card: {
        doing: 'renaming the default branch',
        where: 'Nothing changed yet. The rename is three commands.',
        decide: ['Does any tool still name main? I would check the pipeline first.'],
        next: 'Tell me the host of the repository.'
      }
    })
  })

  // Three answers real models gave under the rule on 25 November 2026, each
  // through its own harness: the format is theirs, kept as written.
  it.each([
    [
      'Claude Haiku 5.5 through Claude Code',
      [
        'Yes, if nothing outside your control depends on `main`. The rename takes a few commands.',
        '',
        '```clave-status',
        'doing: deciding whether to rename main to trunk',
        'where: Answered from general git guidance. Nothing changed. This directory is not a git repo, so no remote or config was checked.',
        'decide: Does anyone else, or any tool, reference `main` for this repo? Recommendation: rename only if the answer is no, because that is the one thing that breaks.',
        "next: Tell me the git host and whether others clone the repo, and I'll check the references before renaming.",
        '```'
      ].join('\n'),
      { decisions: 1, needsYou: true }
    ],
    [
      'Kimi through Pi',
      [
        'My recommendation: stick with `main` unless you follow trunk-based development workflows. Which repo is this for?',
        '',
        '```clave-status',
        'doing: advising on branch rename to trunk',
        'where: Gave pros/cons and recommendation; no repo changes made',
        'decide: Rename to trunk or keep main — recommend main unless your team standardizes on trunk-based development',
        'next: Tell me which repo and I can perform the rename',
        '```'
      ].join('\n'),
      { decisions: 1, needsYou: true }
    ],
    [
      'a free model through OpenCode',
      [
        "Only if your team or tooling already expects `trunk`; otherwise I'd keep `main`.",
        '',
        '```clave-status',
        'doing: Advising on renaming the default branch to trunk',
        'where: No repo is present in this empty, non-git directory, so this is general guidance. Recommendation is to keep main absent a concrete reason.',
        "decide: Does your team or any tooling already standardise on trunk? I'd keep main otherwise, because the rename breaks references for little gain.",
        'next: nothing',
        '```'
      ].join('\n'),
      { decisions: 1, needsYou: true }
    ]
  ])('reads what %s wrote', (_who, text, expected) => {
    const { body, card } = readStatusCard(text)
    expect(card).not.toBeNull()
    expect(body).not.toContain('clave-status')
    expect(body.endsWith('`') || body.endsWith('?') || body.endsWith('.')).toBe(true)
    expect(card!.decide).toHaveLength(expected.decisions)
    expect(statusNeedsYou(card!)).toBe(expected.needsYou)
    expect(card!.doing).toBeTruthy()
    expect(card!.where).toBeTruthy()
  })

  it('reads "nothing" as nothing owed, with what a model adds around it', () => {
    for (const next of ['nothing', 'Nothing.', '"nothing"', 'none', 'nothing for now', '-', 'N/A'])
      expect(readStatusCard(block('doing: x', `next: ${next}`)).card?.next, next).toBeNull()
    expect(readStatusCard(block('doing: x', 'next: Approve the plan')).card?.next).toBe(
      'Approve the plan'
    )
  })

  // What a real model wrote at the end of a turn that owed nothing (Haiku 5.5
  // in a Clave chat, 25 November 2026): the line it was told to leave out.
  it('reads "decide: nothing" as no decision', () => {
    const card = readStatusCard(
      block(
        'doing: Opening three test tabs in this folder',
        'where: All three tabs opened and are running.',
        'decide: nothing',
        'next: nothing'
      )
    ).card!
    expect(card.decide).toEqual([])
    expect(card.next).toBeNull()
    expect(statusNeedsYou(card)).toBe(false)
    for (const none of ['none', 'Nothing.', 'N/A', '-', 'nothing for now'])
      expect(readStatusCard(block('doing: x', `decide: ${none}`)).card?.decide, none).toEqual([])
    // A question that opens on the word is still a question.
    expect(
      readStatusCard(block('doing: x', 'decide: Nothing else, or the rename too?')).card?.decide
    ).toEqual(['Nothing else, or the rename too?'])
    expect(
      readStatusCard(block('doing: x', 'next: Nothing more, unless you want the rename?')).card
        ?.next
    ).toBe('Nothing more, unless you want the rename?')
  })

  it('says a card asks something only for a decision or a next step', () => {
    const quiet = readStatusCard(block('doing: x', 'where: done', 'next: nothing')).card!
    expect(statusNeedsYou(quiet)).toBe(false)
    expect(statusNeedsYou({ ...quiet, next: 'Merge it' })).toBe(true)
    expect(statusNeedsYou({ ...quiet, decide: ['Which one?'] })).toBe(true)
  })

  it('keeps each decision, in order, up to the cap', () => {
    const lines = Array.from({ length: STATUS_DECIDE_MAX + 2 }, (_, i) => `decide: question ${i}`)
    const card = readStatusCard(block('doing: x', ...lines)).card!
    expect(card.decide).toEqual(
      Array.from({ length: STATUS_DECIDE_MAX }, (_, i) => `question ${i}`)
    )
  })

  it('joins a wrapped line to the field before it', () => {
    const card = readStatusCard(
      block(
        'doing: x',
        'where: half is done',
        'and half is left',
        'decide: A or B?',
        'I would take A.'
      )
    ).card!
    expect(card.where).toBe('half is done and half is left')
    expect(card.decide).toEqual(['A or B? I would take A.'])
  })

  it('reads a key behind a bullet or bold marks, in any case', () => {
    const card = readStatusCard(
      block('- Doing: x', '* **where**: y', '**Decide:** z?', 'NEXT: go')
    ).card!
    expect(card).toEqual({ doing: 'x', where: 'y', decide: ['z?'], next: 'go' })
  })

  it('clips a field that runs long', () => {
    const card = readStatusCard(block(`where: ${'a'.repeat(STATUS_FIELD_MAX + 50)}`)).card!
    expect(card.where).toHaveLength(STATUS_FIELD_MAX)
    expect(card.where!.endsWith('…')).toBe(true)
  })

  it('reads a message written with Windows line ends', () => {
    const text = `Done.\r\n\r\n${block('doing: x', 'next: nothing').replace(/\n/g, '\r\n')}\r\n`
    const { body, card } = readStatusCard(text)
    expect(body).toBe('Done.')
    expect(card).toEqual({ doing: 'x', where: null, decide: [], next: null })
  })

  it('accepts a longer fence and tildes', () => {
    expect(readStatusCard('Hi\n\n````clave-status\ndoing: x\n````').card?.doing).toBe('x')
    expect(readStatusCard('Hi\n\n~~~clave-status\ndoing: x\n~~~').card?.doing).toBe('x')
  })

  describe('leaves the text as written when the block is not the ending', () => {
    const untouched = (text: string): void =>
      expect(readStatusCard(text)).toEqual({ body: text, card: null })

    it('words after the block', () => untouched(`${block('doing: x')}\n\nOne more thing.`))
    it('a code block after the block', () =>
      untouched(`${block('doing: x')}\n\n\`\`\`sh\nls\n\`\`\``))
    it('a block never closed', () => untouched('Hi\n\n```clave-status\ndoing: x'))
    it('a block that names no field', () => untouched('Hi\n\n```clave-status\nall good\n```'))
    it('a block with every field empty', () =>
      untouched('Hi\n\n```clave-status\ndoing:\nnext:\n```'))
    it('the format quoted inside a longer fence', () =>
      untouched(`The format:\n\n\`\`\`\`\n${block('doing: x', 'next: nothing')}\n\`\`\`\``))
    it('the tag named in prose', () => untouched('The fence is tagged clave-status.'))
    it('an indented code block', () =>
      untouched('Hi\n\n    ```clave-status\n    doing: x\n    ```'))
  })

  it('takes the last block when an earlier one was written mid-message', () => {
    const text = `${block('doing: first')}\n\nThen more work.\n\n${block('doing: second')}`
    const { body, card } = readStatusCard(text)
    expect(card?.doing).toBe('second')
    expect(body).toBe(`${block('doing: first')}\n\nThen more work.`)
  })

  it('reads a message that is the block alone', () => {
    expect(readStatusCard(block('doing: x', 'next: nothing'))).toEqual({
      body: '',
      card: { doing: 'x', where: null, decide: [], next: null }
    })
  })
})

describe('the rule and the reader agree', () => {
  it("reads the rule's own example into the four fields it names", () => {
    const start = STATUS_CARD_RULE.indexOf('```clave-status')
    const end = STATUS_CARD_RULE.indexOf('```', start + 3) + 3
    const { card } = readStatusCard(STATUS_CARD_RULE.slice(0, end))
    expect(card).not.toBeNull()
    expect(card!.doing).toBeTruthy()
    expect(card!.where).toBeTruthy()
    expect(card!.decide).toHaveLength(1)
    // The example's `next` spells both of its values out, so it reads as a step.
    expect(card!.next).toBeTruthy()
    const keys = STATUS_CARD_RULE.slice(start, end)
      .split('\n')
      .slice(1, -1)
      .map((line) => line.split(':')[0])
    expect(keys).toEqual(['doing', 'where', 'decide', 'next'])
  })
})

describe('holdStatusTail', () => {
  const message = [
    'Here is the fix.',
    '',
    '```ts',
    'const a = 1',
    '```',
    '',
    'It passes.',
    '',
    block('doing: fixing the test', 'where: done', 'next: nothing')
  ].join('\n')

  it('never loses a character, whatever the stream has delivered', () => {
    for (let n = 0; n <= message.length; n++) {
      const part = message.slice(0, n)
      const { body, held } = holdStatusTail(part)
      expect(body + held, `at ${n}`).toBe(part)
    }
  })

  it('never shows any of the block, from its first fence character on', () => {
    const start = message.indexOf('```clave-status')
    for (let n = start + 3; n <= message.length; n++) {
      const { body } = holdStatusTail(message.slice(0, n))
      expect(body, `at ${n}`).toBe(message.slice(0, start))
    }
  })

  it('shows an ordinary code block as it is written', () => {
    const code = 'Look:\n\n```ts\nconst a = 1\n```\n\nDone.'
    const shown = (n: number): string => holdStatusTail(code.slice(0, n)).body
    // Its opening fence is held for the one frame it could still be the block.
    expect(shown(code.indexOf('```ts') + 3)).toBe('Look:\n\n')
    expect(shown(code.indexOf('```ts') + 4)).toBe('Look:\n\n```t')
    // Its closing fence is never held: a fence inside a fence opens nothing.
    const close = code.lastIndexOf('```') + 3
    expect(shown(close)).toBe(code.slice(0, close))
    expect(shown(code.length)).toBe(code)
  })

  it('lets go of a block once words follow it', () => {
    const text = `${block('doing: x')}\n\nAnd then`
    expect(holdStatusTail(text)).toEqual({ body: text, held: '' })
  })

  it('holds nothing of a message that names the tag in prose', () => {
    const text = 'The fence is tagged clave-status, and here is why'
    expect(holdStatusTail(text)).toEqual({ body: text, held: '' })
  })
})

describe('statusCardLines', () => {
  it('writes the card as plain lines, the next step always said', () => {
    expect(statusCardLines({ doing: 'x', where: 'y', decide: ['a?', 'b?'], next: null })).toEqual([
      'Doing: x',
      'Where: y',
      'To decide: a?',
      'To decide: b?',
      'Next: nothing'
    ])
    expect(statusCardLines({ doing: null, where: null, decide: [], next: 'Merge it' })).toEqual([
      'Next: Merge it'
    ])
  })
})
