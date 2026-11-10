import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The runner with a stub CLI: what it was asked, in which order, how many at
// once, and what it did with each answer. Nothing here reaches a model.

type Callback = (err: (Error & { killed?: boolean }) | null, stdout: string, stderr: string) => void
interface Spawned {
  file: string
  args: string[]
  opts: { env: Record<string, string>; timeout: number }
  prompt: string
  finish: Callback
  kill: ReturnType<typeof vi.fn>
  exit: () => void
}

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  spawned: [] as Spawned[],
  resolve: vi.fn(),
  getToken: vi.fn((id: string | undefined) => (id ? `sk-ant-oat01-${id}` : undefined))
}))
vi.mock('electron', () => {
  throw new Error('the helpers runner imported electron')
})
vi.mock('child_process', () => ({ execFile: mocks.execFile }))
vi.mock('../sessions/adapters/pty-backend', () => ({
  getLoginShellEnv: () => ({ PATH: '/bin', CLAUDECODE: '1' }),
  getUserShell: () => '/bin/zsh',
  accountTokenForSpawn: async (_kind: string, id: string | undefined) => mocks.getToken(id)
}))
vi.mock('../launch-profile-manager', () => ({
  launchProfileManager: { resolveClaudeCli: mocks.resolve }
}))
vi.mock('../shell-launch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shell-launch')>()),
  findExecutable: (command: string) => command
}))

import {
  cancelAll,
  cancelQueued,
  classifyFailure,
  helperCliArgs,
  queuedHelpers,
  resetShutdownForTests,
  runHelper,
  runningHelpers,
  shutdown,
  MAX_RUNNING_HELPERS
} from './runner'
import {
  defineHelper,
  helperById,
  helperConfig,
  listHelpers,
  setHelperConfigSource,
  type HelperDefinition
} from './registry'

let sequence = 0
function helper(
  overrides: Partial<HelperDefinition<string, string>> = {}
): HelperDefinition<string, string> {
  return defineHelper<string, string>({
    id: `test-helper-${++sequence}`,
    label: 'Test helper',
    systemPrompt: 'You are a test function.',
    buildPrompt: (input) => `PROMPT ${input}`,
    parseReply: (stdout) => (stdout.trim().startsWith('ok ') ? stdout.trim().slice(3) : null),
    model: 'haiku',
    timeoutMs: 5000,
    priority: 10,
    ...overrides
  })
}

async function ticks(n = 4): Promise<void> {
  for (let i = 0; i < n; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setImmediate(resolve))
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.spawned.length = 0
  mocks.resolve.mockReturnValue({
    id: 'claude',
    name: 'Claude',
    family: 'claude',
    command: ['claude'],
    additionalArgs: ['--add-dir', '/tmp']
  })
  mocks.execFile.mockImplementation(
    (file: string, args: string[], opts: Spawned['opts'], finish: Callback) => {
      const exits: Array<() => void> = []
      const entry: Spawned = {
        file,
        args,
        opts,
        prompt: '',
        finish,
        kill: vi.fn(),
        exit: () => exits.forEach((listener) => listener())
      }
      mocks.spawned.push(entry)
      return {
        stdin: { write: (text: string) => (entry.prompt += text), end: vi.fn(), on: vi.fn() },
        kill: entry.kill,
        once: (event: string, listener: () => void) => {
          if (event === 'exit') exits.push(listener)
        }
      }
    }
  )
})

afterEach(async () => {
  // Every child a test left running ends, as a killed CLI does: its slot is
  // held until its callback, so a test that left one would starve the next.
  cancelAll()
  for (const child of mocks.spawned)
    child.finish(Object.assign(new Error('killed'), { killed: true }), '', '')
  await ticks()
  resetShutdownForTests()
  setHelperConfigSource()
})

describe('the registry', () => {
  it('lists what was declared, highest priority first, and refuses a second declaration of an id', () => {
    const low = helper({ priority: 1 })
    const high = helper({ priority: 99 })
    const ids = listHelpers().map((h) => h.id)
    expect(ids.indexOf(high.id)).toBeLessThan(ids.indexOf(low.id))
    expect(helperById(low.id)).toBe(low)
    expect(() => defineHelper({ ...low })).toThrow(/declared twice/)
  })

  it('answers the defaults until a source overrides them, field by field', () => {
    const h = helper({ model: 'haiku', fallbackModel: 'sonnet' })
    expect(helperConfig(h)).toEqual({
      enabled: true,
      model: 'haiku',
      fallbackModel: 'sonnet',
      claudeProfileId: undefined
    })
    setHelperConfigSource((id) =>
      id === h.id ? { model: 'sonnet', claudeProfileId: null } : undefined
    )
    expect(helperConfig(h)).toMatchObject({ enabled: true, model: 'sonnet', claudeProfileId: null })
  })
})

describe('the built-in helpers', () => {
  it('are all declared once the index is loaded, the commit message first', async () => {
    const index = await import('./index')
    const ids = index.listHelpers().map((h) => h.id)
    for (const id of [
      'commit-message',
      'tab-title',
      'push-summary',
      'exchange-digest',
      'work-digest'
    ])
      expect(ids).toContain(id)
    expect(ids.indexOf('commit-message')).toBeLessThan(ids.indexOf('tab-title'))
    expect(ids.indexOf('tab-title')).toBeLessThan(ids.indexOf('exchange-digest'))
  })
})

describe('the CLI a helper runs', () => {
  it('one turn on the model, its own system prompt, no MCP, no skill, no tool, the prompt on stdin', async () => {
    const h = helper({ fallbackModel: 'sonnet' })
    const done = runHelper(h, 'hello', { claudeProfileId: 'acct' })
    await ticks()
    const [call] = mocks.spawned
    expect(call.file).toBe('claude')
    expect(call.args).toEqual(
      helperCliArgs('You are a test function.', { model: 'haiku', fallbackModel: 'sonnet' })
    )
    expect(call.args.slice(0, 5)).toEqual(['-p', '--model', 'haiku', '--fallback-model', 'sonnet'])
    expect(call.args[call.args.indexOf('--system-prompt') + 1]).toBe('You are a test function.')
    expect(call.args.slice(-2)).toEqual(['--tools', ''])
    expect(call.args).not.toContain('--add-dir')
    expect(call.args).not.toContain('--setting-sources')
    expect(call.args).not.toContain('--bare')
    expect(call.prompt).toBe('PROMPT hello')
    expect(call.opts.env.CLAUDECODE).toBeUndefined()
    expect(call.opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-acct')
    expect(call.opts.timeout).toBe(5000)
    call.finish(null, 'ok fine\n', '')
    await expect(done).resolves.toEqual({ ok: true, value: 'fine', attempts: 1, model: 'haiku' })
  })

  it('drops a fallback model equal to the model (the CLI refuses that pair)', () => {
    expect(helperCliArgs('s', { model: 'haiku', fallbackModel: 'haiku' })).not.toContain(
      '--fallback-model'
    )
  })

  it("runs on the account the seam names: the helper's own, or the machine login", async () => {
    const h = helper()
    setHelperConfigSource(() => ({ claudeProfileId: 'helper-acct' }))
    void runHelper(h, 'x', { claudeProfileId: 'session-acct', configDir: '/legacy' })
    await ticks()
    expect(mocks.spawned[0].opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-helper-acct')
    expect(mocks.spawned[0].opts.env.CLAUDE_CONFIG_DIR).toBeUndefined()
    setHelperConfigSource(() => ({ claudeProfileId: null, model: 'sonnet' }))
    void runHelper(h, 'y', { claudeProfileId: 'session-acct' })
    await ticks()
    expect(mocks.spawned[1].opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(mocks.spawned[1].args.slice(0, 3)).toEqual(['-p', '--model', 'sonnet'])
  })

  it('a helper switched off runs nothing and says so', async () => {
    const h = helper()
    setHelperConfigSource(() => ({ enabled: false }))
    const outcome = await runHelper(h, 'x')
    expect(outcome).toMatchObject({ ok: false, reason: 'disabled' })
    expect(mocks.execFile).not.toHaveBeenCalled()
  })
})

describe('the queue', () => {
  it(`runs at most ${MAX_RUNNING_HELPERS} at once, then the highest priority, oldest first among equals`, async () => {
    const low = helper({ priority: 1 })
    const mid = helper({ priority: 50 })
    const high = helper({ priority: 90 })
    for (let i = 0; i < MAX_RUNNING_HELPERS; i++) void runHelper(low, `busy-${i}`)
    void runHelper(low, 'low-late')
    void runHelper(mid, 'mid-first')
    void runHelper(high, 'high')
    void runHelper(mid, 'mid-second')
    await ticks()
    expect(mocks.spawned).toHaveLength(MAX_RUNNING_HELPERS)
    expect(runningHelpers()).toBe(MAX_RUNNING_HELPERS)
    expect(queuedHelpers()).toHaveLength(4)
    const order: string[] = []
    for (let i = 0; i < 4; i++) {
      mocks.spawned[i].finish(null, 'ok done', '')
      await ticks()
      order.push(mocks.spawned[MAX_RUNNING_HELPERS + i].prompt)
    }
    expect(order).toEqual([
      'PROMPT high',
      'PROMPT mid-first',
      'PROMPT mid-second',
      'PROMPT low-late'
    ])
  })

  it('holds a helper to its own cap while others run beside it', async () => {
    const single = helper({ concurrency: 1, priority: 80 })
    const other = helper({ priority: 1 })
    void runHelper(single, 'a')
    void runHelper(single, 'b')
    void runHelper(other, 'c')
    await ticks()
    expect(mocks.spawned.map((s) => s.prompt)).toEqual(['PROMPT a', 'PROMPT c'])
    mocks.spawned[0].finish(null, 'ok', '')
    await ticks()
    expect(mocks.spawned.map((s) => s.prompt)).toEqual(['PROMPT a', 'PROMPT c', 'PROMPT b'])
  })

  it('refuses the queued jobs of one owner and leaves the rest', async () => {
    const h = helper({ concurrency: 1 })
    void runHelper(h, 'running', {}, { owner: 'tab-1' })
    const mine = runHelper(h, 'mine', {}, { owner: 'tab-1' })
    const theirs = runHelper(h, 'theirs', {}, { owner: 'tab-2' })
    await ticks()
    cancelQueued('tab-1')
    await expect(mine).resolves.toMatchObject({ ok: false, reason: 'cancelled' })
    mocks.spawned[0].finish(null, 'ok', '')
    await ticks()
    expect(mocks.spawned[1].prompt).toBe('PROMPT theirs')
    mocks.spawned[1].finish(null, 'ok theirs', '')
    await expect(theirs).resolves.toMatchObject({ ok: true, value: 'theirs' })
  })
})

describe('a reply that is not the asked shape', () => {
  it('is tried again as many times as the helper asks, then reported unreadable', async () => {
    const h = helper({ attempts: 2 })
    const done = runHelper(h, 'x')
    await ticks()
    mocks.spawned[0].finish(null, 'Sure, let me help with that.', '')
    await ticks()
    expect(mocks.spawned).toHaveLength(2)
    mocks.spawned[1].finish(null, 'still talking', '')
    await expect(done).resolves.toMatchObject({
      ok: false,
      reason: 'unreadable',
      detail: 'still talking'
    })
  })

  it('a retry that reads is the answer, with the tries counted', async () => {
    const h = helper({ attempts: 2 })
    const done = runHelper(h, 'x')
    await ticks()
    mocks.spawned[0].finish(null, 'chatter', '')
    await ticks()
    mocks.spawned[1].finish(null, 'ok second', '')
    await expect(done).resolves.toEqual({ ok: true, value: 'second', attempts: 2, model: 'haiku' })
  })

  it('a usage limit printed as the reply is a limit, not unreadable, and is not retried', async () => {
    const h = helper({ attempts: 2 })
    const done = runHelper(h, 'x')
    await ticks()
    mocks.spawned[0].finish(null, 'Claude AI usage limit reached|1762794000', '')
    await expect(done).resolves.toMatchObject({ ok: false, reason: 'limit' })
    expect(mocks.spawned).toHaveLength(1)
  })
})

describe('typed failure reasons', () => {
  it('names the timeout, the refusal, the limit and the rest', async () => {
    expect(classifyFailure({ killed: true, message: 'Command failed' })).toBe('timeout')
    expect(classifyFailure({ stderr: 'Invalid API key · Please run /login' })).toBe('auth')
    expect(classifyFailure({ stderr: 'API Error: 401 {"type":"authentication_error"}' })).toBe(
      'auth'
    )
    expect(classifyFailure({ stdout: "You've hit your usage limit · resets 5pm" })).toBe('limit')
    expect(classifyFailure({ stderr: 'API Error: 429 rate_limit_error' })).toBe('limit')
    expect(classifyFailure({ message: 'spawn claude ENOENT' })).toBe('failed')
  })

  it("a failure's detail is the exit and stderr, never the argv with the system prompt in it", async () => {
    const h = helper({ systemPrompt: 'SECRET-SYSTEM-PROMPT about rate limits' })
    const done = runHelper(h, 'x')
    await ticks()
    const err = Object.assign(
      new Error('Command failed: claude -p --system-prompt SECRET-SYSTEM-PROMPT about rate limits'),
      { code: 1 }
    )
    mocks.spawned[0].finish(err, '', 'something broke')
    const outcome = await done
    expect(outcome).toEqual({
      ok: false,
      reason: 'failed',
      detail: 'exit code 1 — something broke'
    })
  })

  it('a timed-out child is a timeout, not retried', async () => {
    const h = helper({ attempts: 2 })
    const done = runHelper(h, 'x')
    await ticks()
    const err = Object.assign(new Error('Command failed'), { killed: true })
    mocks.spawned[0].finish(err, '', '')
    await expect(done).resolves.toMatchObject({ ok: false, reason: 'timeout' })
    expect(mocks.spawned).toHaveLength(1)
  })

  it('an account refused before any spawn is auth, and the queue moves on', async () => {
    const h = helper({ concurrency: 1 })
    mocks.getToken.mockImplementationOnce(() => {
      throw new Error('The selected Claude account is no longer available.')
    })
    const refused = runHelper(h, 'x', { claudeProfileId: 'gone' })
    const next = runHelper(h, 'y')
    await expect(refused).resolves.toMatchObject({ ok: false, reason: 'auth' })
    await ticks()
    expect(mocks.spawned.map((s) => s.prompt)).toEqual(['PROMPT y'])
    mocks.spawned[0].finish(null, 'ok y', '')
    await expect(next).resolves.toMatchObject({ ok: true })
  })
})

describe('the quit ends every helper (PRDCT-3375)', () => {
  it('cancelAll signals every running CLI, refuses the queued, and drops a late answer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const h = helper({ attempts: 2 })
      const running = [runHelper(h, 'a'), runHelper(h, 'b'), runHelper(h, 'c')]
      const queued = runHelper(h, 'd')
      await vi.waitFor(() => expect(mocks.spawned).toHaveLength(3))
      cancelAll()
      for (const child of mocks.spawned) expect(child.kill).toHaveBeenCalledWith('SIGTERM')
      await expect(queued).resolves.toMatchObject({ ok: false, reason: 'cancelled' })
      // One leaves on SIGTERM; the other two are still there after the grace.
      mocks.spawned[0].exit()
      vi.advanceTimersByTime(1000)
      expect(mocks.spawned[0].kill).not.toHaveBeenCalledWith('SIGKILL')
      expect(mocks.spawned[1].kill).toHaveBeenCalledWith('SIGKILL')
      // A late answer, even a readable one, names nothing and is not retried.
      for (const child of mocks.spawned) child.finish(null, 'ok late', '')
      for (const outcome of await Promise.all(running))
        expect(outcome).toMatchObject({ ok: false, reason: 'cancelled' })
      expect(runningHelpers()).toBe(0)
      expect(mocks.spawned).toHaveLength(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancelAll leaves the door open; shutdown shuts it', async () => {
    const h = helper()
    cancelAll()
    void runHelper(h, 'after-cancel')
    await ticks()
    expect(mocks.spawned).toHaveLength(1)
    shutdown()
    expect(mocks.spawned[0].kill).toHaveBeenCalledWith('SIGTERM')
    const after = await runHelper(h, 'after-quit')
    expect(after).toMatchObject({ ok: false, reason: 'cancelled' })
    await ticks()
    expect(mocks.spawned).toHaveLength(1)
  })
})
