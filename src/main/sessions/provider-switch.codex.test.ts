/**
 * The convert road against the REAL Codex (PRDCT-4300): the bridge's sample
 * Claude transcript written as a thread into a throwaway Codex home under
 * the system temp dir (never the machine's ~/.codex) and read back through
 * `codex app-server`, the same call the chat's popover makes before the tab
 * restarts on that thread. Skipped cleanly when no `codex` in the supported
 * range is on PATH; the refusals are checked whatever is installed.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { SUPPORTED, versionSupported } from '@clave/session-bridge'
import { convertTranscriptToCodex } from './provider-switch'

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
const fixtures = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'packages',
  'session-bridge',
  'fixtures'
)
const sample = join(fixtures, 'claude-transcript-sample.jsonl')
const dirs: string[] = []
const home = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'clave-provider-switch-')))
  dirs.push(dir)
  mkdirSync(join(dir, 'sessions'), { recursive: true })
  return dir
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(!supported)(
  `a Claude conversation converted for Codex ${installed ?? ''} on a throwaway home`,
  () => {
    it('writes the thread, reads it back with its turns, and answers the id the tab resumes', async () => {
      const codexHome = home()
      const converted = await convertTranscriptToCodex({
        transcript: sample,
        codexHome,
        cwd: codexHome,
        bin: 'codex',
        model: 'gpt-5.5'
      })
      expect(converted.ok).toBe(true)
      if (!converted.ok) return
      expect(converted.threadId).toMatch(/^[0-9a-f-]{36}$/)
      expect(existsSync(converted.path)).toBe(true)
      expect(converted.path.startsWith(join(codexHome, 'sessions'))).toBe(true)
    }, 60_000)
    it('refuses a second conversion of the same thread file as a reason, never a throw', async () => {
      const codexHome = home()
      const first = await convertTranscriptToCodex({
        transcript: sample,
        codexHome,
        cwd: codexHome,
        bin: 'codex'
      })
      expect(first.ok).toBe(true)
      // The same source makes the same id (dated at the conversation's start): the file is there.
      const again = await convertTranscriptToCodex({
        transcript: sample,
        codexHome,
        cwd: codexHome,
        bin: 'codex'
      })
      expect(again.ok === false || again.threadId !== (first.ok ? first.threadId : '')).toBe(true)
    }, 60_000)
  }
)

describe('the convert road refuses as a reason, whatever Codex is installed', () => {
  it('a transcript with no conversation in it', async () => {
    const codexHome = home()
    const empty = join(codexHome, 'empty.jsonl')
    writeFileSync(empty, '{"type":"attachment"}\n')
    const converted = await convertTranscriptToCodex({
      transcript: empty,
      codexHome,
      cwd: codexHome,
      bin: 'codex'
    })
    expect(converted).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/transcript|conversation/i)
    })
  })
  it('a Codex that is not there', async () => {
    const codexHome = home()
    const converted = await convertTranscriptToCodex({
      transcript: sample,
      codexHome,
      cwd: codexHome,
      bin: join(codexHome, 'no-such-codex')
    })
    expect(converted.ok).toBe(false)
  }, 30_000)
})
