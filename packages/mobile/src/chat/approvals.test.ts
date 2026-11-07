import { describe, expect, it } from 'vitest'
import type { Entry } from './reducer'
import {
  approvalRunSummary,
  decisionWord,
  describeApproval,
  isQuestion,
  refused,
  settledApproval
} from './approvals'

const permission = (
  over: Partial<Entry & { kind: 'permission' }> = {}
): Extract<Entry, { kind: 'permission' }> => ({
  kind: 'permission',
  request: {
    type: 'permission_request',
    id: 'p',
    description: 'Allow?',
    toolName: 'Bash',
    options: [
      { id: 'allow', label: 'Allow' },
      { id: 'deny', label: 'Deny' }
    ]
  },
  at: 0,
  ...over
})

describe('approvals', () => {
  it('reads a Codex command approval in the reader words', () => {
    expect(
      describeApproval({
        type: 'permission_request',
        id: 'c',
        description: 'x',
        toolName: 'item/commandExecution/requestApproval',
        input: { command: ['npm', 'test'] },
        options: []
      })
    ).toEqual({ label: 'Run a command', target: 'npm test' })
  })

  it('says a decision in words and knows a refusal', () => {
    const entry = permission()
    expect(decisionWord(entry.request, 'allow')).toBe('Allow')
    expect(refused(entry.request, 'deny')).toBe(true)
    expect(refused(entry.request, 'allow')).toBe(false)
    expect(
      refused(
        {
          ...entry.request,
          options: [{ id: '{"permissions":{}}', label: 'Deny extra permissions' }]
        },
        '{"permissions":{}}'
      )
    ).toBe(true)
  })

  it('folds only an allowed, answered, tool-named approval into a run', () => {
    expect(settledApproval(permission({ answer: 'allow' }))).toBe(true)
    expect(settledApproval(permission({ answer: 'deny' }))).toBe(false)
    expect(settledApproval(permission())).toBe(false)
    expect(settledApproval(permission({ answer: 'allow', answeredElsewhere: true }))).toBe(false)
    const question = permission({ answer: 'answer' })
    expect(isQuestion({ ...question.request, toolName: undefined })).toBe(true)
  })

  it('summarises a run by what was allowed', () => {
    const a = permission({ answer: 'allow' })
    expect(approvalRunSummary([a, a])).toEqual({ head: 'Allowed 2 requests', detail: 'Bash ×2' })
  })
})
