import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Under the end-to-end harness (PRDCT-4330): a digest that is switched off
// never reaches the canned reply, the preference is read first; and a spec
// with a stub CLI on the PATH can send the digests through the runner.

const mocks = vi.hoisted(() => ({ execFile: vi.fn() }))
vi.mock('electron', () => {
  throw new Error('the exchange digest imported electron')
})
vi.mock('./test-mode', () => ({ TEST_NO_ACTIVATE: true }))
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
    get(): unknown {
      return undefined
    }
    put(): void {
      /* nothing filed */
    }
    flush(): void {
      /* nothing buffered */
    }
  }
}))

import { requestDigest, requestWorkDigest } from './exchange-digest'
import { setHelperConfigSource } from './helpers/registry'

const REPLY = JSON.stringify({ needs_you: false, message: null, summary: 'All quiet.' })
const WORK_REPLY = JSON.stringify({ title: 'Read the files' })
let n = 0
const request = (): {
  sessionId: string
  key: string
  launch: Record<string, never>
  messages: Array<{ from: string; text: string }>
} => ({
  sessionId: 's',
  key: `k${++n}`,
  launch: {},
  messages: [{ from: 'Verifier', text: 'Done.' }]
})

beforeEach(() => {
  process.env.CLAVE_E2E_DIGEST_REPLY = REPLY
  process.env.CLAVE_E2E_WORK_DIGEST_REPLY = WORK_REPLY
  mocks.execFile.mockReset()
})
afterEach(() => {
  delete process.env.CLAVE_E2E_DIGEST_REPLY
  delete process.env.CLAVE_E2E_WORK_DIGEST_REPLY
  delete process.env.CLAVE_E2E_DIGEST_RUNNER
  setHelperConfigSource()
})

describe('the harness reads the preference before its reply', () => {
  it('an exchange digest switched off says so, the canned reply unread', async () => {
    setHelperConfigSource((id) => (id === 'exchange-digest' ? { enabled: false } : undefined))
    await expect(requestDigest(request())).resolves.toEqual({
      ok: false,
      error: 'Switched off in Settings › Helpers (Exchange digests).',
      reason: 'disabled'
    })
    setHelperConfigSource()
    await expect(requestDigest(request())).resolves.toMatchObject({
      ok: true,
      summary: 'All quiet.'
    })
  })

  it('a work digest switched off says so too', async () => {
    setHelperConfigSource((id) => (id === 'work-digest' ? { enabled: false } : undefined))
    await expect(
      requestWorkDigest({
        sessionId: 's',
        key: `w${++n}`,
        launch: {},
        notes: ['a'],
        tools: []
      } as never)
    ).resolves.toMatchObject({ ok: false, reason: 'disabled' })
  })

  it('with CLAVE_E2E_DIGEST_RUNNER=1 the digest goes through the runner, on the picked model', async () => {
    process.env.CLAVE_E2E_DIGEST_RUNNER = '1'
    setHelperConfigSource(() => ({ model: 'opus' }))
    mocks.execFile.mockImplementation(
      (
        _f: string,
        _a: string[],
        _o: unknown,
        done: (e: null, out: string, err: string) => void
      ) => {
        setTimeout(() => done(null, REPLY, ''), 0)
        return {
          stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn() },
          kill: vi.fn(),
          once: vi.fn()
        }
      }
    )
    await expect(requestDigest(request())).resolves.toMatchObject({ ok: true })
    expect(mocks.execFile.mock.calls[0][1].slice(0, 3)).toEqual(['-p', '--model', 'opus'])
  })
})
