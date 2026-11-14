import { expect, it } from 'vitest'
import type { ModelOption } from '../../../shared/session-model'
import {
  claudeContextWindow,
  claudeModelName,
  claudeVersion,
  earlierClaudeIds,
  findClaudeModel,
  isDefaultClaudeAlias
} from '../../../shared/claude-models'
import {
  MODEL_PENDING,
  currentOption,
  effortChoice,
  foldModelOptions,
  modelChipLabel,
  providerChipLabel
} from '../../../../plugins/chat-view/src/models'

// The menu as the Claude adapter builds it (claudeModelOptions, PRDCT-4257):
// no row for the CLI's `default` alias; the model it resolves to carries the
// Default gloss on its own row.
const options: ModelOption[] = [
  {
    id: 'claude-opus-5-5',
    label: 'Opus 5.5',
    hint: 'Default · Best for everyday, complex tasks',
    resolved: 'claude-opus-5-5'
  },
  { id: 'claude-fable-5-1[1m]', label: 'Fable 5.1', resolved: 'claude-fable-5-1' },
  {
    id: 'claude-fable-5[1m]',
    label: 'Fable 5',
    hint: 'Earlier version',
    resolved: 'claude-fable-5'
  },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', resolved: 'claude-haiku-4-5-20251001' }
]

it('names the model the same before and after the menu has been opened', () => {
  for (const model of [
    'claude-opus-5-5',
    'claude-opus-5-5[1m]',
    'claude-fable-5-1[1m]',
    'claude-fable-5',
    'claude-haiku-4-5-20251001',
    null
  ])
    expect(modelChipLabel(model, null)).toBe(modelChipLabel(model, options))
  expect(modelChipLabel('claude-opus-5-5', null)).toBe('Opus 5.5')
  // The gloss stays in the menu; the chip says the name alone.
  expect(modelChipLabel('claude-opus-5-5', options)).toBe('Opus 5.5')
})

it('never writes "Default" on the chip: no model yet reads as pending, the alias as nothing (PRDCT-4256)', () => {
  expect(MODEL_PENDING).toBe('…')
  expect(modelChipLabel(null, null)).toBe(MODEL_PENDING)
  expect(modelChipLabel(null, options)).toBe(MODEL_PENDING)
  expect(modelChipLabel('default', null)).toBe(MODEL_PENDING)
  expect(modelChipLabel('default[1m]', options)).toBe(MODEL_PENDING)
  expect(claudeModelName('default')).toBeNull()
  expect(isDefaultClaudeAlias('default')).toBe(true)
  expect(isDefaultClaudeAlias('default[1m]')).toBe(true)
  expect(isDefaultClaudeAlias('claude-opus-5-5')).toBe(false)
  expect(isDefaultClaudeAlias(null)).toBe(false)
  expect(currentOption(null, options)).toBeUndefined()
  expect(currentOption('default', options)).toBeUndefined()
})

it('tells Fable 5 from Fable 5.1, and finds a session on Opus on the row that is also the default', () => {
  expect(currentOption('claude-fable-5', options)?.label).toBe('Fable 5')
  expect(currentOption('claude-fable-5-1', options)?.label).toBe('Fable 5.1')
  expect(currentOption('claude-opus-5-5', options)?.label).toBe('Opus 5.5')
  expect(currentOption('claude-opus-5-5[1m]', options)?.label).toBe('Opus 5.5')
  expect(currentOption('opus', options)).toBeUndefined()
})

it('folds the earlier versions of a family under one row, every id still a row (PRDCT-4257)', () => {
  const { current, earlier } = foldModelOptions(options)
  expect(current.map((o) => o.label)).toEqual(['Opus 5.5', 'Fable 5.1', 'Haiku 4.5'])
  expect(earlier.map((o) => o.label)).toEqual(['Fable 5'])
  expect(earlier[0].hint).toBe('Earlier version')
  // A session on the earlier version still finds its own row.
  expect(currentOption('claude-fable-5[1m]', options)).toBe(earlier[0])
  // A provider that lists no versions folds nothing.
  const codex: ModelOption[] = [
    { id: 'gpt-5.5', label: 'GPT-5.5' },
    { id: 'gpt-5.5-codex', label: 'GPT-5.5 Codex' }
  ]
  expect(foldModelOptions(codex)).toEqual({ current: codex, earlier: [] })
})

it('decides the newest of a family over the list as given, not over the table (round 1, Major 2)', () => {
  // The ids' own shape: family and version.
  expect(claudeVersion('claude-opus-4-8')).toEqual({ family: 'opus', version: 408 })
  expect(claudeVersion('claude-haiku-4-5-20251001')).toEqual({ family: 'haiku', version: 405 })
  expect(claudeVersion('claude-fable-5-1[1m]')).toEqual({ family: 'fable', version: 501 })
  expect(claudeVersion('claude-sonnet-5')).toEqual({ family: 'sonnet', version: 500 })
  expect(claudeVersion('fable')).toBeNull()
  expect(claudeVersion('gpt-5.5')).toBeNull()
  expect(claudeVersion(null)).toBeNull()
  // A version the table does not know (Haiku 5.5) is the newest over the
  // table's Haiku 4.5; the newest of each family and the shapeless ids never fold.
  const ids = [
    'claude-opus-5-5',
    'claude-fable-5-1',
    'claude-fable-5',
    'claude-sonnet-5-5',
    'claude-haiku-4-5-20251001',
    'claude-haiku-5-5',
    'claude-opus-4-8',
    'claude-sonnet-5',
    'opus',
    'gpt-5.5'
  ]
  expect([...earlierClaudeIds(ids)]).toEqual([
    'claude-fable-5',
    'claude-haiku-4-5-20251001',
    'claude-opus-4-8',
    'claude-sonnet-5'
  ])
  // A family listed once has nothing earlier.
  expect(earlierClaudeIds(['claude-opus-4-8'])).toEqual(new Set())
  // The fold reads each row's model (`resolved`), so an alias row folds by
  // what it stands for, and a row the table knows folds under a CLI-only newer one.
  const rows: ModelOption[] = [
    { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', resolved: 'claude-haiku-4-5-20251001' },
    { id: 'haiku', label: 'Haiku 5.5', resolved: 'claude-haiku-5-5' },
    { id: 'claude-opus-4-8', label: 'Opus 4.8', resolved: 'claude-opus-4-8' },
    { id: 'claude-opus-5-5', label: 'Opus 5.5', resolved: 'claude-opus-5-5' }
  ]
  const folded = foldModelOptions(rows)
  expect(folded.current.map((o) => o.label)).toEqual(['Haiku 5.5', 'Opus 5.5'])
  expect(folded.earlier.map((o) => o.label)).toEqual(['Haiku 4.5', 'Opus 4.8'])
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

it('offers the efforts of the model the session is on, marking the reported one', () => {
  const low = { id: 'low', label: 'Low' }
  const high = { id: 'high', label: 'High' }
  const max = { id: 'max', label: 'Max' }
  const withEfforts: ModelOption[] = [
    {
      id: 'claude-opus-5-5',
      label: 'Opus 5.5',
      hint: 'Default',
      efforts: [low, high, max],
      defaultEffort: 'high'
    },
    { id: 'claude-fable-5', label: 'Fable 5', efforts: [low, high] },
    { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', efforts: [] },
    { id: 'echo-2', label: 'Echo 2' }
  ]
  // The list is not in yet, the model is not in it, or it takes none.
  expect(effortChoice('claude-opus-5-5', 'high', null)).toBeNull()
  expect(effortChoice('gpt-5.5', 'high', withEfforts)).toBeNull()
  expect(effortChoice('claude-haiku-4-5-20251001', null, withEfforts)).toBeNull()
  expect(effortChoice('echo-2', null, withEfforts)).toBeNull()
  // The reported level while the model lists it.
  expect(effortChoice('claude-opus-5-5', 'max', withEfforts)).toEqual({
    efforts: [low, high, max],
    current: max
  })
  // Else the model's own default; else nothing marked.
  expect(effortChoice('claude-opus-5-5', 'ultra', withEfforts)?.current).toBe(high)
  expect(effortChoice('claude-opus-5-5', null, withEfforts)?.current).toBe(high)
  expect(effortChoice('claude-fable-5', 'max', withEfforts)).toEqual({
    efforts: [low, high],
    current: undefined
  })
  // No model yet offers no effort either: the chip hides until the provider says.
  expect(effortChoice(null, 'low', withEfforts)).toBeNull()
})

// Lane D (PRDCT-4427): an OpenCode or a Pi chat's chip names its agent, never
// its provider id in lowercase.
it("reads OpenCode's and Pi's chips by their agent's name", () => {
  expect(providerChipLabel('opencode', 'stand-in/one', null)).toBe('OpenCode · stand-in/one')
  expect(providerChipLabel('pi', 'stand-in/one', null)).toBe('Pi · stand-in/one')
})
