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
  launchedSkipping,
  offersWayBack,
  PermissionReadingProvider,
  usePermissionReading,
  type PermissionReadingValue
} from '../../../../plugins/chat-view/src/permission-reading-context'
import { emptyConversation } from '../../../../plugins/chat-view/src/reducer'
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
  const MODES = [
    { id: 'default', label: 'Manual' },
    { id: 'bypassPermissions', label: 'Bypass permissions' }
  ]
  it('is for a tab LAUNCHED skipping permissions, by its own flag or its first mode', () => {
    expect(launchedSkipping(true, 'default')).toBe(true)
    expect(launchedSkipping(undefined, 'bypassPermissions')).toBe(true)
    expect(launchedSkipping(false, 'default')).toBe(false)
    expect(launchedSkipping(undefined, undefined)).toBe(false)
  })
  it('is offered out of the mode, when the provider still offers it, and only then', () => {
    expect(offersWayBack(true, { mode: 'default', modes: MODES })).toBe(true)
    expect(offersWayBack(true, { mode: 'bypassPermissions', modes: MODES })).toBe(false)
    expect(offersWayBack(true, { mode: 'default', modes: MODES.slice(0, 1) })).toBe(false)
    // A Manual tab whose profile only allows the switch was never launched in it.
    expect(offersWayBack(false, { mode: 'default', modes: MODES })).toBe(false)
    expect(offersWayBack(true, null)).toBe(false)
  })
  it('sends the switch to skipping permissions, and tells the reducer who asked', () => {
    const write = vi.fn(async () => {})
    const dispatch = vi.fn()
    const seen: PermissionReadingValue[] = []
    function Probe(): null {
      const value = usePermissionReading({
        sessionId: 's',
        cwd: '/repo',
        conversation: {
          ...emptyConversation,
          launchedMode: 'bypassPermissions',
          permissionMode: { mode: 'default', modes: MODES }
        },
        dispatch,
        write,
        report: () => {},
        remotePending: undefined
      }).reading
      seen.push(value)
      return null
    }
    renderToStaticMarkup(<Probe />)
    expect(seen[0].backToBypass).toBeTypeOf('function')
    seen[0].backToBypass!()
    expect(write).toHaveBeenCalledWith({ type: 'set_permission_mode', mode: 'bypassPermissions' })
    expect(dispatch).toHaveBeenCalledWith({ askMode: 'bypassPermissions' })
  })
  it("maps a server session's request key to the reading of its provider id", () => {
    const seen: PermissionReadingValue[] = []
    function Probe(): null {
      const value = usePermissionReading({
        sessionId: 's',
        cwd: '/repo',
        conversation: {
          ...emptyConversation,
          explained: { '"7"': { type: 'permission_explained', id: '"7"', sentence: 'x' } }
        },
        dispatch: () => {},
        write: async () => {},
        report: () => {},
        remotePending: [{ id: 'clave-owner:request:k', sessionId: 's', providerRequestId: '"7"' }]
      }).reading
      seen.push(value)
      return null
    }
    renderToStaticMarkup(<Probe />)
    expect(seen[0].explained['clave-owner:request:k']).toMatchObject({ sentence: 'x' })
    expect(seen[0].backToBypass).toBeUndefined()
  })

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
