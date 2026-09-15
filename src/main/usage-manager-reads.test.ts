import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clave-usage-reads-'))

vi.mock('electron', () => ({
  app: { getPath: () => dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`),
    decryptString: (buffer: Buffer) => buffer.toString().replace(/^enc:/, '')
  }
}))

// The keychain, answering the machine login's credential after a while: the
// slow read that must never outrank a token's.
vi.mock('child_process', () => ({
  execFile: (
    _file: string,
    _args: string[],
    _opts: unknown,
    cb: (err: null, out: { stdout: string }) => void
  ) => {
    setTimeout(
      () =>
        cb(null, { stdout: JSON.stringify({ claudeAiOauth: { accessToken: 'machine-login' } }) }),
      30
    )
  }
}))

import { claudeAccountsManager } from './claude-accounts'
import { usageManager } from './usage-manager'

const TOKEN = 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123456789'

function response(status: number, headers: Record<string, string>, body = '{}'): Response {
  return new Response(body, { status, headers })
}

beforeEach(() => {
  for (const account of claudeAccountsManager.list()) {
    if (account.id !== 'default') claudeAccountsManager.remove(account.id)
  }
})

/**
 * The paste race, found on the real app: the settings page asks for a new
 * account's usage the instant the account exists, that read goes out on the
 * machine login (there is no token yet) and takes the keychain's time; the
 * token lands a call later and its forced read must answer with the TOKEN's
 * quota, and the slow read must not overwrite it when it finally lands.
 */
describe('a forced read after a token paste', () => {
  it('answers with the token, and the older read is discarded', async () => {
    const calls: string[] = []
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const auth = String((init?.headers as Record<string, string>)?.Authorization ?? '')
      calls.push(`${init?.method ?? 'GET'} ${String(url)} ${auth}`)
      if (String(url).endsWith('/api/oauth/usage')) {
        // The machine login: signed out, as the endpoint says it.
        return response(401, {})
      }
      return response(200, {
        'anthropic-ratelimit-unified-5h-utilization': '0.10',
        'anthropic-ratelimit-unified-5h-status': 'allowed'
      })
    }) as typeof fetch

    const work = claudeAccountsManager.add({ label: 'Work' })
    const updates: string[] = []
    const off = usageManager.onUpdate((id, result) =>
      updates.push(`${id}:${'error' in result ? 'error' : result.windows[0].usedPercentage}`)
    )

    // The settings page's read, before the token exists.
    const early = usageManager.getLimits(work.id)
    // The paste, one call later.
    claudeAccountsManager.setToken(work.id, TOKEN)
    const forced = await usageManager.getLimits(work.id, { force: true })
    expect('error' in forced).toBe(false)
    expect((forced as { windows: { usedPercentage: number }[] }).windows[0].usedPercentage).toBe(10)

    const earlyResult = await early
    expect('error' in earlyResult).toBe(true)

    // The cache and the listeners saw the token's read alone.
    expect(usageManager.snapshot()[work.id]).toEqual(forced)
    expect(updates).toEqual([`${work.id}:10`])
    expect(calls.some((c) => c.startsWith('POST') && c.includes(TOKEN))).toBe(true)
    off()
  })

  it('serves the cache to a plain read and reads live on force', async () => {
    let probes = 0
    globalThis.fetch = vi.fn(async () => {
      probes++
      return response(200, {
        'anthropic-ratelimit-unified-5h-utilization': String(0.1 * probes),
        'anthropic-ratelimit-unified-5h-status': 'allowed'
      })
    }) as typeof fetch
    const play = claudeAccountsManager.add({ label: 'Play' })
    claudeAccountsManager.setToken(play.id, TOKEN)
    const first = await usageManager.getLimits(play.id)
    const again = await usageManager.getLimits(play.id)
    expect(again).toBe(first)
    const live = await usageManager.getLimits(play.id, { force: true })
    expect(live).not.toBe(first)
    expect(probes).toBe(2)
  })

  it('asks Fable first, identified as Claude Code, and reads its weekly cap', async () => {
    const asked: { model: string; agent: string; system: string }[] = []
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string; system: string }
      const headers = init?.headers as Record<string, string>
      asked.push({ model: body.model, agent: headers['user-agent'], system: body.system })
      return response(200, {
        'anthropic-ratelimit-unified-5h-utilization': '0.16',
        'anthropic-ratelimit-unified-7d-utilization': '0.43',
        'anthropic-ratelimit-unified-7d_oi-utilization': '0.74',
        'anthropic-ratelimit-unified-7d_oi-status': 'allowed'
      })
    }) as typeof fetch
    const fable = claudeAccountsManager.add({ label: 'Fable' })
    claudeAccountsManager.setToken(fable.id, TOKEN)
    const result = await usageManager.getLimits(fable.id, { force: true })
    expect(asked).toHaveLength(1)
    expect(asked[0].model).toBe('claude-fable-5-1')
    expect(asked[0].agent).toMatch(/^claude-cli\/\d+\.\d+\.\d+ /)
    expect(asked[0].system).toContain('Claude Code')
    const windows = (result as { windows: { scope: string | null; usedPercentage: number }[] })
      .windows
    expect(windows.map((w) => w.scope)).toEqual([null, null, 'Fable'])
    expect(windows[2].usedPercentage).toBe(74)
  })

  it('falls back to the cheapest model when Fable is refused for the account', async () => {
    // A plan without Fable: the service answers the model with a 400 and no
    // windows; the read then carries what a Haiku probe carries, never an error.
    const asked: string[] = []
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string }
      asked.push(body.model)
      if (body.model.startsWith('claude-fable')) return response(400, {}, '{"type":"error"}')
      return response(200, {
        'anthropic-ratelimit-unified-5h-utilization': '0.2',
        'anthropic-ratelimit-unified-7d-utilization': '0.5'
      })
    }) as typeof fetch
    const plain = claudeAccountsManager.add({ label: 'Plain' })
    claudeAccountsManager.setToken(plain.id, TOKEN)
    const result = await usageManager.getLimits(plain.id, { force: true })
    expect(asked).toEqual(['claude-fable-5-1', 'claude-haiku-4-5-20251001'])
    expect('error' in result).toBe(false)
    expect((result as { windows: unknown[] }).windows).toHaveLength(2)
  })

  it('reads a 429 as the window being out, not as a failed read', async () => {
    globalThis.fetch = vi.fn(async () =>
      response(429, {
        'anthropic-ratelimit-unified-5h-utilization': '1',
        'anthropic-ratelimit-unified-5h-status': 'rejected',
        'anthropic-ratelimit-unified-7d-utilization': '0.6',
        'anthropic-ratelimit-unified-7d-status': 'allowed'
      })
    ) as typeof fetch
    const out = claudeAccountsManager.add({ label: 'Out' })
    claudeAccountsManager.setToken(out.id, TOKEN)
    const result = await usageManager.getLimits(out.id, { force: true })
    expect('error' in result).toBe(false)
    const windows = (result as { windows: { usedPercentage: number; severity: string | null }[] })
      .windows
    expect(windows[0]).toMatchObject({ usedPercentage: 100, severity: 'critical' })
  })

  it('names a refused token', async () => {
    globalThis.fetch = vi.fn(async () => response(401, {})) as typeof fetch
    const bad = claudeAccountsManager.add({ label: 'Bad' })
    claudeAccountsManager.setToken(bad.id, TOKEN)
    const result = await usageManager.getLimits(bad.id, { force: true })
    expect(result).toEqual({
      error: 'This token was refused. Generate a new one with `claude setup-token`.'
    })
  })

  it('forgets a read in flight, so a cleared token’s answer never lands', async () => {
    let release: (() => void) | null = null
    globalThis.fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = () =>
            resolve(
              response(200, {
                'anthropic-ratelimit-unified-5h-utilization': '0.42',
                'anthropic-ratelimit-unified-5h-status': 'allowed'
              })
            )
        })
    ) as typeof fetch
    const gone = claudeAccountsManager.add({ label: 'Forgotten' })
    claudeAccountsManager.setToken(gone.id, TOKEN)
    const updates: string[] = []
    const off = usageManager.onUpdate((id) => updates.push(id))
    const pending = usageManager.getLimits(gone.id, { force: true })
    claudeAccountsManager.clearToken(gone.id)
    usageManager.forget(gone.id)
    release!()
    await pending
    expect(usageManager.snapshot()[gone.id]).toBeUndefined()
    expect(updates).toEqual([])
    off()
  })

  it('polls every account on its clock, only while a window is open, until stopped', async () => {
    vi.useFakeTimers()
    try {
      // The token account's probes alone: the Default's endpoint read (its
      // mocked keychain answers) is on the same tick and is not the subject.
      let reads = 0
      globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === 'POST') reads++
        return response(200, {
          'anthropic-ratelimit-unified-5h-utilization': '0.2',
          'anthropic-ratelimit-unified-5h-status': 'allowed'
        })
      }) as typeof fetch
      const polled = claudeAccountsManager.add({ label: 'Polled' })
      claudeAccountsManager.setToken(polled.id, TOKEN)
      let open = false
      usageManager.startPolling(1_000, () => open)
      await vi.advanceTimersByTimeAsync(6_000)
      const whileClosed = reads
      open = true
      await vi.advanceTimersByTimeAsync(3_000)
      const whileOpen = reads
      usageManager.stopPolling()
      await vi.advanceTimersByTimeAsync(5_000)
      expect(whileClosed).toBe(0)
      expect(whileOpen).toBe(3)
      expect(reads).toBe(whileOpen)
    } finally {
      usageManager.stopPolling()
      vi.useRealTimers()
    }
  })

  it('reports an account that no longer exists', async () => {
    const gone = claudeAccountsManager.add({ label: 'Gone' })
    claudeAccountsManager.remove(gone.id)
    expect(await usageManager.getLimits(gone.id, { force: true })).toEqual({
      error: 'This Claude account no longer exists.'
    })
  })
})
