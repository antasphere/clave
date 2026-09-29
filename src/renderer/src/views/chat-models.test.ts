import { expect, it } from 'vitest'
import type { ModelOption } from '../../../shared/session-model'
import {
  claudeContextWindow,
  claudeModelName,
  findClaudeModel
} from '../../../shared/claude-models'
import { currentOption, modelChipLabel } from '../../../../plugins/chat-view/src/models'

// The menu as the Claude adapter builds it (claudeModelOptions).
const options: ModelOption[] = [
  { id: 'default', label: 'Default', hint: 'Opus 5.5 · Best', resolved: 'claude-opus-5-5' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5', resolved: 'claude-opus-5-5' },
  { id: 'claude-fable-5-1[1m]', label: 'Fable 5.1', resolved: 'claude-fable-5-1' },
  { id: 'claude-fable-5[1m]', label: 'Fable 5', resolved: 'claude-fable-5' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', resolved: 'claude-haiku-4-5-20251001' }
]

it('names the model the same before and after the menu has been opened', () => {
  for (const model of [
    'claude-opus-5-5',
    'claude-opus-5-5[1m]',
    'claude-fable-5-1[1m]',
    'claude-fable-5',
    'claude-haiku-4-5-20251001',
    'default',
    null
  ])
    expect(modelChipLabel(model, null)).toBe(modelChipLabel(model, options))
  expect(modelChipLabel('claude-opus-5-5', null)).toBe('Opus 5.5')
  expect(modelChipLabel(null, null)).toBe('Default')
})

it('tells Fable 5 from Fable 5.1, and a session on Opus from the default that is Opus too', () => {
  expect(currentOption('claude-fable-5', options)?.label).toBe('Fable 5')
  expect(currentOption('claude-fable-5-1', options)?.label).toBe('Fable 5.1')
  expect(currentOption('claude-opus-5-5', options)?.label).toBe('Opus 5.5')
  expect(currentOption('default', options)?.label).toBe('Default')
  expect(currentOption(null, options)?.label).toBe('Default')
})

it('reads any Claude id as its name, a new one from its own shape', () => {
  expect(claudeModelName('opus')).toBe('Opus 5.5')
  expect(claudeModelName('claude-sonnet-5-5')).toBe('Sonnet 5.5')
  expect(claudeModelName('claude-opus-6-20270101')).toBe('Opus 6')
  expect(claudeModelName('gpt-5.5')).toBe('gpt-5.5')
  expect(findClaudeModel('claude-fable-5-1')?.name).toBe('Fable 5.1')
})

it('knows the window of a model before any result names it', () => {
  expect(claudeContextWindow('claude-opus-5-5')).toBe(1_000_000)
  expect(claudeContextWindow('claude-haiku-4-5-20251001')).toBe(200_000)
  expect(claudeContextWindow('opus[1m]')).toBe(1_000_000)
  expect(claudeContextWindow('gpt-5.5')).toBeNull()
})
