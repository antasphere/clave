import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The digests on the helpers' runner (PRDCT-4326): what the CLI is asked,
// what is filed, what a failure says. The CLI is a stub.

type Callback = (err: Error | null, stdout: string, stderr: string) => void
const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  calls: [] as Array<{ args: string[]; prompt: string; finish: Callback }>,
  filed: new Map<string, unknown>()
}))
vi.mock('electron', () => {
  throw new Error('the exchange digest imported electron')
})
vi.mock('child_process', () => ({ execFile: mocks.execFile }))
vi.mock('./sessions/adapters/pty-backend', () => ({
  getLoginShellEnv: () => ({ PATH: '/bin' }),
  getUserShell: () => '/bin/zsh',
  accountTokenForSpawn: async () => undefined
}))
vi.mock('./launch-profile-manager', () => ({
  launchProfileManager: {
    resolveClaudeCli: () => ({
      id: 'claude',
      name: 'Claude',
      family: 'claude',
      command: ['claude'],
      additionalArgs: []
    })
  }
}))
vi.mock('./shell-launch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./shell-launch')>()),
  findExecutable: (command: string) => command
}))
vi.mock('./ports', () => ({ settingsPorts: () => ({ storage: { pathOf: () => '/dev/null' } }) }))
vi.mock('./exchange-digest-store', () => ({
  DigestStore: class {
    of(): Record<string, unknown> {
      return {}
    }
    get(session: string, key: string): unknown {
      return mocks.filed.get(`${session}|${key}`)
    }
    put(session: string, key: string, value: unknown): void {
      mocks.filed.set(`${session}|${key}`, value)
    }
    flush(): void {
      /* nothing buffered */
    }
  }
}))

import { cancelAll, requestDigest, requestWorkDigest } from './exchange-digest'
import { helperCliArgs } from './helpers/runner'
import { exchangeDigestHelper } from './helpers/digests'

const DIGEST_CLI_ARGS = helperCliArgs(exchangeDigestHelper.systemPrompt, exchangeDigestHelper)
import { DIGEST_HELPER_MARKER } from '../shared/exchange-digest'
import { WORK_DIGEST_MARKER } from '../shared/work-digest'
import { resetShutdownForTests } from './helpers/runner'

async function ticks(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve))
}

beforeEach(() => {
  mocks.calls.length = 0
  mocks.filed.clear()
  mocks.execFile.mockImplementation(
    (_file: string, args: string[], _opts: unknown, finish: Callback) => {
      const call = { args, prompt: '', finish }
      mocks.calls.push(call)
      return {
        stdin: { write: (text: string) => (call.prompt += text), end: vi.fn(), on: vi.fn() },
        kill: vi.fn(),
        once: vi.fn()
      }
    }
  )
})
afterEach(() => resetShutdownForTests())

describe('the exchange digest on the helpers runner', () => {
  it('asks Haiku, Sonnet behind it, with its own system prompt and the messages as data, and files the answer', async () => {
    expect(DIGEST_CLI_ARGS.slice(0, 5)).toEqual([
      '-p',
      '--model',
      'haiku',
      '--fallback-model',
      'sonnet'
    ])
    const done = requestDigest({
      sessionId: 's1',
      key: 'k1',
      launch: {},
      messages: [
        { from: 'Lane A', text: 'old news' },
        { from: 'Lane B', text: 'Should I merge PR 12?' }
      ]
    })
    await ticks()
    const [call] = mocks.calls
    expect(call.args[call.args.indexOf('--system-prompt') + 1]).toMatch(/not an assistant/)
    expect(call.prompt.startsWith(DIGEST_HELPER_MARKER)).toBe(true)
    expect(call.prompt).toMatch(/<messages>\n[\s\S]*Should I merge PR 12\?[\s\S]*\n<\/messages>/)
    call.finish(null, '{"needs_you": true, "message": 2, "summary": "Lane B asks to merge."}\n', '')
    const result = await done
    expect(result).toEqual({
      ok: true,
      needsYou: true,
      summary: 'Lane B asks to merge.',
      message: 1
    })
    expect(mocks.filed.get('s1|k1')).toEqual(result)
  })

  it('a failure carries its reason and is not filed', async () => {
    const done = requestDigest({
      sessionId: 's2',
      key: 'k2',
      launch: {},
      messages: [{ from: 'x', text: 'y' }]
    })
    await ticks()
    mocks.calls[0].finish(new Error('Command failed'), '', 'Invalid API key · Please run /login')
    await expect(done).resolves.toMatchObject({ ok: false, reason: 'auth' })
    expect(mocks.filed.has('s2|k2')).toBe(false)
  })

  it('the work digest reads its notes as data and puts the note back in the stretch', async () => {
    const notes = Array.from({ length: 45 }, (_, i) => `note ${i}`)
    const done = requestWorkDigest({ sessionId: 's3', key: 'w1', launch: {}, notes, tools: 4 })
    await ticks()
    const [call] = mocks.calls
    expect(call.prompt.startsWith(WORK_DIGEST_MARKER)).toBe(true)
    expect(call.prompt).toMatch(/<notes>\n1\. note 5\n/)
    call.finish(null, '{"title": "Read the notes", "needs_you": true, "note": 2}', '')
    await expect(done).resolves.toEqual({
      ok: true,
      title: 'Read the notes',
      needsYou: true,
      note: 6
    })
  })

  it("the quit's cancel shuts the door for every helper", async () => {
    cancelAll(true)
    await expect(
      requestDigest({
        sessionId: 's4',
        key: 'k4',
        launch: {},
        messages: [{ from: 'x', text: 'y' }]
      })
    ).resolves.toMatchObject({ ok: false, reason: 'cancelled' })
    expect(mocks.calls).toHaveLength(0)
  })
})
