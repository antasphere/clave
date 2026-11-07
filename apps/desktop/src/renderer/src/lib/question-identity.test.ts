import { describe, expect, it } from 'vitest'
import { questionKey, questionIsPrivate, publicQuestionAnswers } from './question-identity'

describe('request-scoped question identity', () => {
  const questions = [
    { id: 'public-id', question: 'Value?' },
    { id: 'private-id', question: 'Value?' }
  ]
  const input = {
    questions: [
      { ...questions[0], isSecret: false },
      { ...questions[1], isSecret: true }
    ]
  }
  it('keeps same-label questions distinct without exposing IDs as labels', () => {
    expect(questions.map(questionKey)).toEqual(['public-id', 'private-id'])
    expect(questions.map((q) => questionIsPrivate(q, input))).toEqual([false, true])
    expect(questions.map((q) => q.question)).toEqual(['Value?', 'Value?'])
  })
  it('keeps private values out of the local transcript projection', () => {
    expect(
      publicQuestionAnswers(questions, input, {
        'public-id': 'public answer',
        'private-id': 'synthetic-private-answer'
      })
    ).toEqual({ 'public-id': 'public answer' })
    expect(
      publicQuestionAnswers([questions[1]], input, { 'private-id': 'synthetic-private-answer' })
    ).toBeUndefined()
  })
  it('preserves no-id legacy questions and never aliases an ID to a matching label', () => {
    const legacy = { question: 'Old question' }
    expect(questionKey(legacy)).toBe('Old question')
    expect(
      questionIsPrivate(legacy, { questions: [{ question: legacy.question, isSecret: true }] })
    ).toBe(true)
    expect(
      questionIsPrivate(questions[0], { questions: [{ question: 'Value?', isSecret: true }] })
    ).toBe(false)
  })
})
