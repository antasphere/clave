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
import { PermissionRow, PromptDock } from '../../../../plugins/chat-view/src/PromptDock'
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
/** A command the rules neither prove nor rate (a script the structure does
 *  not settle): its level is unknown. */
const UNKNOWN = 'npm test'
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
    const html = render(<PermissionReading request={request(UNKNOWN)} />, {
      explained: {},
      cwd: '/repo'
    })
    expect(html).toContain('Reading what this does…')
    expect(html).not.toContain('chat-permission-level')
    expect(html).not.toContain('Reads only')
  })

  it('never shows "reads only" for an unproven request, even when the model says so', () => {
    const html = render(
      <PermissionReading request={request(UNKNOWN)} />,
      explained({ level: 'reads', sentence: 'Runs the tests. Changes nothing.' })
    )
    expect(html).toContain('Clave could not check this')
    expect(html).not.toContain('Reads only')
    expect(html).toContain('Runs the tests. Changes nothing.')
  })

  it('says in words that Clave could not check it when the model is all there is', () => {
    const html = render(
      <PermissionReading request={request(UNKNOWN)} />,
      explained({ sentence: 'Lists a folder of the project. Changes nothing.' })
    )
    expect(html).toContain(
      'Clave could not check this. A model&#x27;s reading: Lists a folder of the project. Changes nothing.'
    )
    expect(html).toContain('data-verified="false"')
    // One line, no pill beside the sentence.
    expect(html).not.toContain('chat-permission-level')
    // A level the rules found keeps the plain sentence.
    const known = render(
      <PermissionReading request={request('ls')} />,
      explained({ level: 'reads', sentence: 'Lists the files of the project.' })
    )
    expect(known).not.toContain('could not check')
  })

  it('notes "May show secrets" beside the level, and beside the "could not check" line', () => {
    const proven = render(<PermissionReading request={request('grep -r KEY .')} />, {
      explained: {},
      cwd: '/repo'
    })
    expect(proven).toContain('Reads only')
    expect(proven).toContain('May show secrets')
    const unverified = render(
      <PermissionReading request={request('node scripts/show.js .env')} />,
      explained({ sentence: 'Counts the lines of a settings file.' })
    )
    expect(unverified).toContain('Clave could not check this')
    expect(unverified).toContain('May show secrets')
    const plain = render(<PermissionReading request={request('ls')} />, {
      explained: {},
      cwd: '/repo'
    })
    expect(plain).not.toContain('May show secrets')
  })

  it('marks "May show secrets" with an icon in the neutral ink', () => {
    const html = render(<PermissionReading request={request('grep -r KEY .')} />, {
      explained: {},
      cwd: '/repo'
    })
    expect(html).toMatch(
      /<span class="chat-permission-secrets"><svg[^>]*>[\s\S]*<\/svg>May show secrets<\/span>/
    )
    const css = readFileSync(
      join(__dirname, '../../../../plugins/chat-view/src/permission-reading.css'),
      'utf8'
    )
    expect(css).toMatch(/\.chat-permission-secrets \{[^}]*color: var\(--text-secondary\)/)
  })

  it.each([
    "echo 'rm -rf ~' > cleanup.sh && bash cleanup.sh",
    'python3 wipe.py > log.txt',
    'node reset-prod.js | tee out.log',
    'mkdir tmp && ./deploy.sh',
    'touch x && make nuke',
    "printf 'rm -rf src\\n' > x.sh && sh x.sh"
  ])(
    'read only in part, %s: no level and one line with the helper off, the floor once read',
    (command) => {
      // Helper off: no reading ever comes; the card gave up waiting.
      const off = render(<PermissionReading request={request(command)} />, null)
      expect(off).not.toContain('chat-permission-level')
      expect(off).toContain('Clave could check only part of this.')
      expect(off).not.toContain('Changes files of the project')
      const failed = render(
        <PermissionReading request={request(command)} />,
        explained({ failed: 'timeout' })
      )
      expect(failed).not.toContain('chat-permission-level')
      expect(failed).toContain('Clave could check only part of this.')
      // The model says it only reads: the floor, and the same words before the sentence.
      const read = render(
        <PermissionReading request={request(command)} />,
        explained({ level: 'reads', sentence: 'Writes a log file.' })
      )
      expect(read).toContain('data-level="project"')
      expect(read).toContain(
        'Clave could check only part of this. A model&#x27;s reading: Writes a log file.'
      )
      // The model raises it.
      expect(
        render(
          <PermissionReading request={request(command)} />,
          explained({ level: 'irreversible', sentence: 'Deletes the home folder.' })
        )
      ).toContain('data-level="irreversible"')
    }
  )

  it('takes the level the model gives an unknown request', () => {
    const html = render(
      <PermissionReading request={request(UNKNOWN)} />,
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
      <PermissionReading request={request(UNKNOWN)} />,
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
    expect(render(<PermissionLevelTag request={request(UNKNOWN)} />, null)).toContain(
      'Not verified'
    )
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

  it('stands on one line: the pill on its words, the glyph on the first line (PRDCT-4483)', () => {
    const sheet = readFileSync(
      join(__dirname, '../../../../plugins/chat-view/src/permission-reading.css'),
      'utf8'
    )
    // The icon is the pill's first child: aligned on centres, its lower edge
    // was the pill's baseline, and the pill rose off the words beside it.
    expect(sheet).toMatch(/\.chat-permission-level \{[^}]*align-items: baseline/)
    expect(sheet).toMatch(/\.chat-permission-secrets \{[^}]*align-items: baseline/)
    expect(sheet).toMatch(
      /\.chat-permission-level svg,\s*\.chat-permission-secrets svg \{[^}]*align-self: center/
    )
    const system = readFileSync(join(__dirname, '../../../../packages/ui/src/system.css'), 'utf8')
    expect(system).toMatch(
      /\.chat-permission-row > \.chat-tool-status \{\s*margin-block: calc\(\(1lh - var\(--chat-glyph\)\) \/ 2\);/
    )
  })
})

describe('the card in the dock (PRDCT-4483)', () => {
  const asked = (id: string): Permission => ({
    ...request('npm install'),
    id,
    options: [
      { id: 'allow-once', label: 'Allow once' },
      { id: 'allow-always', label: 'Always allow' },
      { id: 'deny', label: 'Deny' }
    ]
  })
  const dock = (requests: Permission[]): string =>
    render(
      <PromptDock requests={requests} agent="Claude" busy={() => false} onAnswer={() => {}} />,
      { explained: {} }
    )
  it('answers with words alone, its keys in the tooltip and for assistive technology', () => {
    const html = dock([asked('a')])
    expect(html).not.toContain('<kbd')
    const buttons = [
      ...html.matchAll(/<button[^>]*class="chat-prompt-btn chat-ask-btn"[^>]*>([^<]*)<\/button>/g)
    ]
    expect(buttons.map((m) => m[1])).toEqual(['Deny', 'Always allow', 'Allow once'])
    expect(buttons.map((m) => /title="([^"]*)"/.exec(m[0])?.[1])).toEqual([
      'Deny (Esc)',
      'Always allow (2)',
      'Allow once (⌘ Enter)'
    ])
    expect(buttons.map((m) => /aria-keyshortcuts="([^"]*)"/.exec(m[0])?.[1])).toEqual([
      'Escape 1',
      '2',
      'Meta+Enter 3'
    ])
  })
  it('says the queue level with the question, and nothing when one request waits', () => {
    expect(dock([asked('a'), asked('b')])).toMatch(
      /<div class="chat-prompt-head"><div class="chat-prompt-title">[^<]*<\/div><span class="chat-prompt-queue">1 of 2 waiting<\/span><\/div>/
    )
    expect(dock([asked('a')])).not.toContain('chat-prompt-queue')
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

  it('says the tab skipped permissions before, true for a resumed tab too', () => {
    const html = render(<BackToBypass />, { explained: {}, backToBypass: () => {} })
    expect(html).toContain(
      'title="This tab skipped permissions before; switch back to skipping them"'
    )
    expect(html).not.toMatch(/started/)
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
