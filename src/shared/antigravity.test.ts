import { describe, expect, it } from 'vitest'
import {
  antigravityDefaultMode,
  antigravityWindowsForModel,
  parseAntigravityModels,
  splitModelLevel
} from './antigravity'

// `agy models`, 1.5.14, a Google AI Ultra account, 22 November 2026.
const PRINTED = `gemini-4-neon-high\tGemini 4 Neon (High)
gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)
gemini-4-neon-medium\tGemini 4 Neon (Medium)
gemini-4-neon-low\tGemini 4 Neon (Low)
gemini-pro-orchestrator-neon\tOrchestrator (Neon)
gemini-pro-orchestrator\tOrchestrator (Carbon)
claude-opus-5-5-low\tClaude Opus 5.5 (Low)
claude-opus-5-5-medium\tClaude Opus 5.5 (Medium)
claude-opus-5-5-high\tClaude Opus 5.5 (High)
gpt-oss-120b-medium\tGPT-OSS 120B (Medium)
`

describe('parseAntigravityModels', () => {
  it('folds the levels into one model each, as `agy acp` lists them', () => {
    const models = parseAntigravityModels(PRINTED)
    expect(models.map((m) => [m.id, m.label])).toEqual([
      ['gemini-4-neon', 'Gemini 4 Neon'],
      ['gemini-pro-orchestrator-neon', 'Orchestrator (Neon)'],
      ['gemini-pro-orchestrator', 'Orchestrator (Carbon)'],
      ['claude-opus-5-5', 'Claude Opus 5.5'],
      ['gpt-oss-120b-medium', 'GPT-OSS 120B (Medium)']
    ])
    expect(models[0].efforts).toEqual([
      { id: 'low', label: 'Low' },
      { id: 'medium', label: 'Medium' },
      { id: 'high', label: 'High' },
      { id: 'xhigh', label: 'Extra' }
    ])
    expect(models[1].efforts).toBeUndefined()
    expect(models[4].efforts).toBeUndefined()
  })
  it('reads no model out of lines that name none', () => {
    expect(parseAntigravityModels('Fetching available models...\n\nError: offline\n')).toEqual([])
  })
})

describe('splitModelLevel', () => {
  it('splits only when the base is offered', () => {
    const offered = ['gemini-4-neon', 'gpt-oss-120b-medium']
    expect(splitModelLevel('gemini-4-neon-xhigh', offered)).toEqual({
      model: 'gemini-4-neon',
      level: 'xhigh'
    })
    expect(splitModelLevel('gpt-oss-120b-medium', offered)).toBeNull()
    expect(splitModelLevel('gemini-4-neon', offered)).toBeNull()
  })
})

describe('antigravityDefaultMode', () => {
  it.each([
    ['no file', null, 'auto'],
    ['no agentMode', '{"model":"Gemini 4 Neon (Medium)"}', 'auto'],
    ['a byte order mark', '\uFEFF{}', 'auto'],
    ['auto', '{"agentMode":"auto"}', 'auto'],
    ['accept-edits', '{"agentMode":"accept-edits"}', 'accept-edits'],
    ['plan', '{"agentMode":"plan"}', 'plan'],
    ['the empty default', '{"agentMode":""}', 'default'],
    ['default', '{"agentMode":"default"}', 'default'],
    ['null', '{"agentMode":null}', 'default'],
    ['an unknown mode', '{"agentMode":"yolo"}', 'default'],
    ['strict', '{"agentMode":"auto","toolPermission":"strict"}', 'default'],
    ['a file that does not parse', '{"agentMode":', 'default'],
    ['an empty file', '', 'default'],
    ['a list', '[]', 'default']
  ])('%s', (_name, settings, mode) => {
    expect(antigravityDefaultMode(settings)).toBe(mode)
  })
})

describe('antigravityWindowsForModel', () => {
  const windows = [
    { key: 'gemini-weekly' },
    { key: 'gemini-5h' },
    { key: '3p-weekly' },
    { key: '3p-5h' }
  ]
  const keys = (model?: string): string[] =>
    antigravityWindowsForModel(windows, model).map((w) => w.key)

  it('gives a model the group it draws on', () => {
    expect(keys('gemini-4-neon')).toEqual(['gemini-weekly', 'gemini-5h'])
    expect(keys('gemini-pro-orchestrator')).toEqual(['gemini-weekly', 'gemini-5h'])
    expect(keys('claude-opus-5-5')).toEqual(['3p-weekly', '3p-5h'])
    expect(keys('gpt-oss-120b-medium')).toEqual(['3p-weekly', '3p-5h'])
  })
  it('gives every group with no model, or where none is the model’s', () => {
    expect(keys()).toHaveLength(4)
    expect(antigravityWindowsForModel([{ key: 'all-weekly' }], 'gemini-4-neon')).toHaveLength(1)
  })
})
