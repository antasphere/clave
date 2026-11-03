import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Collector, projectSlug } from './collector'
import type { PluginSession } from './host'
import { emptyLedger } from './ledger'

const FIXTURES = join(__dirname, 'fixtures')
const fixture = readFileSync(join(FIXTURES, 'session.jsonl'), 'utf8')

let root: string
let clock: number
const now = (): Date => new Date(clock)

function claudeSession(over: Partial<PluginSession> = {}): PluginSession {
  return {
    id: 'tab-1',
    cwd: '/work/example.app',
    folderName: 'example.app',
    alive: true,
    provider: 'claude',
    providerSessionId: 'conv-1',
    name: 'Dark mode',
    model: 'opus',
    state: 'working',
    group: { id: 'g1', name: 'Theme' },
    workspaceId: 'ws-1',
    createdAt: 1,
    ...over
  }
}

function projectDir(cwd = '/work/example.app'): string {
  return join(root, projectSlug(cwd))
}

function collector(): Collector {
  return new Collector({ transcriptRoot: root, ledger: emptyLedger(15), gapMinutes: 15, now })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'analytics-collector-'))
  clock = Date.UTC(2026, 9, 1, 12, 0)
  mkdirSync(projectDir(), { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('Collector', () => {
  it('names the project folder the way Claude Code does', () => {
    expect(projectSlug('/work/example.app')).toBe('-work-example-app')
    expect(projectSlug('/a b/c_d')).toBe('-a-b-c-d')
  })

  it('creates the row of a Claude session and reads its transcript', () => {
    writeFileSync(join(projectDir(), 'conv-1.jsonl'), fixture)
    const c = collector()
    const changed: Set<string>[] = []
    c.on('changed', (ids: Set<string>) => changed.push(ids))
    c.setSessions([claudeSession()])
    const row = c.ledger.sessions['tab-1']!
    expect(row.name).toBe('Dark mode')
    expect(row.root?.tally.messages).toBe(3)
    expect(row.root?.tally.toolCalls).toBe(5)
    expect(row.root?.file.offset).toBe(Buffer.byteLength(fixture))
    expect(changed).toHaveLength(1)
    expect([...changed[0]!]).toEqual(['tab-1'])
  })

  it('a session of another provider gets a row and no reader', () => {
    const c = collector()
    c.setSessions([claudeSession({ id: 'tab-2', provider: 'codex', providerSessionId: 'x' })])
    expect(c.ledger.sessions['tab-2']?.root).toBeNull()
  })

  it('grows with appended lines to the totals a fresh collector reads from the whole file', () => {
    const lines = fixture.split('\n')
    const file = join(projectDir(), 'conv-1.jsonl')
    writeFileSync(file, lines.slice(0, 6).join('\n') + '\n')
    const c = collector()
    c.setSessions([claudeSession()])
    expect(c.ledger.sessions['tab-1']!.root!.tally.messages).toBe(1)
    appendFileSync(file, lines.slice(6).join('\n'))
    const touched = c.tick()
    expect([...touched]).toEqual(['tab-1'])
    expect(c.tick().size).toBe(0)

    const fresh = collector()
    fresh.setSessions([claudeSession()])
    const grown = c.ledger.sessions['tab-1']!.root!.tally
    const whole = fresh.ledger.sessions['tab-1']!.root!.tally
    expect(grown.tokens).toEqual(whole.tokens)
    expect(grown.messages).toBe(whole.messages)
    expect(grown.toolCalls).toBe(whole.toolCalls)
    expect(grown.prompts).toBe(whole.prompts)
    expect(grown.days).toEqual(whole.days)
  })

  it('lands a subagent file with its meta as a subagent row', () => {
    writeFileSync(join(projectDir(), 'conv-1.jsonl'), fixture)
    const subagents = join(projectDir(), 'conv-1', 'subagents')
    mkdirSync(subagents, { recursive: true })
    copyFileSync(join(FIXTURES, 'agent.jsonl'), join(subagents, 'agent-abc123.jsonl'))
    copyFileSync(join(FIXTURES, 'agent.meta.json'), join(subagents, 'agent-abc123.meta.json'))
    const c = collector()
    c.setSessions([claudeSession()])
    const subs = c.ledger.sessions['tab-1']!.subagents
    expect(subs).toHaveLength(1)
    expect(subs[0]).toMatchObject({
      id: 'abc123',
      type: 'Explore',
      description: 'Find the theme colour reads',
      model: 'opus',
      finished: true
    })
    expect(subs[0]!.tally.messages).toBe(2)
    expect(subs[0]!.tally.toolCalls).toBe(1)
    expect(subs[0]!.tally.prompts).toBe(0)
  })

  it('appends a span when the state changes', () => {
    const c = collector()
    c.setSessions([claudeSession({ state: 'working' })])
    clock += 60_000
    c.setSessions([claudeSession({ state: 'idle' })])
    const spans = c.ledger.sessions['tab-1']!.stateSpans
    expect(spans).toEqual([
      { state: 'working', from: '2026-10-01T12:00:00.000Z', to: '2026-10-01T12:01:00.000Z' },
      { state: 'idle', from: '2026-10-01T12:01:00.000Z', to: null }
    ])
  })

  it('keeps a session that disappeared, ended', () => {
    writeFileSync(join(projectDir(), 'conv-1.jsonl'), fixture)
    const c = collector()
    c.setSessions([claudeSession()])
    clock += 60_000
    const touched = c.setSessions([])
    const row = c.ledger.sessions['tab-1']!
    expect([...touched]).toEqual(['tab-1'])
    expect(row.state).toBe('ended')
    expect(row.root?.tally.messages).toBe(3)
    expect(row.stateSpans.at(-1)?.to).toBe('2026-10-01T12:01:00.000Z')
  })

  it('starts and stops without leaving a watcher or a timer behind', () => {
    const c = collector()
    c.setSessions([claudeSession()])
    c.start()
    c.stop()
    expect(c.listenerCount('changed')).toBe(0)
  })
})
