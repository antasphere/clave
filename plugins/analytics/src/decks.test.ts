import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { foldEvents, parseLine } from './claude'
import {
  AGENT_FILE,
  DATA_FILE,
  DeckWriter,
  INDEX_FILE,
  assembleDeck,
  deckFolder,
  deckTitle,
  fileKey,
  rootIndex
} from './decks'
import {
  emptyLedger,
  emptyTally,
  groupView,
  sessionView,
  workspaceView,
  type Ledger,
  type ScopeView,
  type SessionRow,
  type Tally
} from './ledger'
import { loadPrices } from './prices'
import { newCursor } from './reader'
import type { Range, Scope } from './scope'

const fixture = readFileSync(join(__dirname, 'fixtures', 'session.jsonl'), 'utf8')
const template = readFileSync(join(__dirname, '..', 'page', 'index.html'), 'utf8')
const prices = loadPrices(join(__dirname, '..', 'prices.json'), null)
const NOW = new Date('2026-11-04T15:00:00.000Z')
const BASE = 'http://127.0.0.1:4242/0123456789abcdef0123456789abcdef/'
const EVENTS = `${BASE}events?scope=group%3Ag1&range=all`
const NOTE = 'Served by the Slideless viewer on this Mac'

const CSS = [
  ':root { --ink: #111; }',
  '/* a comment that names </style> once */',
  '.deck { color: var(--ink); }'
].join('\n')
const JS = 'const closing = "</script>"\nconsole.log(closing, "$& and $\' stay text")'

function tally(): Tally {
  return foldEvents(fixture.split('\n').map(parseLine), emptyTally())
}

function session(id: string, name: string, createdAt: number): SessionRow {
  return {
    id,
    provider: 'claude',
    providerSessionId: `conv-${id}`,
    cwd: '/work/folder',
    name,
    model: null,
    state: 'idle',
    group: { id: 'g1', name: 'Theme work' },
    workspaceId: 'ws-1',
    createdAt,
    seenAt: '2026-11-04T10:00:00.000Z',
    root: { tally: tally(), file: { ...newCursor(`/x/${id}.jsonl`), offset: 10 } },
    subagents: [],
    stateSpans: []
  }
}

function ledger(): Ledger {
  const l = emptyLedger(15, NOW)
  l.sessions['sa'] = session('sa', 'Session a', 2)
  l.sessions['sb'] = session('sb', 'Session b', 1)
  return l
}

function dataBlock(html: string): ScopeView {
  const m = /<script type="application\/json" id="slideless-data">([\s\S]*?)<\/script>/.exec(html)
  expect(m).not.toBeNull()
  return JSON.parse(m![1]!) as ScopeView
}

function count(text: string, part: string): number {
  return text.split(part).length - 1
}

describe('the deck names', () => {
  it('names the folders and files after the scope key, a long one cut and hashed', () => {
    expect(fileKey('session:tab 1')).toBe('session-tab-1')
    expect(fileKey('workspace:-')).toBe('workspace--')
    expect(fileKey('group:a/b\\c:d')).toBe('group-a-b-c-d')
    const long = `session:${'x'.repeat(200)}`
    const key = fileKey(long)
    expect(key.length).toBe(89)
    expect(key.startsWith('session-xxxx')).toBe(true)
    expect(key).toMatch(/-[0-9a-f]{8}$/)
    expect(fileKey(long)).toBe(key)
    expect(fileKey(`${long}y`)).not.toBe(key)
  })

  it('gives a session one folder and a group or the workspace one per range', () => {
    expect(deckFolder({ kind: 'session', id: 'tab 1' }, 'all')).toBe('session-tab-1')
    expect(deckFolder({ kind: 'session', id: 'tab 1' }, '7d')).toBe('session-tab-1')
    expect(deckFolder({ kind: 'group', id: 'g1' }, '7d')).toBe('group-g1-7d')
    expect(deckFolder({ kind: 'workspace', ws: null }, 'today')).toBe('workspace---today')
    expect(deckFolder({ kind: 'workspace', ws: 'ws-1' }, 'all')).toBe('workspace-ws-1-all')
  })

  it('titles a deck after the page, then the plugin, a long name cut', () => {
    expect(deckTitle(groupView(ledger(), 'g1', prices, 'all', NOW))).toBe('Theme work · Analytics')
    const view = sessionView(ledger(), 'sa', prices)!
    expect(deckTitle({ ...view, name: '  ' })).toBe('Analytics · Analytics')
    expect(deckTitle({ ...view, name: 'n'.repeat(120) })).toBe(`${'n'.repeat(99)}… · Analytics`)
  })
})

describe('assembleDeck', () => {
  const input = (): Parameters<typeof assembleDeck>[0] => ({
    template,
    css: CSS,
    js: JS,
    data: groupView(ledger(), 'g1', prices, 'all', NOW),
    title: 'Theme work · Analytics',
    base: BASE,
    events: EVENTS,
    note: NOTE
  })

  it('inlines the stylesheet and the script, sets the deck mode, the base, the stream and the note', () => {
    const view = groupView(ledger(), 'g1', prices, 'all', NOW)
    const html = assembleDeck({ ...input(), data: view })
    expect(html).not.toContain('<link rel="stylesheet"')
    expect(html).not.toContain('<script src=')
    expect(html).toContain('<style>\n:root { --ink: #111; }')
    expect(html).toContain('.deck { color: var(--ink); }')
    expect(html).toContain('<meta name="analytics-mode" content="deck" />')
    expect(html).toContain(
      `<meta name="analytics-events" content="${EVENTS.replace(/&/g, '&amp;')}" />`
    )
    expect(html).toContain(`<meta name="analytics-base" content="${BASE}" />`)
    expect(html).toContain(`<meta name="analytics-note" content="${NOTE}" />`)
    expect(html).toContain('<title>Theme work · Analytics</title>')
    expect(html).toContain('<html lang="en" data-theme="dark">')
    expect(dataBlock(html)).toEqual(view)
    // The built code's closers are escaped, its dollar signs kept as text.
    expect(count(html, '</script>')).toBe(2)
    expect(html).toContain('"<\\/script>"')
    expect(html).toContain('"$& and $\' stay text"')
    expect(count(html, '</style>')).toBe(1)
    expect(html).toContain('<\\/style')
  })

  it('refuses a template whose stylesheet link moved', () => {
    const changed = template.replace('<link rel="stylesheet" href="{{base}}assets/deck.css" />', '')
    expect(changed).not.toBe(template)
    expect(() => assembleDeck({ ...input(), template: changed })).toThrow(/template changed/)
  })

  it('writes a root page naming what the folders are', () => {
    expect(rootIndex()).toContain('<title>Clave · Analytics decks</title>')
    expect(rootIndex()).toContain('one folder per page it opened')
  })
})

describe('DeckWriter', () => {
  let dir: string
  let pageDir: string
  let agentFile: string
  let current: Ledger
  const view = (scope: Scope, range: Range): ScopeView | null => {
    if (scope.kind === 'session') return sessionView(current, scope.id, prices)
    if (scope.kind === 'group') return groupView(current, scope.id, prices, range, NOW)
    return workspaceView(current, scope.ws, prices, range, NOW)
  }
  const writer = (log?: (level: 'warn', message: string) => void): DeckWriter =>
    new DeckWriter({ dir, pageDir, agentFile, view, base: BASE, note: NOTE, log })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'analytics-decks-'))
    pageDir = join(dir, 'dist')
    mkdirSync(pageDir)
    writeFileSync(join(pageDir, 'index.html'), template)
    writeFileSync(join(pageDir, 'deck.css'), CSS)
    writeFileSync(join(pageDir, 'deck.js'), JS)
    agentFile = join(dir, 'AGENT.md')
    writeFileSync(agentFile, '# An Analytics deck\n')
    current = ledger()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('writes the root page once and keeps an edited one', () => {
    const w = writer()
    expect(w.root).toBe(join(dir, 'decks'))
    w.ensureRoot()
    const index = join(w.root, INDEX_FILE)
    expect(readFileSync(index, 'utf8')).toBe(rootIndex())
    writeFileSync(index, 'mine')
    w.ensureRoot()
    expect(readFileSync(index, 'utf8')).toBe('mine')
  })

  it('writes a deck folder with its three files when a page is opened, and keeps the scope', () => {
    const w = writer()
    const deck = w.write({ kind: 'group', id: 'g1' }, '7d')
    expect(deck).toEqual({
      name: 'group-g1-7d',
      folder: join(dir, 'decks', 'group-g1-7d'),
      title: 'Theme work · Analytics'
    })
    expect(readdirSync(deck!.folder).sort()).toEqual([AGENT_FILE, DATA_FILE, INDEX_FILE].sort())
    expect(readFileSync(join(deck!.folder, AGENT_FILE), 'utf8')).toBe('# An Analytics deck\n')
    const data = JSON.parse(readFileSync(join(deck!.folder, DATA_FILE), 'utf8')) as ScopeView
    expect(data).toMatchObject({ kind: 'group', id: 'g1', range: '7d' })
    const html = readFileSync(join(deck!.folder, INDEX_FILE), 'utf8')
    expect(dataBlock(html)).toEqual(data)
    expect(html).toContain(`<meta name="analytics-base" content="${BASE}" />`)
    expect(html).toContain(
      `<meta name="analytics-events" content="${BASE}events?scope=group%3Ag1&amp;range=7d" />`
    )
    expect(w.openedFolders).toEqual(['group-g1-7d'])
    // A session has one folder; the workspace one per range; nothing is measured for `nope`.
    expect(w.write({ kind: 'session', id: 'sa' }, 'all')!.name).toBe('session-sa')
    expect(w.write({ kind: 'workspace', ws: 'ws-1' }, 'today')!.name).toBe('workspace-ws-1-today')
    expect(w.write({ kind: 'session', id: 'nope' }, 'all')).toBeNull()
    expect(existsSync(join(dir, 'decks', 'session-nope'))).toBe(false)
    expect(w.openedFolders).toEqual(['group-g1-7d', 'session-sa', 'workspace-ws-1-today'])
  })

  it('rewrites the opened decks whose view changed, and only those', () => {
    const w = writer()
    w.write({ kind: 'group', id: 'g1' }, 'all')
    w.write({ kind: 'session', id: 'sb' }, 'all')
    expect(w.rewrite()).toEqual([])
    // Session a's name changes: the group's deck changes, session b's does not.
    current.sessions['sa']!.name = 'Session a, renamed'
    expect(w.rewrite()).toEqual(['group-g1-all'])
    const group = JSON.parse(
      readFileSync(join(dir, 'decks', 'group-g1-all', DATA_FILE), 'utf8')
    ) as ScopeView
    expect(group.rows.map((r) => r.name)).toContain('Session a, renamed')
    expect(w.rewrite()).toEqual([])
    // A scope nothing is measured for any more is skipped, its folder left as it was.
    delete current.sessions['sb']
    expect(w.rewrite()).toEqual(['group-g1-all'])
    expect(existsSync(join(dir, 'decks', 'session-sb', INDEX_FILE))).toBe(true)
  })

  it('says a deck it cannot draw once per rewrite and goes on with the others', () => {
    const warnings: string[] = []
    const w = new DeckWriter({
      dir,
      pageDir,
      agentFile,
      base: BASE,
      note: NOTE,
      log: (_level, message) => warnings.push(message),
      view: (scope, range) => {
        if (
          scope.kind === 'session' &&
          scope.id === 'sa' &&
          current.sessions['sa']!.name === 'boom'
        )
          throw new Error('a row the views cannot draw')
        return view(scope, range)
      }
    })
    w.write({ kind: 'session', id: 'sa' }, 'all')
    w.write({ kind: 'session', id: 'sb' }, 'all')
    current.sessions['sa']!.name = 'boom'
    current.sessions['sb']!.name = 'Session b, renamed'
    expect(w.rewrite()).toEqual(['session-sb'])
    expect(warnings).toEqual([
      'The deck session-sa could not be drawn: a row the views cannot draw'
    ])
  })

  it('falls back to a one-line briefing when the shipped AGENT.md is missing', () => {
    rmSync(agentFile)
    const w = writer()
    const deck = w.write({ kind: 'session', id: 'sa' }, 'all')!
    expect(readFileSync(join(deck.folder, AGENT_FILE), 'utf8')).toBe(
      '# An Analytics deck written by Clave\n'
    )
  })
})
