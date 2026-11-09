import {
  chmodSync,
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
  describe('convert, with a stand-in codex on PATH (verifier round 1, G1)', () => {
    const env = { PATH: process.env.PATH, CODEX_HOME: process.env.CODEX_HOME }
    afterEach(() => {
      process.env.PATH = env.PATH
      if (env.CODEX_HOME === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = env.CODEX_HOME
    })
    const withFakeCodex = (version: string): string => {
      const dir = mkdtempSync(join(tmpdir(), 'session-bridge-cli-'))
      dirs.push(dir)
      const bin = join(dir, 'bin')
      mkdirSync(bin)
      writeFileSync(join(bin, 'codex'), `#!/bin/sh\nprintf 'codex-cli ${version}\\n'\n`)
      chmodSync(join(bin, 'codex'), 0o755)
      process.env.PATH = `${bin}:${process.env.PATH}`
      return dir
    }
    it('writes under --codex-home, never under CODEX_HOME or ~/.codex, and prints the resume to run', async () => {
      const dir = withFakeCodex('0.167.0')
      const flagHome = join(dir, 'flag-home')
      const envHome = join(dir, 'env-home')
      mkdirSync(envHome)
      process.env.CODEX_HOME = envHome
      const result = await run([
        'convert',
        '--from',
        'claude',
        '--to',
        'codex',
        join(fixtures, 'claude-transcript-sample.jsonl'),
        '--codex-home',
        flagHome,
        '--cwd',
        dir,
        '--json'
      ])
      expect(result.code).toBe(0)
      const written = JSON.parse(result.out.join('\n'))
      expect(written.path.startsWith(flagHome)).toBe(true)
      expect(existsSync(written.path)).toBe(true)
      expect(readdirSync(envHome)).toEqual([])
      expect(written.turns).toBe(3)
      const plain = await run([
        'convert',
        '--from',
        'claude',
        '--to',
        'codex',
        join(fixtures, 'claude-transcript-sample.jsonl'),
        '--codex-home',
        flagHome,
        '--cwd',
        '.'
      ])
      expect(plain.code).toBe(0)
      expect(plain.out.some((l) => /^Resume it with: codex resume [0-9a-f-]{36}$/.test(l))).toBe(
        true
      )
      expect(plain.out.some((l) => l.includes(`CODEX_HOME=${flagHome}`))).toBe(true)
    })
    it('resolves a relative --cwd to an absolute path (M2)', async () => {
      const dir = withFakeCodex('0.167.0')
      const home = join(dir, 'home')
      const result = await run([
        'convert',
        '--from',
        'claude',
        '--to',
        'codex',
        join(fixtures, 'claude-transcript-sample.jsonl'),
        '--codex-home',
        home,
        '--cwd',
        '.',
        '--json'
      ])
      expect(result.code).toBe(0)
      const written = JSON.parse(result.out.join('\n'))
      const firstRow = JSON.parse(readFileSync(written.path, 'utf8').split('\n')[0])
      expect(firstRow.payload.cwd).toBe(process.cwd())
    })
    it('refuses a codex outside the pin with exit code 3 and writes nothing (M12)', async () => {
      const dir = withFakeCodex('0.168.0')
      const home = join(dir, 'home')
      const result = await run([
        'convert',
        '--from',
        'claude',
        '--to',
        'codex',
        join(fixtures, 'claude-transcript-sample.jsonl'),
        '--codex-home',
        home,
        '--cwd',
        dir
      ])
      expect(result.code).toBe(3)
      expect(result.err[0]).toMatch(/0\.168\.0.*0\.167\.x.*nothing was written/)
      expect(existsSync(home)).toBe(false)
    })
  })
})
