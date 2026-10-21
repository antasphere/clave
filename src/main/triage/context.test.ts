import { execFileSync } from 'child_process'
import { describe, expect, it } from 'vitest'
import { collectSnapshot } from './collect'
import {
  TRIAGE_PLAYBOOK,
  agentLaunchOf,
  externalCommandsFor,
  launchPrompt,
  ownershipSentence,
  problemCount,
  renderContext,
  seedPrompt,
  shellQuote
} from './context'
import { MCP_TOKEN, SERVER_TOKEN, SHELL_TOKEN, fakeSources } from './testing'

describe('shellQuote', () => {
  it.each([
    "/Users/o'brien/Library/Application Support/Clave/triage/x",
    'a "double" $(touch /tmp/pwned) `id` $HOME;rm -rf ~',
    'new\nline'
  ])('round-trips %j through a POSIX shell without expansion', (value) => {
    const out = execFileSync('/bin/sh', ['-c', `printf %s ${shellQuote(value)}`], {
      encoding: 'utf-8'
    })
    expect(out).toBe(value)
  })

  it('builds commands that cd into the bundle and pass the prompt as one word', () => {
    const dir = "/tmp/it's here"
    const prompt = launchPrompt(`${dir}/prompt.md`)
    const cmds = externalCommandsFor(dir, prompt)
    expect(cmds.claude).toBe(`cd ${shellQuote(dir)} && claude ${shellQuote(prompt)}`)
    expect(cmds.codex.startsWith(`cd ${shellQuote(dir)} && codex `)).toBe(true)
    const argv = execFileSync(
      '/bin/sh',
      ['-c', cmds.claude.replace(/^cd .*? && claude /, 'printf "%s\\n" ')],
      { encoding: 'utf-8' }
    )
    expect(argv.trimEnd()).toBe(prompt)
  })
})

describe('the context file', () => {
  it('says which instance answers and who owns its server', async () => {
    const snapshot = await collectSnapshot(fakeSources())
    const md = renderContext(snapshot, '~/x/snapshot.json')
    expect(md).toContain(
      'This Clave shell (pid 725) started the server as its own child process (pid 1412, running)'
    )
    expect(md).toContain('terminal process (pid 1483, generation 1)')
    expect(md).toContain('Clave 2.4.0 (packaged app)')
    expect(md).toContain('instance id `instance-1`')
    expect(md).toContain('NEVER read these')
    for (const token of [SHELL_TOKEN, SERVER_TOKEN, MCP_TOKEN]) expect(md).not.toContain(token)
    expect(agentLaunchOf(snapshot)).toBe('in-app')
    expect(problemCount(snapshot)).toBe(0)
  })

  it('sends an attached server to the same-machine fallback', async () => {
    const snapshot = await collectSnapshot(
      fakeSources({
        shellDiscovery: async () => ({
          url: 'http://10.0.0.5:7000',
          token: SHELL_TOKEN,
          mode: 'attached',
          ok: true,
          pid: 725
        })
      })
    )
    expect(agentLaunchOf(snapshot)).toBe('external-only')
    expect(ownershipSentence(snapshot.server, 725)).toContain('does not own that process')
    expect(ownershipSentence(snapshot.server, 725)).toContain('version is unknown')
  })

  it('counts a dead server and failed sources as problems', async () => {
    const snapshot = await collectSnapshot(
      fakeSources({
        isAlive: (pid) => pid !== 1412,
        sessions: async () => {
          throw new Error('gone')
        }
      })
    )
    expect(problemCount(snapshot)).toBe(2)
    expect(renderContext(snapshot, null)).toContain('NOT running')
  })
})

describe('the context says why something is missing', () => {
  it('names a health route that failed and a record file it could not read', async () => {
    const base = fakeSources()
    const snapshot = await collectSnapshot(
      fakeSources({
        health: async () => {
          throw new Error('connect ECONNREFUSED')
        },
        records: async () => ({
          total: 1,
          files: [{ key: 'broken', content: null, error: 'broken.json is not valid JSON' }]
        }),
        sessions: base.sessions
      })
    )
    const md = renderContext(snapshot, null)
    expect(md).toContain('/health/live → no answer (error: connect ECONNREFUSED)')
    expect(md).toContain(
      'not readable as a record, left as it is: `broken` (broken.json is not valid JSON)'
    )
    expect(problemCount(snapshot)).toBeGreaterThanOrEqual(2)
  })
})

describe('the playbook', () => {
  it('asks first, requires a yes before repairs, uploads and issues, and protects sessions', () => {
    expect(TRIAGE_PLAYBOOK).toContain('## 1. Ask what went wrong')
    expect(TRIAGE_PLAYBOOK).toMatch(/runs ONLY after .* explicitly said yes/s)
    expect(TRIAGE_PLAYBOOK).toContain('Nothing leaves this machine without an explicit yes')
    expect(TRIAGE_PLAYBOOK).toContain('get an explicit yes before posting')
    expect(TRIAGE_PLAYBOOK).toContain(
      'Do not stop, restart, close, message or type into any session'
    )
    expect(TRIAGE_PLAYBOOK).toContain('who owns')
  })

  it('points the seed at both files and the launch prompt at the seed', () => {
    const seed = seedPrompt('/b/context.md', '/b/snapshot.json')
    expect(seed).toContain('/b/context.md')
    expect(seed).toContain('/b/snapshot.json')
    expect(seed.endsWith(TRIAGE_PLAYBOOK)).toBe(true)
    expect(launchPrompt('/b/prompt.md')).toContain('"/b/prompt.md"')
  })
})
