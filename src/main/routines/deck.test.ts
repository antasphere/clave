import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DATA_BLOCK, checkTemplate, removeRoutineDecks, writeDeck, type DeckEnvelope } from './deck'
import { hashKey } from './claims'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'clave-deck-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const INDEX =
  '<!doctype html><html><head><script type="application/json" id="slideless-data">{}</script><link rel="stylesheet" href="deck.css"></head><body><div id="deck"></div></body></html>'

function template(root: string, name = 'workspace-health'): string {
  const folder = join(root, '.clave', 'routines', name)
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'index.html'), INDEX)
  writeFileSync(join(folder, 'deck.css'), '.deck { color: red }')
  writeFileSync(join(folder, 'AGENT.md'), '# A deck\n')
  return folder
}

const envelope: DeckEnvelope = {
  routine: {
    key: 'k',
    name: 'Workspace health',
    schedule: '30 8 * * 1-5',
    file: '/w/default.clave'
  },
  run: {
    id: 'run-1',
    trigger: 'scheduled',
    startedAt: 1,
    endedAt: 2,
    status: 'ok',
    headline: 'All clean',
    summary: 'Nothing to do </script><script>alert(1)</script>',
    reportedAt: 2,
    agent: 'claude',
    model: null,
    account: null
  },
  data: { checks: [] }
}

describe('checkTemplate', () => {
  it('accepts a folder inside the root with an index carrying the data block', () => {
    const root = join(dir, 'ws')
    const folder = template(root)
    expect(checkTemplate(folder, root)).toEqual({ ok: true, index: join(folder, 'index.html') })
  })

  it('refuses a template outside the root, a missing one, a file, and an index without the block', () => {
    const root = join(dir, 'ws')
    mkdirSync(root, { recursive: true })
    const outside = template(dir, 'elsewhere')
    expect(checkTemplate(outside, root)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('outside')
    })
    expect(checkTemplate(join(root, 'nope'), root)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('does not exist')
    })
    writeFileSync(join(root, 'file'), 'x')
    expect(checkTemplate(join(root, 'file'), root)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('not a folder')
    })
    const bare = join(root, 'bare')
    mkdirSync(bare)
    writeFileSync(join(bare, 'index.html'), '<html></html>')
    expect(checkTemplate(bare, root)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('slideless-data')
    })
    const empty = join(root, 'empty')
    mkdirSync(empty)
    expect(checkTemplate(empty, root)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('no index.html')
    })
  })
})

describe('writeDeck', () => {
  it('copies the template, fills the data block with the envelope, writes data.json and the root index', () => {
    const root = join(dir, 'ws')
    const tpl = template(root)
    const decksRoot = join(dir, 'decks')
    const written = writeDeck({
      decksRoot,
      routineKey: 'k',
      runId: 'run-1',
      template: tpl,
      envelope
    })
    expect(written.relative).toBe(`${hashKey('k')}/run-1/index.html`)
    const html = readFileSync(join(written.folder, 'index.html'), 'utf8')
    const block = DATA_BLOCK.exec(html)![0]
    expect(block).toContain('"headline": "All clean"')
    // A closing tag inside the data cannot close the block early.
    expect(block).not.toContain('</script><script>')
    expect(block.match(/<\/script>/g)).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(written.folder, 'data.json'), 'utf8'))).toEqual(envelope)
    expect(readFileSync(join(written.folder, 'deck.css'), 'utf8')).toBe('.deck { color: red }')
    expect(readFileSync(join(written.folder, 'AGENT.md'), 'utf8')).toBe('# A deck\n')
    expect(readFileSync(join(decksRoot, 'index.html'), 'utf8')).toContain(
      `./${hashKey('k')}/run-1/index.html`
    )
  })

  it('follows no symlink in the template and overwrites a run folder whole', () => {
    const root = join(dir, 'ws')
    const tpl = template(root)
    symlinkSync('/etc/hosts', join(tpl, 'hosts'))
    const decksRoot = join(dir, 'decks')
    const first = writeDeck({ decksRoot, routineKey: 'k', runId: 'run-1', template: tpl, envelope })
    expect(existsSync(join(first.folder, 'hosts'))).toBe(false)
    writeFileSync(join(first.folder, 'stale.txt'), 'old')
    writeDeck({ decksRoot, routineKey: 'k', runId: 'run-1', template: tpl, envelope })
    expect(existsSync(join(first.folder, 'stale.txt'))).toBe(false)
    removeRoutineDecks(decksRoot, 'k')
    expect(existsSync(first.folder)).toBe(false)
    expect(readFileSync(join(decksRoot, 'index.html'), 'utf8')).not.toContain('run-1')
  })
})
