/**
 * The proof: a conversation read from a Claude Code transcript, written as a
 * Codex thread, resumed through the REAL `codex app-server` on a Codex home of
 * its own under the system temp dir (never the machine's ~/.codex, which this
 * test neither reads nor writes), and read back turn by turn. Skipped cleanly
 * when no `codex` in the supported range is on PATH.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { readClaude } from '../readers/claude.ts'
import { resumeThread } from '../codex/app-server.ts'
import { SUPPORTED, versionSupported } from '../codex/version.ts'
import { writeCodex } from './codex.ts'

const installed = ((): string | null => {
  try {
    return (
      /(\d+\.\d+\.\d+)/.exec(
        execFileSync('codex', ['--version'], { timeout: 15_000 }).toString()
      )?.[1] ?? null
    )
  } catch {
    return null
  }
})()
const supported = installed !== null && versionSupported(installed, SUPPORTED.codex)
const fixtures = join(import.meta.dirname, '..', '..', 'fixtures')
const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(!supported)(
  `a written thread resumes through the real Codex (${installed ?? 'absent'})`,
  () => {
    it('opens with its turns and items in order, the header first, the tool calls as Codex items', async () => {
      const home = mkdtempSync(join(tmpdir(), 'session-bridge-codex-home-'))
      const cwd = join(home, 'workdir')
      mkdirSync(cwd)
      dirs.push(home)
      const session = readClaude(join(fixtures, 'claude-transcript-sample.jsonl'))
      const written = await writeCodex(session, { codexHome: home, cwd })
      expect(written.path.startsWith(home)).toBe(true)
      expect(readdirSync(home).sort()).toEqual(['sessions', 'workdir'])

      const thread = await resumeThread(written.threadId, { codexHome: home, cwd })
      expect(thread.id).toBe(written.threadId)
      expect(thread.historyMode).toBe('paginated')
      expect(thread.preview).toMatch(/^\[This conversation was converted from Claude Code/)
      expect(thread.turns.map((t) => t.status)).toEqual(['completed', 'interrupted', 'completed'])
      expect(thread.turns.map((t) => t.items.map((i) => i.type))).toEqual([
        [
          'userMessage',
          'agentMessage',
          'commandExecution',
          'fileChange',
          'mcpToolCall',
          'agentMessage'
        ],
        ['userMessage', 'mcpToolCall'],
        ['userMessage', 'agentMessage']
      ])
      const [first] = thread.turns
      const user = first.items[0]
      expect((user.content as { text: string }[])[0].text).toMatch(
        /List the files here, then write hello\.txt/
      )
      expect(first.items[2]).toMatchObject({
        command: 'bash -lc ls',
        aggregatedOutput: 'README.md\nsrc\n',
        exitCode: 0,
        status: 'completed'
      })
      expect(first.items[3]).toMatchObject({
        status: 'completed',
        changes: [{ path: '/Users/example/project/hello.txt', kind: { type: 'add' } }]
      })
      expect(first.items[4]).toMatchObject({
        server: 'claude-code',
        tool: 'Read',
        status: 'completed'
      })
      expect(first.items[5]).toMatchObject({
        text: 'Done: the folder holds README.md and src, and hello.txt now says hello.',
        phase: 'final_answer'
      })
      expect(thread.turns[1].items[1]).toMatchObject({ tool: 'Grep', status: 'failed' })
      // Codex rebuilt its own indexes from the one file the writer laid down.
      expect(existsSync(join(home, 'state_5.sqlite'))).toBe(true)
    }, 120_000)
  }
)

describe.skipIf(supported)('without a supported codex on PATH', () => {
  it('the resume test is skipped, not failed', () => {
    expect(supported).toBe(false)
  })
})
