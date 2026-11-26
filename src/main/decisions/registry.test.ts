import { afterEach, describe, expect, it } from 'vitest'
import {
  decisionById,
  decisionConfig,
  defineDecision,
  listDecisions,
  resetDecisionsForTests,
  setDecisionConfigSource,
  type DecisionDefinition
} from './registry'

// The decisions' registry (PRDCT-5179): one declaration per id, and the one
// config seam the runner reads before each request.

const decision = (id: string, label = id): DecisionDefinition<string, string> => ({
  id,
  label,
  description: 'An invented decision.',
  model: 'jev-1.14.0',
  timeoutMs: 1000,
  build: (input) => ({ state: input, questions: { q: { type: 'noul', instructions: 'Yes?' } } }),
  read: () => 'read'
})

afterEach(() => resetDecisionsForTests())

describe('the decisions registry', () => {
  it('declares, lists by label and finds by id', () => {
    const b = defineDecision(decision('quill-b', 'Bravo'))
    const a = defineDecision(decision('quill-a', 'Alpha'))
    expect(listDecisions()).toEqual([a, b])
    expect(decisionById('quill-a')).toBe(a)
    expect(decisionById('nope')).toBeUndefined()
  })

  it('a second declaration of an id throws; the same one again does not', () => {
    const a = defineDecision(decision('atlas'))
    expect(defineDecision(a)).toBe(a)
    expect(() => defineDecision(decision('atlas'))).toThrow('declared twice')
  })

  it('an id that is not kebab-case throws', () => {
    expect(() => defineDecision(decision('Atlas_One'))).toThrow('kebab-case')
  })

  it('is on by default; a source overrides the switch and passes a refusal through', () => {
    const a = defineDecision(decision('lumen'))
    expect(decisionConfig(a)).toEqual({ enabled: true })
    setDecisionConfigSource((id) => (id === 'lumen' ? { enabled: false } : undefined))
    expect(decisionConfig(a)).toEqual({ enabled: false })
    setDecisionConfigSource(() => ({ refused: 'Not here.' }))
    expect(decisionConfig(a)).toEqual({ enabled: true, refused: 'Not here.' })
    setDecisionConfigSource()
    expect(decisionConfig(a)).toEqual({ enabled: true })
  })
})
