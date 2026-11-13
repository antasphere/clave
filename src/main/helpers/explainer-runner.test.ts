import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// PRDCT-4331 on the runner, with the same stub CLI as runner.test.ts: the
// permission explainer serves the newest request first, at most two at once,
// and a reading whose request was answered is ended, waiting or running.

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
  cancelOwned,
  queuedHelpers,
  resetShutdownForTests,
  runHelper,
  runningHelpers
} from './runner'
import { defineHelper, setHelperConfigSource, type HelperDefinition } from './registry'
import { permissionExplainerHelper } from './explainer'

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

describe('the permission explainer on the runner', () => {
  it('is not background work, runs two at once, the newest request first', async () => {
    expect(permissionExplainerHelper.background).toBeFalsy()
    expect(permissionExplainerHelper.concurrency).toBe(2)
    expect(permissionExplainerHelper.newestFirst).toBe(true)
    const h = helper({ id: 'explainer-like', newestFirst: true, concurrency: 1 })
    const first = runHelper(h, 'a', {}, { owner: 'a' })
    await ticks()
    void runHelper(h, 'b', {}, { owner: 'b' })
    void runHelper(h, 'c', {}, { owner: 'c' })
    await ticks()
    expect(mocks.spawned.map((s) => s.prompt)).toEqual(['PROMPT a'])
    mocks.spawned[0].finish(null, 'ok done', '')
    await first
    await ticks()
    expect(mocks.spawned.map((s) => s.prompt)).toEqual(['PROMPT a', 'PROMPT c'])
  })

  it('ends a waiting reading by its owner: it never starts', async () => {
    const h = helper({ id: 'explainer-wait', concurrency: 1 })
    void runHelper(h, 'a', {}, { owner: 'a' })
    await ticks()
    const waiting = runHelper(h, 'b', {}, { owner: 'b' })
    cancelOwned('b')
    await expect(waiting).resolves.toMatchObject({ ok: false, reason: 'cancelled' })
    expect(queuedHelpers()).not.toContain('explainer-wait')
  })

  it('ends a running reading by its owner: its CLI is signalled, and no retry follows', async () => {
    const h = helper({ id: 'explainer-run', attempts: 2 })
    const running = runHelper(h, 'a', {}, { owner: 'mine' })
    await ticks()
    expect(runningHelpers('explainer-run')).toBe(1)
    cancelOwned('mine')
    expect(mocks.spawned[0].kill).toHaveBeenCalledWith('SIGTERM')
    mocks.spawned[0].finish(Object.assign(new Error('killed'), { killed: true }), '', '')
    await expect(running).resolves.toMatchObject({ ok: false, reason: 'cancelled' })
    expect(mocks.spawned).toHaveLength(1)
  })

  it('leaves another owner alone', async () => {
    const h = helper({ id: 'explainer-other' })
    const other = runHelper(h, 'a', {}, { owner: 'theirs' })
    await ticks()
    cancelOwned('mine')
    expect(mocks.spawned[0].kill).not.toHaveBeenCalled()
    mocks.spawned[0].finish(null, 'ok fine', '')
    await expect(other).resolves.toMatchObject({ ok: true, value: 'fine' })
  })
})
