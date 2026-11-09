import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { detectProvider, main } from './cli.ts'

const fixtures = join(import.meta.dirname, '..', 'fixtures')
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const run = async (argv: string[]): Promise<{ code: number; out: string[]; err: string[] }> => {
  const out: string[] = []
  const err: string[] = []
  const code = await main(argv, { out: (l) => out.push(l), err: (l) => err.push(l) })
  return { code, out, err }
}

describe('the command line', () => {
  it('tells a Codex rollout from a Claude transcript by their rows', () => {
    expect(detectProvider(join(fixtures, 'codex-rollout-0.167-hello.jsonl'))).toBe('codex')
    expect(detectProvider(join(fixtures, 'claude-transcript-sample.jsonl'))).toBe('claude')
    const dir = mkdtempSync(join(tmpdir(), 'session-bridge-cli-'))
    dirs.push(dir)
    const other = join(dir, 'other.jsonl')
    writeFileSync(other, '{"type":"something"}\nnot json\n')
    expect(detectProvider(other)).toBeNull()
  })
  it('inspects either file and says what its tape holds', async () => {
    const codex = await run([
      'inspect',
      join(fixtures, 'codex-rollout-0.167-hello.jsonl'),
      '--json'
    ])
    expect(codex.code).toBe(0)
    const parsed = JSON.parse(codex.out.join('\n'))
    expect(parsed.head).toMatchObject({ provider: 'codex', cliVersion: '0.167.0' })
    expect(parsed.events).toEqual({ user_message: 1, assistant_text: 1, context_usage: 1 })
    const claude = await run(['inspect', join(fixtures, 'claude-transcript-sample.jsonl')])
    expect(claude.code).toBe(0)
    expect(claude.out[0]).toMatch(
      /^claude session 11111111-1111-4111-8111-111111111111 in \/Users\/example\/project$/
    )
    expect(claude.out.some((l) => l.startsWith('> List the files here'))).toBe(true)
  })
  it('refuses what it cannot read, with the exit code of a refusal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-bridge-cli-'))
    dirs.push(dir)
    const other = join(dir, 'other.jsonl')
    writeFileSync(other, '{"type":"something"}\n')
    expect((await run(['inspect', other])).code).toBe(1)
    expect((await run(['inspect'])).code).toBe(2)
    expect((await run(['convert', '--from', 'codex', '--to', 'claude', 'x'])).code).toBe(2)
    const missing = await run([
      'convert',
      '--from',
      'claude',
      '--to',
      'codex',
      'no-such-id',
      '--claude-config-dir',
      dir,
      '--codex-home',
      dir
    ])
    expect(missing.code).toBe(1)
    expect(missing.err[0]).toMatch(/No Claude transcript found/)
    expect((await run([])).code).toBe(0)
    expect((await run(['bogus'])).code).toBe(2)
  })
})
