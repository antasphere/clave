import { describe, expect, it } from 'vitest'
import { INPUT_REQUEST_TOOL, answerProblem, inputRequestMeta } from './input-kinds'

/* The one rule for whether an answer fits its question (PRDCT-4157), read by
   the card as the reader types and by the server as it is handed the answer.
   Each row: a question, an answer, and the problem the reader is told, or
   null when the answer fits. */
const q = (kind: string, more: Record<string, unknown> = {}): never =>
  ({ id: 'q', question: 'Q?', kind, options: [], ...more }) as never

describe('answers judged by their kind', () => {
  it.each([
    ['text', 'anything', null],
    ['text', '   ', 'An answer is needed'],
    ['long-text', 'two\nlines', null],
    ['email', 'romain@antasphere.com', null],
    ['email', 'romain@antasphere', 'This is not an e-mail address'],
    ['email', 'not an email', 'This is not an e-mail address'],
    ['url', 'https://clave.antasphere.com/x?y=1', null],
    ['url', 'ftp://host', 'A web address starts with https://'],
    ['url', 'clave', 'This is not a web address'],
    ['github-login', 'RominHood', null],
    ['github-login', 'romin-hood-2', null],
    ['github-login', '-romain', 'A GitHub login is letters, digits and hyphens'],
    ['github-login', 'ro--main', 'A GitHub login is letters, digits and hyphens'],
    ['github-login', 'romain pattyn', 'A GitHub login is letters, digits and hyphens'],
    ['number', '42', null],
    ['number', '-3.5', null],
    ['number', 'forty', 'This is not a number'],
    ['date', '2026-11-07', null],
    ['date', '2026-13-07', 'This is not a date'],
    ['date', '7/11/2026', 'A date, as YYYY-MM-DD'],
    ['file', '/Users/romain/file.txt', null],
    ['folder', '~/.antasphere', null],
    ['folder', 'relative/path', 'A full path, from the root of the disk'],
    ['link', 'done', null],
    ['link', 'opened', 'Open the link, then confirm']
  ])('%s: %j → %j', (kind, value, problem) => {
    expect(answerProblem(q(kind), value)).toBe(problem)
  })

  it('bounds a number when the question has bounds', () => {
    expect(answerProblem(q('number', { min: 1, max: 5 }), '0')).toBe('At least 1')
    expect(answerProblem(q('number', { min: 1, max: 5 }), '6')).toBe('At most 5')
    expect(answerProblem(q('number', { min: 1, max: 5 }), '3')).toBeNull()
  })

  it('lets only an optional question stay empty', () => {
    expect(answerProblem(q('email'), undefined)).toBe('An answer is needed')
    expect(answerProblem(q('email', { optional: true }), undefined)).toBeNull()
    expect(answerProblem(q('email', { optional: true }), '')).toBeNull()
    expect(answerProblem(q('email', { optional: true }), 'typo@')).toBe(
      'This is not an e-mail address'
    )
  })

  it('a choice is one of the options, or several when allowed', () => {
    const one = q('choice', { options: [{ label: 'A' }, { label: 'B' }] })
    expect(answerProblem(one, 'A')).toBeNull()
    expect(answerProblem(one, 'C')).toBe('Choose among the options')
    expect(answerProblem(one, ['A', 'B'])).toBe('Choose one')
    const many = q('choice', { options: [{ label: 'A' }, { label: 'B' }], multiSelect: true })
    expect(answerProblem(many, ['A', 'B'])).toBeNull()
    expect(answerProblem(many, ['A', 'Z'])).toBe('Choose among the options')
    expect(answerProblem(many, [])).toBe('An answer is needed')
  })

  it("a provider's own question has no kind and takes any words", () => {
    expect(answerProblem(q(undefined as never), 'whatever the reader typed')).toBeNull()
    expect(answerProblem(q(undefined as never), '')).toBe('An answer is needed')
  })

  it('a typed question refuses an array', () => {
    expect(answerProblem(q('text'), ['a', 'b'])).toBe('One answer is expected')
  })
})

describe('the hosted request meta', () => {
  it('reads the tool and the layout off the request input, form by default', () => {
    expect(inputRequestMeta({ tool: INPUT_REQUEST_TOOL })).toEqual({
      tool: INPUT_REQUEST_TOOL,
      layout: 'form'
    })
    expect(inputRequestMeta({ tool: INPUT_REQUEST_TOOL, layout: 'steps' })).toEqual({
      tool: INPUT_REQUEST_TOOL,
      layout: 'steps'
    })
  })
  it("is null for a provider's own question", () => {
    expect(inputRequestMeta({ questions: [{ question: 'Which?' }] })).toBeNull()
    expect(inputRequestMeta(undefined)).toBeNull()
    expect(inputRequestMeta('AskUserQuestion')).toBeNull()
  })
})
