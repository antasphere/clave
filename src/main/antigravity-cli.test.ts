import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  listAntigravityModels,
  normalizeAntigravityLimits,
  readAntigravityLimits,
  readAntigravityStartMode,
  readProfileSettings,
  settingsFileThatAsks
} from './antigravity-cli'

// `agy --output-format json -p /usage`, 1.5.14, 22 November 2026.
const USAGE = {
  conversation_id: '',
  status: 'SUCCESS',
  response: 'Gemini Models\tWeekly Limit Remaining\t100%\t2026-11-28T20:30:55Z\n',
  num_turns: 0,
  command: {
    name: 'usage',
    data: {
      groups: [
        {
          name: 'Gemini Models',
          buckets: [
            {
              id: 'gemini-weekly',
              window: 'weekly',
              remaining_fraction: 0.75,
              reset_time: '2026-11-28T20:30:55Z'
            },
            {
              id: 'gemini-5h',
              window: '5h',
              remaining_fraction: 0.5,
              reset_time: '2026-11-22T17:47:51Z'
            }
          ]
        },
        {
          name: 'Claude and GPT models',
          buckets: [
            { id: '3p-weekly', window: 'weekly', remaining_fraction: 1 },
            { id: '3p-5h', window: '5h', remaining_fraction: 0 }
          ]
        }
      ]
    }
  }
}

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agy-cli-'))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

/** A stand-in `agy` on a PATH of its own, logging each call it gets. */
function agy(body: string): Record<string, string> {
  const bin = join(home, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(
    join(bin, 'agy'),
    `#!${process.execPath}
const argv = process.argv.slice(2)
require('node:fs').appendFileSync(${JSON.stringify(join(home, 'calls'))}, argv.join(' ') + '\\n')
${body}
`
  )
  chmodSync(join(bin, 'agy'), 0o755)
  return { PATH: bin, HOME: home }
}
const calls = (): string[] =>
  existsSync(join(home, 'calls'))
    ? readFileSync(join(home, 'calls'), 'utf8').trim().split('\n')
    : []
const MODELS = `process.stderr.write('Fetching available models...\\n')
  process.stdout.write('gemini-4-neon-high\\tGemini 4 Neon (High)\\ngemini-4-neon-low\\tGemini 4 Neon (Low)\\n')`

describe('normalizeAntigravityLimits', () => {
  it('makes one window per group and span, the share used and the reset', () => {
    expect(normalizeAntigravityLimits(USAGE, 42)).toEqual({
      fetchedAt: 42,
      windows: [
        {
          key: 'gemini-weekly',
          label: 'Weekly · Gemini',
          kind: 'weekly_scoped',
          scope: 'Gemini',
          usedPercentage: 25,
          resetsAt: Date.parse('2026-11-28T20:30:55Z'),
          severity: null
        },
        {
          key: 'gemini-5h',
          label: '5-hour · Gemini',
          kind: 'session',
          scope: 'Gemini',
          usedPercentage: 50,
          resetsAt: Date.parse('2026-11-22T17:47:51Z'),
          severity: null
        },
        {
          key: '3p-weekly',
          label: 'Weekly · Claude and GPT',
          kind: 'weekly_scoped',
          scope: 'Claude/GPT',
          usedPercentage: 0,
          resetsAt: null,
          severity: null
        },
        {
          key: '3p-5h',
          label: '5-hour · Claude and GPT',
          kind: 'session',
          scope: 'Claude/GPT',
          usedPercentage: 100,
          resetsAt: null,
          severity: null
        }
      ]
    })
  })
  it('leaves out a disabled bucket and one with no share, and never invents a zero', () => {
    const buckets = [
      { id: 'a', window: 'weekly', remaining_fraction: 0.5, disabled: true },
      { id: 'b', window: 'weekly', remaining_amount: 120 },
      { id: 'c', window: 'weekly', remaining_fraction: '0.5' }
    ]
    const read = normalizeAntigravityLimits({
      command: { data: { groups: [{ name: 'Gemini Models', buckets }] } }
    })
    expect(read.windows).toEqual([])
  })
  it('refuses an answer of another shape', () => {
    expect(() => normalizeAntigravityLimits({ status: 'SUCCESS', response: 'hello' })).toThrow()
  })
})

describe('readAntigravityLimits', () => {
  it('reads the limits through the CLI, logging nothing', async () => {
    const env = agy(`if (argv.includes('models')) { ${MODELS} }
else process.stdout.write(${JSON.stringify(JSON.stringify(USAGE))})`)
    const read = await readAntigravityLimits({ env })
    expect('windows' in read && read.windows).toHaveLength(4)
    expect(calls()[1]).toContain('--output-format json -p /usage')
    for (const call of calls()) expect(call).toContain('--log-file')
  })
  it('never starts the sign-in that `-p /usage` opens on a signed-out CLI', async () => {
    const env = agy(`process.stderr.write('Error: Please sign in to view available models.\\n')
process.exit(1)`)
    expect(await readAntigravityLimits({ env })).toEqual({
      error: 'Sign in to Antigravity to see its usage: run agy in a terminal.'
    })
    expect(calls()).toHaveLength(1)
    expect(calls()[0]).not.toContain('/usage')
  })
  it('says an API key has no plan limits, without an error', async () => {
    const env = agy(`if (argv.includes('models')) { ${MODELS} }
else { process.stderr.write('/usage is not available with a GEMINI_API_KEY\\n'); process.exit(2) }`)
    expect(await readAntigravityLimits({ env })).toMatchObject({
      windows: [],
      message: 'Antigravity is using an API key. Plan limits do not apply.'
    })
  })
  it('takes no exit 0 without a model for a sign-in', async () => {
    const env = agy('process.exit(0)')
    expect(await readAntigravityLimits({ env })).toMatchObject({ error: expect.any(String) })
    expect(calls()).toHaveLength(1)
  })
  it('says a CLI that is missing, or one that answers something else', async () => {
    expect(await readAntigravityLimits({ env: { PATH: home, HOME: home } })).toEqual({
      error: 'Antigravity CLI is not installed on this machine.'
    })
    const env = agy(`if (argv.includes('models')) { ${MODELS} }
else process.stdout.write('not json')`)
    expect(await readAntigravityLimits({ env })).toEqual({
      error: 'Antigravity returned an unexpected usage response. Try updating Antigravity CLI.'
    })
  })
})

describe('listAntigravityModels', () => {
  it('lists the models the CLI prints, stdin closed', async () => {
    const env = agy(`process.stdin.resume(); process.stdin.on('end', () => { ${MODELS} })`)
    expect(await listAntigravityModels({ env })).toEqual([
      {
        id: 'gemini-4-neon',
        label: 'Gemini 4 Neon',
        efforts: [
          { id: 'low', label: 'Low' },
          { id: 'high', label: 'High' }
        ]
      }
    ])
  })
  it('rejects when it lists none', async () => {
    await expect(listAntigravityModels({ env: agy('process.exit(0)') })).rejects.toThrow()
  })
})

describe('readAntigravityStartMode', () => {
  it('reads the CLI settings under the home given', () => {
    expect(readAntigravityStartMode({ HOME: home })).toBe('auto')
    const dir = join(home, '.gemini', 'antigravity-cli')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'settings.json'), '{"agentMode":"plan"}')
    expect(readAntigravityStartMode({ HOME: home })).toBe('plan')
  })
  it('asks when the file is there and cannot be read', () => {
    mkdirSync(join(home, '.gemini', 'antigravity-cli', 'settings.json'), { recursive: true })
    expect(readAntigravityStartMode({ HOME: home })).toBe('default')
  })
})

describe('readProfileSettings', () => {
  const read = (settings?: string): unknown => readProfileSettings(settings, home)
  it('says nothing for settings that say nothing of permissions', () => {
    expect(read()).toEqual({})
    expect(read('{"model":"x","permissions":{}}')).toEqual({})
  })
  it('reads inline settings and a file', () => {
    expect(read('{"agentMode":"plan"}')).toEqual({ start: 'plan' })
    writeFileSync(join(home, 'rules.json'), '{"agentMode":""}')
    expect(read('rules.json')).toEqual({ start: 'default' })
  })
  it('tells strict, which holds in both transports, from rules the chat cannot apply', () => {
    expect(read('{"toolPermission":"strict"}')).toEqual({ strict: true })
    for (const rules of [
      '{"permissions":{"deny":["command(rm)"]}}',
      '{"permissions":{"ask":["command(git push)"]}}',
      '{"allowNonWorkspaceAccess":false}',
      '{"enableTerminalSandbox":true}'
    ])
      expect(read(rules)).toEqual({ rules: true })
  })
  it('asks for settings that do not read', () => {
    for (const settings of ['{"agentMode":', 'missing.json'])
      expect(read(settings)).toEqual({ strict: true })
  })
})

describe('settingsFileThatAsks', () => {
  it('passes a file that already asks untouched, as it is', () => {
    writeFileSync(join(home, 'ask.json'), '{"agentMode":"","toolPermission":"strict"}')
    expect(settingsFileThatAsks('ask.json', home)).toBe('ask.json')
  })
  it('copies any other, its rules kept, for the person alone to read', () => {
    writeFileSync(join(home, 'rules.json'), '{"agentMode":"auto","permissions":{"deny":["x"]}}')
    const copy = settingsFileThatAsks('rules.json', home)!
    expect(JSON.parse(readFileSync(copy, 'utf8'))).toEqual({
      agentMode: '',
      permissions: { deny: ['x'] }
    })
    expect(statSync(copy).mode & 0o077).toBe(0)
  })
  it('answers none for a file that does not read', () => {
    expect(settingsFileThatAsks('missing.json', home)).toBeUndefined()
  })
})
