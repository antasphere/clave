import { describe, expect, it } from 'vitest'
import { transcriptFileName, transcriptMarkdown } from './export'
import type { Entry } from './reducer'

const at = (h: number, m: number): number => new Date(2026, 10, 8, h, m).getTime()
const meta = {
  title: 'Fix the composer',
  agent: 'Claude',
  cwd: '/work/clave',
  model: 'claude-opus-5-5',
  exportedAt: new Date(2026, 10, 8, 15, 4)
}

describe('transcriptMarkdown', () => {
  it('writes each speaker once per turn, tools as one list, answers by label', () => {
    const entries: Entry[] = [
      { kind: 'user', text: 'Why is the border cut?', final: true, at: at(14, 2) },
      { kind: 'assistant', text: 'Let me look.', final: true, at: at(14, 2) },
      {
        kind: 'tool',
        id: 't1',
        name: 'Read',
        input: { file_path: '/work/clave/system.css' },
        complete: true,
        at: at(14, 3)
      },
      {
        kind: 'tool',
        id: 't2',
        name: 'Bash',
        input: { command: 'npm test' },
        complete: true,
        failed: true,
        at: at(14, 3)
      },
      {
        kind: 'permission',
        request: {
          type: 'permission_request',
          id: 'p1',
          description: 'Run npm test?',
          options: [
            { id: 'allow', label: 'Allow' },
            { id: 'deny', label: 'Deny' }
          ]
        },
        answer: 'allow',
        at: at(14, 3)
      },
      { kind: 'assistant', text: 'The fade covers it.', final: true, at: at(14, 4) },
      { kind: 'user', text: 'Taken back', final: true, at: at(14, 5), withdrawn: true },
      { kind: 'error', message: 'socket closed', at: at(14, 6) }
    ]
    const md = transcriptMarkdown(entries, meta)
    expect(md).toContain('# Fix the composer')
    expect(md).toContain('Claude · claude-opus-5-5 · `/work/clave` · exported 2026-11-08 15:04')
    expect(md.match(/^## Claude/gm)).toHaveLength(1)
    expect(md.match(/^## You · 14:02/gm)).toHaveLength(1)
    expect(md).toContain('Let me look.')
    expect(md).toContain('The fade covers it.')
    expect(md).toMatch(/^- .*`\/work\/clave\/system\.css`$/m)
    expect(md).toMatch(/^- .*`npm test` _\(failed\)_$/m)
    expect(md).toContain('> **Asked:** Run npm test?\n> **Answer:** Allow')
    expect(md).toContain('> **Error:** socket closed')
    expect(md).not.toContain('Taken back')
    // The answer comes before the tools in the order they happened.
    expect(md.indexOf('Let me look.')).toBeLessThan(md.indexOf('npm test'))
    expect(md.indexOf('npm test')).toBeLessThan(md.indexOf('The fade covers it.'))
  })

  it('names attachments and fences a target holding backticks', () => {
    const entries: Entry[] = [
      {
        kind: 'user',
        text: 'See this',
        final: true,
        at: at(9, 0),
        attachments: [
          {
            id: 'a',
            label: 'shot',
            path: '/tmp/shot.png',
            name: 'shot.png',
            mimeType: 'image/png',
            size: 1,
            delivery: 'image'
          }
        ]
      },
      {
        kind: 'tool',
        id: 't',
        name: 'Bash',
        input: { command: 'echo `date`' },
        complete: true,
        at: at(9, 1)
      }
    ]
    const md = transcriptMarkdown(entries, meta)
    expect(md).toContain('_Attached: `shot.png`_')
    expect(md).toContain('`` echo `date` ``')
  })
})

describe('transcriptFileName', () => {
  it('keeps a name any disk accepts', () => {
    expect(transcriptFileName('a/b: c?', new Date(2026, 0, 2))).toBe('a b c 2026-01-02.md')
    expect(transcriptFileName('   ', new Date(2026, 0, 2))).toBe('Session 2026-01-02.md')
  })
})
