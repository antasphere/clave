import { describe, expect, it } from 'vitest'
import type { AgentQuestion } from '../../../shared/session-model'
import { answerProblem } from '@clave/contract/input-kinds'
import { answersOf } from '../../../../plugins/chat-view/src/input-request'
import {
  cardQuestion,
  nativeAnswers,
  nativeHeadline,
  ownWordsOf,
  pickedOption,
  takesOwnWords,
  togglePick,
  withOwnWords
} from '../../../../plugins/chat-view/src/question-answers'

/* One card asks every question (PRDCT-4322): the form an agent opens through
   clave_request_input, and the question it asks with its own tool. What the
   card reads off a question and an answer, and what it sends, decided
   without a DOM. */

const opts = (...labels: string[]): AgentQuestion['options'] => labels.map((label) => ({ label }))
const lint: AgentQuestion = { question: 'What runs before a push?', options: opts('Lint', 'Tests') }
const host: AgentQuestion = {
  question: 'Which host?',
  options: opts('Cloudflare Pages', 'Cloudflare', 'Vercel')
}

describe("the card's view of a question", () => {
  it("keeps a form's question as the agent asked it", () => {
    const q: AgentQuestion = { id: 'email', question: 'E-mail?', kind: 'email', options: [] }
    expect(cardQuestion(q, 'hosted')).toBe(q)
  })

  it("asks the agent's own question as a choice that takes the person's own words", () => {
    const q = cardQuestion(lint, 'native')
    expect(q.kind).toBe('choice')
    expect(takesOwnWords(q)).toBe(true)
    // Its key and its words are the agent's: the answer goes back under them.
    expect(q.question).toBe(lint.question)
    expect(q.id).toBeUndefined()
    expect(answerProblem(q, 'Lint, only the changed files')).toBeNull()
    expect(answerProblem(q, '')).toBe('An answer is needed')
  })

  it("asks a native question with no option as the person's own words", () => {
    const q = cardQuestion({ id: 'why', question: 'Why?', options: [] }, 'native')
    expect(q.kind).toBe('long-text')
    expect(takesOwnWords(q)).toBe(false)
  })

  it("closes a plugin's question to its options, since the choice IS the answer", () => {
    const q = cardQuestion({ question: 'Install it?', options: opts('Yes', 'No') }, 'plugin')
    expect(q.optionsOnly).toBe(true)
    expect(takesOwnWords(q)).toBe(false)
    expect(answerProblem(q, 'Yes')).toBeNull()
    expect(answerProblem(q, 'Maybe')).toBe('Choose among the options')
  })

  it('a form closed to its options has no answer line', () => {
    const closed: AgentQuestion = { ...lint, id: 'a', kind: 'choice', optionsOnly: true }
    expect(takesOwnWords(closed)).toBe(false)
  })
})

describe('the option a single answer starts from', () => {
  it.each([
    ['Lint', 'Lint'],
    ['Lint, only the changed files', 'Lint'],
    ['Lint — only the changed files', 'Lint'],
    ['Lint (staged only)', 'Lint'],
    ['  Lint', 'Lint'],
    ['Linting everything', null],
    ['lint', null],
    ['Neither: format only', null],
    ['', null]
  ])('%j reads as %j', (answer, option) => {
    expect(pickedOption(lint, answer)).toBe(option)
  })

  it('takes the longest option the answer opens with', () => {
    expect(pickedOption(host, 'Cloudflare Pages')).toBe('Cloudflare Pages')
    expect(pickedOption(host, 'Cloudflare Pages, with previews')).toBe('Cloudflare Pages')
    expect(pickedOption(host, 'Cloudflare Workers')).toBe('Cloudflare')
  })

  it('an option ending on a sign is not cut mid-word', () => {
    const q: AgentQuestion = { question: 'Q?', options: opts('C++', 'Go') }
    expect(pickedOption(q, 'C++20')).toBe('C++')
  })
})

describe("a multi-select's own words", () => {
  const multi: AgentQuestion = { ...lint, multiSelect: true }

  it('stay last, apart from the options picked', () => {
    expect(ownWordsOf(multi, ['Lint', 'and the docs'])).toBe('and the docs')
    expect(ownWordsOf(multi, ['Lint', 'Tests'])).toBe('')
    expect(ownWordsOf(multi, undefined)).toBe('')
    expect(withOwnWords(multi, ['Lint', 'old words'], 'and the docs')).toEqual([
      'Lint',
      'and the docs'
    ])
  })

  it('are kept as typed, and dropped when blank', () => {
    expect(withOwnWords(multi, ['Lint'], 'and ')).toEqual(['Lint', 'and '])
    expect(withOwnWords(multi, ['Lint', 'and'], '')).toEqual(['Lint'])
    expect(withOwnWords(multi, ['Lint', 'and'], '   ')).toEqual(['Lint'])
  })

  it('survive an option picked or unpicked, the options in the order asked', () => {
    expect(togglePick(multi, ['Tests', 'and the docs'], 'Lint')).toEqual([
      'Lint',
      'Tests',
      'and the docs'
    ])
    expect(togglePick(multi, ['Lint', 'Tests', 'and the docs'], 'Lint')).toEqual([
      'Tests',
      'and the docs'
    ])
    expect(togglePick(multi, undefined, 'Tests')).toEqual(['Tests'])
  })
})

describe('the answers a card sends', () => {
  it('trims every answer, drops a blank own word and a question left empty', () => {
    const questions: AgentQuestion[] = [
      lint,
      { ...host, multiSelect: true },
      { question: 'Anything else?', options: [] }
    ]
    expect(
      answersOf(questions, {
        [lint.question]: '  Lint, only the changed files ',
        [host.question]: ['Vercel', ' and a preview  ', '   '],
        'Anything else?': '   '
      })
    ).toEqual({
      'What runs before a push?': 'Lint, only the changed files',
      'Which host?': ['Vercel', 'and a preview']
    })
  })

  it("sends the agent's own question one string per question, as its provider takes it", () => {
    expect(nativeAnswers({ 'Which host?': ['Vercel', 'and a preview'], 'Lint?': 'Lint' })).toEqual({
      'Which host?': 'Vercel, and a preview',
      'Lint?': 'Lint'
    })
  })

  it('leaves out a multi-select whose answer is only blanks', () => {
    const multi: AgentQuestion = { ...lint, multiSelect: true }
    expect(answersOf([multi], { [multi.question]: [' ', ''] })).toEqual({})
  })
})

describe("the words under « Claude asks » on the agent's own question", () => {
  it('drop what the adapters wrote, which the fields already say', () => {
    expect(nativeHeadline('What runs before a push?', [lint])).toBeNull()
    expect(nativeHeadline('Claude asks 3 questions', [lint, host])).toBeNull()
    expect(nativeHeadline('Codex asks 2 questions', [lint, host])).toBeNull()
    expect(nativeHeadline('Claude asks', [lint])).toBeNull()
    expect(nativeHeadline('   ', [lint])).toBeNull()
  })

  it("keep the agent's own framing", () => {
    expect(nativeHeadline('Before I deploy, two things.', [lint, host])).toBe(
      'Before I deploy, two things.'
    )
  })
})
