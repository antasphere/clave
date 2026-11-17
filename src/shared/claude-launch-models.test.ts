import { describe, expect, it } from 'vitest'
import { claudeLaunchModels, findClaudeModel, tableLaunchModels } from './claude-models'
import { claudeModelOptions } from '../main/sessions/adapters/claude-adapter'

// The CLI's own list as Claude Code 2.1.326 answered `initialize`, 2026-11-17,
// plus a version no table knows yet, standing for the next one to ship.
const cli = [
  {
    value: 'default',
    resolvedModel: 'claude-opus-5-5',
    displayName: 'Default (recommended)',
    description: 'Opus 5.5 · Best for everyday, complex tasks'
  },
  {
    value: 'opus',
    resolvedModel: 'claude-opus-5-5',
    displayName: 'Opus 5.5',
    description: 'For complex work and everyday tasks'
  },
  {
    value: 'fable',
    resolvedModel: 'claude-fable-5-2',
    displayName: 'Fable 5.2',
    description: 'For your toughest challenges'
  },
  {
    value: 'sonnet',
    resolvedModel: 'claude-sonnet-5-5',
    displayName: 'Sonnet 5.5',
    description: 'Most efficient for simpler tasks'
  },
  {
    value: 'haiku',
    resolvedModel: 'claude-haiku-5-5',
    displayName: 'Haiku 5.5',
    description: 'Fastest for quick answers'
  },
  {
    value: 'claude-fable-5-1',
    resolvedModel: 'claude-fable-5-1',
    displayName: 'Fable 5.1',
    description: 'Most capable'
  },
  {
    value: 'claude-haiku-4-5-20251001',
    resolvedModel: 'claude-haiku-4-5-20251001',
    displayName: 'Haiku 4.5',
    description: 'Fastest'
  },
  {
    value: 'claude-opus-5',
    resolvedModel: 'claude-opus-5',
    displayName: 'Opus 5',
    description: 'Best'
  },
  {
    value: 'claude-opus-4-8',
    resolvedModel: 'claude-opus-4-8',
    displayName: 'Opus 4.8',
    description: 'Best'
  },
  {
    value: 'claude-sonnet-6',
    resolvedModel: 'claude-sonnet-6',
    displayName: 'Sonnet 6',
    description: 'Next'
  }
]

describe('the launcher’s Claude models', () => {
  it('offers what the CLI lists, a version Clave does not know included, without its unnamed elders', () => {
    const rows = claudeLaunchModels(claudeModelOptions(cli))
    const labels = rows.map((row) => row.label)
    expect(labels).toContain('Fable 5.2')
    expect(labels).toContain('Sonnet 6')
    expect(labels).toContain('Haiku 5.5')
    // Earlier versions the table names stay reachable; the others fold away.
    expect(labels).toContain('Fable 5.1')
    expect(labels).not.toContain('Opus 4.8')
    expect(labels).not.toContain('Opus 5')
    expect(new Set(labels).size).toBe(labels.length)
    expect(rows.find((row) => row.label === 'Sonnet 6')).toMatchObject({
      id: 'claude-sonnet-6',
      family: 'Sonnet'
    })
  })
  it('answers the table when the CLI lists nothing', () => {
    expect(claudeLaunchModels([])).toEqual(tableLaunchModels())
  })
  it('names a family by its newest version', () => {
    expect(findClaudeModel('fable')?.name).toBe('Fable 5.2')
    expect(findClaudeModel('haiku')?.name).toBe('Haiku 5.5')
  })
})
