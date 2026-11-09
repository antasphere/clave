import { describe, expect, it } from 'vitest'
import { accountChoices, modelChoices } from './routine-form-values'

const models = [
  { id: 'claude-opus-5-5', name: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5' }
]
const accounts = [
  { id: 'default', label: 'Default' },
  { id: 'acc-1', label: 'team@antasphere.com' }
]

describe('modelChoices', () => {
  it('offers the default first, then the models the app names', () => {
    expect(modelChoices(models, '').map((c) => c.value)).toEqual([
      '',
      'claude-opus-5-5',
      'claude-sonnet-5-5'
    ])
    expect(modelChoices(models, '')[1].label).toBe('Opus 5.5')
  })
  it('keeps a model named by hand that the list does not know', () => {
    const choices = modelChoices(models, 'claude-opus-6')
    expect(choices.at(-1)).toMatchObject({ value: 'claude-opus-6', label: 'claude-opus-6' })
  })
  it('adds nothing for a model the list already has', () => {
    expect(modelChoices(models, 'claude-sonnet-5-5')).toHaveLength(3)
  })
})

describe('accountChoices', () => {
  it('offers the pool first, then the machine accounts by label', () => {
    expect(accountChoices(accounts, '').map((c) => c.value)).toEqual([
      '',
      'Default',
      'team@antasphere.com'
    ])
  })
  it('reads `any` as the pool and adds no extra choice', () => {
    expect(accountChoices(accounts, 'any')).toHaveLength(3)
  })
  it('reads an account id as its label and adds no extra choice', () => {
    expect(accountChoices(accounts, 'acc-1')).toHaveLength(3)
  })
  it('keeps a value the machine does not list, so an edit never loses it', () => {
    const choices = accountChoices(accounts, 'someone@else.com')
    expect(choices.at(-1)).toMatchObject({ value: 'someone@else.com', label: 'someone@else.com' })
  })
  it('offers only the pool when the machine lists no account yet', () => {
    expect(accountChoices([], '').map((c) => c.value)).toEqual([''])
  })
})
