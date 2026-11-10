/**
 * The permission card's reading (PRDCT-4331): the level from the rules on
 * the first frame, "Reading what this does…" while the host reads, then the
 * sentence; a reading never brings the level below the rules' floor, and a
 * tab that can go back to skipping permissions says so.
 */
import { describe, expect, it, vi } from 'vitest'
import * as ReactModule from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PermissionRow } from '../../../../plugins/chat-view/src/PromptDock'
import {
  BackToBypass,
  ModeLine,
  PermissionLevelTag,
  PermissionReading
} from '../../../../plugins/chat-view/src/PermissionReading'
import {
  PermissionReadingProvider,
  type PermissionReadingValue
} from '../../../../plugins/chat-view/src/permission-reading-context'
import type { Permission } from '../../../../plugins/chat-view/src/reducer'

vi.mock('../../../../plugins/chat-view/src/permission-reading.css', () => ({}))
// The dock's modules keep the reader's disclosures in localStorage at load.
vi.hoisted(() => {
  const store = new Map<string, string>()
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0
  }
})
// The plugin's files sit outside the renderer's tsconfig, so vitest compiles
// their JSX to the classic runtime, which reads React off the scope.
;(globalThis as { React?: unknown }).React = ReactModule

const request = (command: string): Permission => ({
  type: 'permission_request',
  id: 'r1',
  description: 'Allow Bash?',
  toolName: 'Bash',
  input: { command },
  options: [{ id: 'allow-once', label: 'Allow once' }]
})
const render = (node: React.JSX.Element, value: PermissionReadingValue | null): string =>
  renderToStaticMarkup(
    value ? <PermissionReadingProvider value={value}>{node}</PermissionReadingProvider> : node
  )

const explained = (
  reading: Partial<Extract<PermissionReadingValue['explained'][string], object>>
): PermissionReadingValue => ({
  explained: { r1: { type: 'permission_explained', id: 'r1', ...reading } },
  cwd: '/repo'
})

describe('the reading on the card', () => {
  it('shows the level the rules found at once and says it is reading', () => {
    const html = render(<PermissionReading request={request('rm -rf build')} />, {
      explained: {},
      cwd: '/repo'
    })
    expect(html).toContain('data-level="irreversible"')
    expect(html).toContain('Hard to undo')
    expect(html).toContain('Reading what this does…')
  })

  it('shows no level before the reading when the rules cannot tell', () => {
    const html = render(<PermissionReading request={request('npm test')} />, {
      explained: {},
      cwd: '/repo'
    })
    expect(html).toContain('Reading what this does…')
    expect(html).not.toContain('chat-permission-level')
    expect(html).not.toContain('Reads only')
  })

  it('never shows "reads only" for an unproven request, even when the model says so', () => {
    const html = render(
      <PermissionReading request={request('npm test')} />,
      explained({ level: 'reads', sentence: 'Runs the tests. Changes nothing.' })
    )
    expect(html).toContain('Not verified')
    expect(html).not.toContain('Reads only')
    expect(html).toContain('Runs the tests. Changes nothing.')
  })

  it('takes the level the model gives an unknown request', () => {
    const html = render(
      <PermissionReading request={request('npm test')} />,
      explained({ level: 'outside', sentence: 'Runs the tests, which call a server.' })
    )
    expect(html).toContain('data-level="outside"')
  })

  it('shows the sentence once read, and the mismatch with the ask', () => {
    const html = render(
      <PermissionReading request={request('ls')} />,
      explained({
        level: 'reads',
        sentence: 'Lists the files of the project. Changes nothing.',
        asked: 'no'
      })
    )
    expect(html).toContain('Reads only')
    expect(html).toContain('Lists the files of the project. Changes nothing.')
    expect(html).toContain('Not what you asked for')
    expect(html).not.toContain('Reading what this does')
  })

  it('never shows a level below the rules, whatever the reading says', () => {
    const html = render(
      <PermissionReading request={request('git push --force')} />,
      explained({ level: 'reads', sentence: 'Harmless.' })
    )
    expect(html).toContain('data-level="irreversible"')
  })

  it('says in one quiet line when the reading failed, beside what the rules have', () => {
    const known = render(
      <PermissionReading request={request('ls')} />,
      explained({ level: 'reads', failed: 'auth' })
    )
    expect(known).toContain('Reads only')
    expect(known).toContain('Could not read what this does')
    expect(known).not.toContain('Reading what this does')
    const unknown = render(
      <PermissionReading request={request('make')} />,
      explained({ failed: 'timeout' })
    )
    expect(unknown).toContain('Not verified')
    expect(unknown).toContain('Could not read what this does')
  })

  it('reads nothing for an elicitation: no reading state, the rules alone', () => {
    const html = render(
      <PermissionReading
        request={{ ...request('x'), toolName: 'mcpServer/elicitation/request', input: {} }}
      />,
      { explained: {}, cwd: '/repo' }
    )
    expect(html).not.toContain('Reading what this does')
    expect(html).not.toContain('Could not read')
  })

  it('marks the upper levels with an icon, and paints nothing green', () => {
    const html = render(<PermissionReading request={request('rm -rf build')} />, {
      explained: {},
      cwd: '/repo'
    })
    expect(html).toMatch(/data-level="irreversible"[^>]*><svg/)
    const css = readFileSync(
      join(__dirname, '../../../../plugins/chat-view/src/permission-reading.css'),
      'utf8'
    )
    expect(css).not.toMatch(/success|green/i)
  })

  it('shows the level in the transcript record too', () => {
    expect(render(<PermissionLevelTag request={request('npm install')} />, null)).toContain(
      'Reaches outside the project'
    )
    expect(render(<PermissionLevelTag request={request('make')} />, null)).toContain('Not verified')
  })
})

describe('the transcript row', () => {
  const entry = (req: Permission): Parameters<typeof PermissionRow>[0]['entry'] => ({
    kind: 'permission',
    request: req,
    answer: 'allow-once',
    at: 1
  })
  it('keeps the level on a permission row, and none on a question row', () => {
    const permission = render(<PermissionRow entry={entry(request('rm -rf build'))} />, {
      explained: {}
    })
    expect(permission).toContain('Hard to undo')
    const question = render(
      <PermissionRow
        entry={entry({
          ...request('x'),
          toolName: 'AskUserQuestion',
          questions: [{ question: 'Which?', options: [{ label: 'A' }] }]
        })}
      />,
      { explained: {} }
    )
    expect(question).not.toContain('chat-permission-level')
  })
})

describe('the way back to skipping permissions', () => {
  it('is offered only when the view gives one', () => {
    expect(render(<BackToBypass />, { explained: {} })).toBe('')
    expect(render(<BackToBypass />, { explained: {}, backToBypass: () => {} })).toContain(
      'Back to skipping permissions'
    )
  })
})

describe('the mode line', () => {
  it('says the change and who asked', () => {
    expect(
      renderToStaticMarkup(<ModeLine label="Manual" fromLabel="Bypass permissions" />)
    ).toMatch(/Switched permissions from Bypass permissions to <strong>Manual<\/strong>/)
    expect(renderToStaticMarkup(<ModeLine label="Manual" fromLabel="Plan" by="you" />)).toMatch(
      /^<div[^>]*>You switched/
    )
  })
})
