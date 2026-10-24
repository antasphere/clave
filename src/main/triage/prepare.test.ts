import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bundleStamp, writeBundle } from './bundle'
import { prepareWith } from './prepare'
import { GENERATED_TITLE, HOME, MCP_TOKEN, SERVER_TOKEN, SHELL_TOKEN, fakeSources } from './testing'

let userData: string
beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'clave-triage-unit-'))
})
afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true })
})

const mode = (p: string): number => fs.statSync(p).mode & 0o777

describe('prepareWith', () => {
  it('writes a private bundle and answers the prompt, commands and context', async () => {
    const result = await prepareWith({ sources: fakeSources(), userData, home: HOME })
    expect(result.bundle).not.toBeNull()
    const b = result.bundle!
    expect(path.dirname(b.dir)).toBe(path.join(userData, 'triage'))
    expect(path.basename(b.dir)).toBe(bundleStamp(new Date('2026-10-21T12:00:00.000Z')))
    expect(mode(path.join(userData, 'triage'))).toBe(0o700)
    expect(mode(b.dir)).toBe(0o700)
    for (const f of [b.snapshotPath, b.contextPath, b.promptPath]) expect(mode(f)).toBe(0o600)

    expect(fs.readFileSync(b.contextPath, 'utf-8')).toBe(result.contextMarkdown)
    expect(JSON.parse(fs.readFileSync(b.snapshotPath, 'utf-8'))).toEqual(result.snapshot)
    expect(fs.readFileSync(b.promptPath, 'utf-8')).toContain(b.contextPath)
    expect(result.launchPrompt).toContain(b.promptPath)
    expect(result.externalCommands?.claude).toContain(' && claude ')
    expect(result.agentLaunch).toBe('in-app')
    expect(result.origin).toEqual(result.snapshot.origin)
    expect(result.summary).toEqual({
      mode: 'separate',
      serverOk: true,
      windows: 2,
      sessions: 2,
      problems: 0
    })

    for (const f of [b.snapshotPath, b.contextPath, b.promptPath]) {
      const text = fs.readFileSync(f, 'utf-8')
      for (const leak of [SHELL_TOKEN, SERVER_TOKEN, MCP_TOKEN, GENERATED_TITLE])
        expect(text).not.toContain(leak)
    }
  })

  it('still answers the context when the bundle cannot be written', async () => {
    fs.symlinkSync(os.tmpdir(), path.join(userData, 'triage'))
    const result = await prepareWith({ sources: fakeSources(), userData, home: HOME })
    expect(result.bundle).toBeNull()
    expect(result.launchPrompt).toBeNull()
    expect(result.externalCommands).toBeNull()
    expect(result.contextMarkdown).toContain('# Clave triage context')
    expect(result.warnings.some((w) => w.includes('could not be written'))).toBe(true)
  })

  it('summarises a dead separate server as not ok', async () => {
    const result = await prepareWith({
      sources: fakeSources({ isAlive: (pid) => pid !== 1412 }),
      userData,
      home: HOME
    })
    expect(result.summary.serverOk).toBe(false)
    expect(result.summary.problems).toBeGreaterThan(0)
  })
})

describe("prepareWith, with the collection's known secrets (VA-11)", () => {
  it('scrubs a known token from the write error naming the bundle path', async () => {
    const tokened = path.join(userData, `clave-${SHELL_TOKEN}`)
    fs.mkdirSync(tokened)
    fs.symlinkSync(os.tmpdir(), path.join(tokened, 'triage'))
    const result = await prepareWith({ sources: fakeSources(), userData: tokened, home: HOME })
    expect(result.bundle).toBeNull()
    const warning = result.warnings.find((w) => w.includes('could not be written'))
    expect(warning).toBeDefined()
    expect(warning).not.toContain(SHELL_TOKEN)
    expect(JSON.stringify(result)).not.toContain(SHELL_TOKEN)
  })

  it('scrubs the context while the returned pointers keep the real bundle path', async () => {
    const tokened = path.join(userData, `clave-${SHELL_TOKEN}`)
    fs.mkdirSync(tokened)
    const result = await prepareWith({ sources: fakeSources(), userData: tokened, home: HOME })
    expect(result.bundle?.dir.includes(SHELL_TOKEN)).toBe(true)
    expect(result.launchPrompt).toContain(result.bundle!.promptPath)
    expect(result.contextMarkdown).not.toContain(SHELL_TOKEN)
    expect(fs.readFileSync(result.bundle!.contextPath, 'utf-8')).not.toContain(SHELL_TOKEN)
    expect(JSON.stringify(result.snapshot)).not.toContain(SHELL_TOKEN)
  })
})

describe('writeBundle', () => {
  const contents = {
    snapshot: '{}',
    context: (p: string) => `ctx ${p}`,
    prompt: (c: string, s: string) => `prompt ${c} ${s}`
  }
  const date = new Date('2026-10-21T12:00:00.000Z')

  it('never reuses a bundle folder', () => {
    const a = writeBundle(userData, date, contents).bundle
    const b = writeBundle(userData, date, contents).bundle
    expect(a.dir).not.toBe(b.dir)
    expect(b.dir.endsWith('-1')).toBe(true)
  })

  it('refuses a triage folder that is a link or a file', () => {
    fs.writeFileSync(path.join(userData, 'triage'), 'x')
    expect(() => writeBundle(userData, date, contents)).toThrow(/not a plain directory/)
  })

  it('tightens a triage folder that exists with a looser mode', () => {
    fs.mkdirSync(path.join(userData, 'triage'), { mode: 0o755 })
    fs.chmodSync(path.join(userData, 'triage'), 0o755)
    writeBundle(userData, date, contents)
    expect(mode(path.join(userData, 'triage'))).toBe(0o700)
  })
})
