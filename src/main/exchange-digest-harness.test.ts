import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The harness's stand-in for a digest read. Under --test-no-activate no model
// runs unless a spec asks for the runner, and in this order: the helper's
// preference is read first, so a digest that is switched off never reaches
// the canned reply (PRDCT-4330); a read that goes ahead is journaled where
// this process keeps its data (PRDCT-4327); and its account is resolved as
// the runner resolves it, through the helper's own config (PRDCT-4327). A
// spec with a stub CLI on the PATH sends the digests through the runner
// (CLAVE_E2E_DIGEST_RUNNER=1, PRDCT-4330).

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  accounts: [] as Array<string | undefined>,
  dataDir: ''
}))
vi.mock('electron', () => {
  throw new Error('the exchange digest imported electron')
})
vi.mock('./test-mode', () => ({ TEST_NO_ACTIVATE: true }))
vi.mock('child_process', () => ({ execFile: mocks.execFile }))
vi.mock('./sessions/adapters/pty-backend', () => ({
  getLoginShellEnv: () => ({ PATH: '/bin' }),
  getUserShell: () => '/bin/zsh',
  accountTokenForSpawn: async (_kind: string, id?: string) => {
    mocks.accounts.push(id)
    if (id === 'unknown') throw new Error('The selected Claude account is no longer available.')
    return undefined
  }
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
vi.mock('./ports', () => ({
  settingsPorts: () => ({
    storage: {
      pathOf: (name: string) => (mocks.dataDir ? `${mocks.dataDir}/${name}` : '/dev/null')
    }
  })
}))
vi.mock('./exchange-digest-store', () => ({
  DigestStore: class {
    of(): Record<string, unknown> {
      return {}
    }
    get(): undefined {
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
const ACCOUNT_REPLY = JSON.stringify({
  needs_you: false,
  message: null,
  summary: 'Read on {account}.'
})
const WORK_REPLY = JSON.stringify({ title: 'Read the files', needs_you: false, note: null })
let n = 0
const request = (
  launch: { claudeProfileId?: string } = {}
): {
  sessionId: string
  key: string
  launch: { claudeProfileId?: string }
  messages: Array<{ from: string; text: string }>
} => ({
  sessionId: `s${++n}`,
  key: `k${n}`,
  launch,
  messages: [{ from: 'Verifier', text: 'Done.' }]
})
const workRequest = (): Parameters<typeof requestWorkDigest>[0] => ({
  sessionId: `w${++n}`,
  key: `w${n}`,
  launch: {},
  notes: ['a'],
  tools: 0
})

/** A runner call that answers REPLY, as the stub CLI of a spec would. */
const stubCli = (): void => {
  mocks.execFile.mockImplementation(
    (_f: string, _a: string[], _o: unknown, done: (e: null, out: string, err: string) => void) => {
      setTimeout(() => done(null, REPLY, ''), 0)
      return {
        stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn() },
        kill: vi.fn(),
        once: vi.fn()
      }
    }
  )
}

/** The reads this process journaled, as a spec reads e2e-digest-reads.jsonl. */
const journaled = (): Array<{ kind: string; sessionId: string; key: string }> => {
  const file = path.join(mocks.dataDir, 'e2e-digest-reads.jsonl')
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

beforeAll(() => {
  mocks.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clave-digest-harness-'))
})
afterAll(() => {
  fs.rmSync(mocks.dataDir, { recursive: true, force: true })
})
beforeEach(() => {
  process.env.CLAVE_E2E_DIGEST_REPLY = REPLY
  process.env.CLAVE_E2E_WORK_DIGEST_REPLY = WORK_REPLY
  mocks.execFile.mockReset()
  fs.rmSync(path.join(mocks.dataDir, 'e2e-digest-reads.jsonl'), { force: true })
})
afterEach(() => {
  delete process.env.CLAVE_E2E_DIGEST_REPLY
  delete process.env.CLAVE_E2E_WORK_DIGEST_REPLY
  delete process.env.CLAVE_E2E_DIGEST_RUNNER
  setHelperConfigSource()
  mocks.accounts.length = 0
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
    await expect(requestWorkDigest(workRequest())).resolves.toMatchObject({
      ok: false,
      reason: 'disabled'
    })
  })

  it('with CLAVE_E2E_DIGEST_RUNNER=1 the digest goes through the runner, on the picked model', async () => {
    process.env.CLAVE_E2E_DIGEST_RUNNER = '1'
    setHelperConfigSource(() => ({ model: 'opus' }))
    stubCli()
    await expect(requestDigest(request())).resolves.toMatchObject({ ok: true })
    expect(mocks.execFile.mock.calls[0][1].slice(0, 3)).toEqual(['-p', '--model', 'opus'])
  })
})

describe('the harness journals every read that goes ahead, in the reading process', () => {
  it('an exchange read and a work read on the canned reply are journaled, kind, tab and key', async () => {
    const exchange = request()
    const work = workRequest()
    await expect(requestDigest(exchange)).resolves.toMatchObject({ ok: true })
    await expect(requestWorkDigest(work)).resolves.toMatchObject({ ok: true })
    expect(journaled()).toMatchObject([
      { kind: 'exchange', sessionId: exchange.sessionId, key: exchange.key },
      { kind: 'work', sessionId: work.sessionId, key: work.key }
    ])
  })

  it('a read sent through the runner is journaled too', async () => {
    process.env.CLAVE_E2E_DIGEST_RUNNER = '1'
    stubCli()
    const exchange = request()
    await expect(requestDigest(exchange)).resolves.toMatchObject({ ok: true })
    expect(journaled()).toMatchObject([{ kind: 'exchange', key: exchange.key }])
  })

  it('a digest switched off is no read: nothing journaled', async () => {
    setHelperConfigSource(() => ({ enabled: false }))
    await requestDigest(request())
    await requestWorkDigest(workRequest())
    expect(journaled()).toEqual([])
  })
})

describe('the harness resolves a read’s account as the runner does', () => {
  it('the account chosen for the helper wins over the tab’s', async () => {
    process.env.CLAVE_E2E_DIGEST_REPLY = ACCOUNT_REPLY
    setHelperConfigSource((id) =>
      id === 'exchange-digest' ? { claudeProfileId: 'helper-account' } : undefined
    )
    await expect(requestDigest(request({ claudeProfileId: 'tab-account' }))).resolves.toMatchObject(
      { ok: true }
    )
    expect(mocks.accounts).toEqual(['helper-account'])
  })

  it('the machine login chosen for the helper (null) wins too', async () => {
    process.env.CLAVE_E2E_DIGEST_REPLY = ACCOUNT_REPLY
    setHelperConfigSource(() => ({ claudeProfileId: null }))
    await requestDigest(request({ claudeProfileId: 'unknown' }))
    expect(mocks.accounts).toEqual([undefined])
  })

  it('without a choice, the tab’s account; one this process lacks fails as auth', async () => {
    process.env.CLAVE_E2E_DIGEST_REPLY = ACCOUNT_REPLY
    await expect(requestDigest(request({ claudeProfileId: 'unknown' }))).resolves.toMatchObject({
      ok: false,
      reason: 'auth'
    })
    expect(mocks.accounts).toEqual(['unknown'])
  })

  it('a helper switched off answers disabled, without resolving anything', async () => {
    process.env.CLAVE_E2E_WORK_DIGEST_REPLY = '{"title": "T", "needs_you": false, "note": null}'
    setHelperConfigSource((id) => (id === 'work-digest' ? { enabled: false } : undefined))
    await expect(requestWorkDigest(workRequest())).resolves.toMatchObject({
      ok: false,
      reason: 'disabled'
    })
    expect(mocks.accounts).toEqual([])
  })
})
