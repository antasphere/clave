/**
 * The codex store reader (PRDCT-1766): rollout files are found under the
 * dated tree, the head's `session_meta` names the thread, subagent threads
 * fold away, the first human message titles the row (gutter bars stripped,
 * injected context skipped), and the cache re-reads only what moved.
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CodexCache, listCodexFiles, listCodexSessions, scanCodexHead } from './codex'

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'clave-codex-test-'))
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

const META = {
  timestamp: '2026-07-27T14:06:40.946Z',
  type: 'session_meta',
  payload: {
    id: '019fa3e6-3513-7b50-ad3b-c749fe7e21fc',
    timestamp: '2026-07-27T14:06:40.916Z',
    cwd: '/Users/someone/project',
    originator: 'codex-tui',
    thread_source: 'user'
  }
}
const USER = {
  timestamp: '2026-07-27T14:07:00.000Z',
  type: 'response_item',
  payload: {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: '▎ Fix the login flow\n▎ and add tests' }]
  }
}
const ENV = {
  type: 'response_item',
  payload: {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: '<environment_context>…</environment_context>' }]
  }
}

function lines(...entries: unknown[]): string {
  return entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
}

describe('scanCodexHead', () => {
  it('reads the meta and titles by the first human message, gutter stripped', () => {
    const scan = scanCodexHead(lines(META, ENV, USER), 'fallback')
    expect(scan).toEqual({
      id: '019fa3e6-3513-7b50-ad3b-c749fe7e21fc',
      cwd: '/Users/someone/project',
      firstAt: '2026-07-27T14:06:40.916Z',
      firstUserText: 'Fix the login flow\nand add tests'
    })
  })
  it('a subagent thread is nobody: null, whatever else the head holds', () => {
    const meta = { ...META, payload: { ...META.payload, thread_source: 'subagent' } }
    expect(scanCodexHead(lines(meta, USER), 'fb')).toBeNull()
    const bySource = {
      ...META,
      payload: { ...META.payload, thread_source: undefined, source: { subagent: {} } }
    }
    expect(scanCodexHead(lines(bySource, USER), 'fb')).toBeNull()
  })
  it('no meta record at all = null; a missing id falls back to the filename stem', () => {
    expect(scanCodexHead(lines(USER), 'fb')).toBeNull()
    const noId = { ...META, payload: { ...META.payload, id: undefined } }
    expect(scanCodexHead(lines(noId), 'fb')?.id).toBe('fb')
  })
  it('a head with only injected context has no title material', () => {
    expect(scanCodexHead(lines(META, ENV), 'fb')?.firstUserText).toBeNull()
  })
})

describe('listCodexFiles / listCodexSessions', () => {
  it('finds rollout files under the dated tree; a missing root is empty', () => {
    const day = join(tmp, '2026', '07', '27')
    mkdirSync(day, { recursive: true })
    writeFileSync(join(day, 'rollout-2026-07-27T16-06-40-abc.jsonl'), lines(META, USER))
    writeFileSync(join(day, 'not-a-rollout.jsonl'), lines(META))
    writeFileSync(join(day, 'rollout-but-not-jsonl.txt'), 'x')
    expect(listCodexFiles(tmp).map((f) => f.split('/').pop())).toEqual([
      'rollout-2026-07-27T16-06-40-abc.jsonl'
    ])
    expect(listCodexFiles(join(tmp, 'absent'))).toEqual([])
  })
  it('lists user threads with stats, and folds subagent threads away', () => {
    const day = join(tmp, '2026', '07', '27')
    mkdirSync(day, { recursive: true })
    writeFileSync(join(day, 'rollout-a.jsonl'), lines(META, USER))
    const sub = { ...META, payload: { ...META.payload, thread_source: 'subagent' } }
    writeFileSync(join(day, 'rollout-b.jsonl'), lines(sub, USER))
    const sessions = listCodexSessions(tmp, new CodexCache())
    expect(sessions).toHaveLength(1)
    expect(sessions[0].id).toBe(META.payload.id)
    expect(sessions[0].cwd).toBe('/Users/someone/project')
    expect(sessions[0].firstUserText).toContain('Fix the login flow')
    expect(sessions[0].sizeBytes).toBeGreaterThan(0)
    expect(sessions[0].modifiedAt).toBeTruthy()
  })
  it('the cache re-reads only what moved', () => {
    const day = join(tmp, '2026', '07', '27')
    mkdirSync(day, { recursive: true })
    const file = join(day, 'rollout-a.jsonl')
    writeFileSync(file, lines(META, USER))
    const cache = new CodexCache()
    const first = cache.get(file)
    expect(cache.get(file)).toBe(first)
    const altered = {
      ...META,
      payload: { ...META.payload, cwd: '/Users/someone/elsewhere' }
    }
    writeFileSync(file, lines(altered, USER))
    utimesSync(file, new Date(), new Date(Date.now() + 5000))
    expect(cache.get(file)?.cwd).toBe('/Users/someone/elsewhere')
  })
})

/**
 * A Codex terminal's thread (ADR 0002): the earliest conversation the store
 * holds for the session's cwd from its start on. The one the restart on
 * another account resumes, so a wrong pick is a wrong conversation brought
 * back under the tab's name.
 */
describe('findCodexThreadForSession', () => {
  const rollout = (name: string, id: string, at: string, cwd = '/Users/someone/project'): void => {
    const dir = join(tmp, '2026', '07', '27')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, `rollout-${name}-${id}.jsonl`),
      lines({ ...META, payload: { ...META.payload, id, timestamp: at, cwd } })
    )
  }
  it('picks the first thread started in the cwd since the session started', async () => {
    const { findCodexThreadForSession } = await import('./codex')
    rollout('a', 'earlier-thread', '2026-07-27T14:00:00.000Z')
    rollout('b', 'ours', '2026-07-27T14:06:41.000Z')
    rollout('c', 'later', '2026-07-27T14:30:00.000Z')
    rollout('d', 'elsewhere', '2026-07-27T14:06:41.000Z', '/Users/someone/other')
    const startedAt = Date.parse('2026-07-27T14:06:40.000Z')
    expect(findCodexThreadForSession('/Users/someone/project', startedAt, tmp)).toBe('ours')
    // A start a moment after the rollout's own stamp still finds it (clock drift).
    expect(findCodexThreadForSession('/Users/someone/project', startedAt + 4_000, tmp)).toBe('ours')
    // Nothing since the start, or nothing in that cwd, is nothing to resume.
    expect(
      findCodexThreadForSession('/Users/someone/project', startedAt + 3_600_000, tmp)
    ).toBeNull()
    expect(findCodexThreadForSession('/nowhere', startedAt, tmp)).toBeNull()
  })
})
