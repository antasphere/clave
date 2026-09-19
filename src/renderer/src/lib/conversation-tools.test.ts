import { describe, expect, it } from 'vitest'
import type { ConversationTool } from '../../../shared/agent-session'
import {
  describeTool,
  groupConversationEntries,
  toolGroupSummary,
  toolPreview
} from './conversation-tools'

const tool = (
  id: string,
  name = 'Read',
  input = JSON.stringify({ file_path: `src/${id}.ts` })
): ConversationTool => ({
  kind: 'tool',
  id,
  name,
  input,
  status: 'completed'
})

describe('tool activity presentation', () => {
  it('groups mixed calls between messages without hiding artifacts or mutating history', () => {
    const entries = [
      tool('a'),
      {
        kind: 'artifact' as const,
        id: 'report',
        title: 'Report',
        mimeType: 'text/plain' as const,
        content: 'result',
        fallback: 'result'
      },
      tool('b', 'Bash', 'npm test'),
      { kind: 'message' as const, id: 'answer', role: 'assistant' as const, text: 'Done' },
      tool('c'),
      { kind: 'message' as const, id: 'prompt', role: 'user' as const, text: 'Again' },
      tool('d')
    ]
    const groups = groupConversationEntries(entries)
    expect(groups.map((e) => e.kind)).toEqual([
      'tool-group',
      'artifact',
      'message',
      'tool-group',
      'message',
      'tool-group'
    ])
    expect(groups[0]).toMatchObject({ id: 'a', tools: [entries[0], entries[2]] })
    expect(entries).toHaveLength(7)
  })
  it('summarizes mixed runs and single targets', () => {
    expect(toolGroupSummary([tool('a')])).toBe('Read · src/a.ts')
    expect(
      toolGroupSummary([tool('a'), tool('b'), tool('c'), tool('d', 'commandExecution', 'npm test')])
    ).toBe('Read 3 files · Ran 1 command')
    expect(toolGroupSummary([tool('x', 'custom-tool'), tool('y', 'custom-tool')])).toBe(
      'custom-tool × 2'
    )
  })
  it('formats ranges, query locations, content blocks, and available exit codes', () => {
    expect(
      describeTool({
        ...tool('a', 'Read', '{"file_path":"src/a.ts","offset":11,"limit":20}'),
        output: '[{"type":"text","text":"file contents"}]'
      })
    ).toMatchObject({
      target: 'src/a.ts',
      detail: 'Lines 11–30',
      sections: [{ label: 'Content', text: 'file contents' }]
    })
    expect(describeTool(tool('b', 'Grep', '{"pattern":"composer","path":"src"}'))).toMatchObject({
      target: 'composer',
      detail: 'In src'
    })
    expect(
      describeTool({
        ...tool('c', 'Bash', '{"command":"npm test"}'),
        output: '{"stdout":"passed","exit_code":0}'
      })
    ).toMatchObject({
      target: 'npm test',
      detail: 'Exit 0',
      sections: [{ label: 'Output', text: 'passed' }]
    })
  })
  it('shows supplied diffs or old/new text without inventing line numbers', () => {
    expect(
      describeTool(tool('e', 'Edit', '{"file_path":"a.ts","old_string":"old","new_string":"new"}'))
        .sections
    ).toEqual([{ label: 'a.ts', text: '- old\n+ new' }])
    expect(
      describeTool(tool('c', 'fileChange', '[{"path":"a.ts","diff":"@@ -1 +1 @@\\n-old\\n+new"}]'))
        .sections
    ).toEqual([{ label: 'a.ts', text: '@@ -1 +1 @@\n-old\n+new' }])
  })
  it('keeps malformed and unfamiliar tool data readable', () => {
    expect(
      describeTool({ ...tool('x', 'custom', '{partial'), output: '{"arbitrary":true}' })
    ).toMatchObject({
      target: '{partial',
      sections: [{ label: 'Output', text: '{\n  "arbitrary": true\n}' }]
    })
  })
  it('bounds both multiline and single-line previews', () => {
    expect(toolPreview(Array.from({ length: 20 }, (_, i) => String(i)).join('\n'))).toEqual({
      text: '0\n1\n2\n3\n4\n5\n6\n7',
      truncated: true
    })
    expect(toolPreview('a'.repeat(3000)).text).toHaveLength(2000)
    expect(toolPreview('small')).toEqual({ text: 'small', truncated: false })
  })
})
