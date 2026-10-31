import { describe, expect, it } from 'vitest'
import type { PendingRequest } from '../contract/types'
import {
  answersAsPermission,
  answerText,
  shapeClarification,
  shapePermission,
  shapeSecret
} from './answers'

const permission: PendingRequest = {
  id: 'p',
  sessionId: 's',
  kind: 'permission',
  description: 'Run ls?',
  createdAt: 1,
  options: [
    { id: 'allow-once', label: 'Allow once' },
    { id: 'deny', label: 'Deny' }
  ]
}
const questions: PendingRequest = {
  id: 'q',
  sessionId: 's',
  kind: 'clarification',
  description: 'Two questions',
  createdAt: 1,
  providerRequestId: 'native-3',
  options: [
    { id: 'answer', label: 'Answer' },
    { id: 'deny', label: 'Skip' }
  ],
  questions: [
    {
      id: 'colour',
      question: 'Which colour?',
      options: [{ label: 'Red' }, { label: 'Blue' }],
      multiSelect: true
    },
    { question: 'Why?', options: [{ label: 'Because' }] }
  ]
}

describe('shaping the answers', () => {
  it('a permission answers with one of its options and nothing else', () => {
    expect(shapePermission(permission, 'allow-once')).toEqual({
      ok: true,
      response: { type: 'permission', optionId: 'allow-once' }
    })
    expect(shapePermission(permission, 'allow-always')).toMatchObject({ ok: false })
  })
  it('a native question answers like a permission with the answers keyed by id or text', () => {
    expect(answersAsPermission(questions)).toBe(true)
    expect(answersAsPermission(permission)).toBe(true)
    expect(answersAsPermission({ ...questions, providerRequestId: undefined })).toBe(false)
    const shaped = shapePermission(questions, 'answer', {
      colour: { picked: ['Red', 'Blue'], other: 'and a bit of green' },
      'Why?': { picked: ['Because'] }
    })
    expect(shaped).toEqual({
      ok: true,
      response: {
        type: 'permission',
        optionId: 'answer',
        answers: { colour: 'Red, Blue, and a bit of green', 'Why?': 'Because' }
      }
    })
  })
  it('a missing answer names the question and sends nothing', () => {
    expect(shapePermission(questions, 'answer', { colour: { picked: ['Red'] } })).toEqual({
      ok: false,
      problem: 'Answer "Why?" first.'
    })
    expect(shapePermission(questions, 'deny')).toEqual({
      ok: true,
      response: { type: 'permission', optionId: 'deny' }
    })
  })
  it('a single choice keeps one pick, a free answer alone counts', () => {
    const q = questions.questions![1]!
    expect(answerText(q, { picked: ['Because', 'Other'] })).toBe('Because')
    expect(answerText(q, { picked: [], other: '  typed  ' })).toBe('typed')
    expect(answerText(q, undefined)).toBe('')
  })
  it('a clarification without a provider id answers as a clarification', () => {
    const plain = { ...questions, providerRequestId: undefined, options: undefined }
    expect(
      shapeClarification(plain, {
        colour: { picked: ['Blue'] },
        'Why?': { picked: [], other: 'x' }
      })
    ).toEqual({
      ok: true,
      response: { type: 'clarification', answers: { colour: 'Blue', 'Why?': 'x' } }
    })
  })
  it('a secret travels as its value and never empty', () => {
    expect(shapeSecret('')).toMatchObject({ ok: false })
    expect(shapeSecret('shh')).toEqual({ ok: true, response: { type: 'secret', value: 'shh' } })
  })
})
