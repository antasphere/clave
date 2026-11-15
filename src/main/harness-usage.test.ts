import { describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { harnessUsageText, signInUsageOf } from '@clave/contract/settings/harness-usage-view'
import {
  HarnessUsage,
  billingOf,
  companyOfProvider,
  harnessUsageRows,
  piSessionRoots,
  signInBilling
} from './harness-usage'
import { scanPiSessionFile } from './pi-usage'
import { parseSessionExport, parseSessionPage, OpencodeSessionRecords } from './opencode-usage'
import type { LedgerLine, UsageRecord } from './usage-attribution'

const NOW = new Date(2026, 10, 14, 18, 0, 0)
const AT = new Date(2026, 10, 14, 10, 0, 0).getTime()

describe('the rows each place reads (PRDCT-4551)', () => {
  it('bills a plan and a local model with no cost, what Clave knows to be per use with one, the unknown with none', () => {
    expect(billingOf('moonshot')).toBe('plan')
    expect(billingOf('zai')).toBe('plan')
    expect(billingOf('ollama')).toBe('local')
    // Pay per use, a balance, a limit, a spent amount.
    expect(billingOf('mistral')).toBe('payPerUse')
    expect(billingOf('generic')).toBe('payPerUse')
    expect(billingOf('deepseek')).toBe('payPerUse')
    expect(billingOf('openrouter')).toBe('payPerUse')
    expect(billingOf('vercel-ai-gateway')).toBe('payPerUse')
    expect(billingOf(null)).toBe('signIn')
    expect(billingOf('anthropic')).toBe('signIn')
  })

  // The coordinator's point 4: the sign-in's line as true as a connection's.
  it("says a sign-in's cost only when every record of the range was on a provider billed per use", () => {
    expect(signInBilling(['deepseek'], 'pi')).toBe('payPerUse')
    expect(signInBilling(['deepseek', 'deepseek'], 'opencode')).toBe('payPerUse')
    // A plan (Pi's own Kimi), an unknown provider, a mix, a record naming
    // none, or nothing at all: no cost.
    expect(signInBilling(['kimi-coding'], 'pi')).toBe('signIn')
    expect(signInBilling(['anthropic'], 'pi')).toBe('signIn')
    expect(signInBilling(['deepseek', 'kimi-coding'], 'pi')).toBe('signIn')
    expect(signInBilling([null], 'pi')).toBe('signIn')
    expect(signInBilling([], 'pi')).toBe('signIn')
    expect(companyOfProvider('kimi-code-plan-global', 'opencode')).toBe('moonshot')
    expect(companyOfProvider('kimi-coding', 'pi')).toBe('moonshot')
    expect(companyOfProvider('stand-in', 'pi')).toBeUndefined()
    // The rows use it for the sign-in, over the records of the range alone.
    const rec = (provider: string, at: number): UsageRecord => ({
      harness: 'pi',
      sessionId: 'mine',
      at,
      provider,
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: 0.5
    })
    const signInOf = (records: UsageRecord[], range: 'today' | 'all'): string | undefined =>
      signInUsageOf(
        harnessUsageRows({
          range,
          now: NOW,
          ledger: [
            {
              harness: 'pi',
              sessionId: 'mine',
              connectionId: null,
              label: null,
              company: null,
              at: 0
            }
          ],
          records,
          connections: () => []
        }),
        'pi'
      )?.billing
    const longAgo = new Date(2026, 0, 1).getTime()
    const records = [rec('deepseek', AT), rec('kimi-coding', longAgo)]
    expect(signInOf(records, 'today')).toBe('payPerUse')
    expect(signInOf(records, 'all')).toBe('signIn')
  })

  it('lists every current connection, the sign-in, and a removed connection under its recorded label', () => {
    const ledger: LedgerLine[] = [
      {
        harness: 'pi',
        sessionId: 'a',
        connectionId: 'kimi-a',
        label: 'Kimi A',
        company: 'moonshot',
        at: AT - 1
      },
      {
        harness: 'pi',
        sessionId: 'g',
        connectionId: 'gone',
        label: 'Old DeepSeek',
        company: 'deepseek',
        at: AT - 1
      },
      // A tab Clave started on no connection.
      {
        harness: 'pi',
        sessionId: 'mine',
        connectionId: null,
        label: null,
        company: null,
        at: AT - 1
      }
    ]
    const record = (over: Partial<UsageRecord>): UsageRecord => ({
      harness: 'pi',
      sessionId: 'a',
      at: AT,
      provider: 'kimi-coding',
      input: 100,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 120,
      cost: 0.5,
      ...over
    })
    const view = harnessUsageRows({
      range: 'today',
      now: NOW,
      ledger,
      records: [
        record({}),
        record({ sessionId: 'g', provider: 'deepseek', totalTokens: 40, cost: 0.02 }),
        record({ sessionId: 'mine', provider: 'anthropic', totalTokens: 7 }),
        record({ sessionId: 'outside', provider: 'anthropic', totalTokens: 5 })
      ],
      connections: (harness) =>
        harness === 'pi'
          ? [
              { id: 'kimi-a', label: 'Kimi A', company: 'moonshot' },
              { id: 'kimi-b', label: 'Kimi B', company: 'moonshot' }
            ]
          : [{ id: 'kimi-a', label: 'Kimi A', company: 'moonshot' }]
    })
    const pi = view.rows.filter((r) => r.harness === 'pi')
    expect(pi.map((r) => [r.label, r.billing, r.removed, r.totalTokens, !!r.other])).toEqual([
      ['Kimi A', 'plan', false, 120, false],
      ['Kimi B', 'plan', false, 0, false],
      ['Pi sign-in', 'signIn', false, 7, false],
      // A session the ledger does not know (PRDCT-4551): its own row, never
      // the sign-in, and never what the sign-in's line or a launcher reads.
      ['Other sessions', 'signIn', false, 5, true],
      ['Old DeepSeek', 'payPerUse', true, 40, false]
    ])
    expect(signInUsageOf(view, 'pi')?.totalTokens).toBe(7)
    expect(view.rows.filter((r) => r.harness === 'opencode').map((r) => r.label)).toEqual([
      'Kimi A',
      'OpenCode sign-in'
    ])
    // What each kind of connection shows, by the one line.
    const [kimiA, , signIn, other, gone] = pi
    expect(harnessUsageText(other, other.billing, 'today')).toBe('1 request · 5 tokens today')
    expect(harnessUsageText(kimiA, kimiA.billing, 'today')).toBe('1 request · 120 tokens today')
    expect(harnessUsageText(gone, gone.billing, 'today')).toBe('40 tokens · $0.02 today')
    // The sign-in's record was on a provider Clave does not know: no cost.
    expect(harnessUsageText(signIn, signIn.billing, 'today')).toBe('1 request · 7 tokens today')
  })

  it('says OpenCode is unavailable when it is not here, and still counts Pi', async () => {
    const usage = new HarnessUsage({
      ledger: () => [],
      piRoots: () => [],
      opencode: () => null,
      connections: () => [],
      now: () => NOW
    })
    const view = await usage.read('today')
    expect(view.unavailable).toEqual([
      { harness: 'opencode', reason: 'OpenCode is not installed here.' }
    ])
    expect(view.rows.map((r) => r.label)).toEqual(['Pi sign-in', 'OpenCode sign-in'])
  })
})

describe("Pi's records, as Pi 1.5.2 writes them", () => {
  it('reads each usage with its session and provider, a compaction under the provider in force', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clave-pi-usage-'))
    try {
      const file = path.join(
        dir,
        '2026-11-14T14-38-05-900Z_11111111-2222-4333-8444-555555555555.jsonl'
      )
      const lines = [
        {
          type: 'session',
          version: 3,
          id: '11111111-2222-4333-8444-555555555555',
          timestamp: '2026-11-14T14:38:05.900Z',
          cwd: '/w'
        },
        {
          type: 'model_change',
          id: 'e1',
          parentId: null,
          timestamp: '2026-11-14T14:38:05.944Z',
          provider: 'stubco',
          modelId: 'stub-model'
        },
        {
          type: 'message',
          id: 'b9',
          parentId: 'e1',
          timestamp: '2026-11-14T14:38:05.997Z',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Hello from the stub.' }],
            api: 'openai-completions',
            provider: 'stubco',
            model: 'stub-model',
            usage: {
              input: 103,
              output: 7,
              cacheRead: 20,
              cacheWrite: 0,
              reasoning: 0,
              totalTokens: 130,
              cost: {
                input: 0.000103,
                output: 0.000014,
                cacheRead: 0.00001,
                cacheWrite: 0,
                total: 0.000127
              }
            },
            stopReason: 'stop',
            timestamp: 1794667085972
          }
        },
        {
          type: 'compaction',
          id: 'c1',
          parentId: 'b9',
          timestamp: '2026-11-14T14:40:00.000Z',
          summary: 's',
          firstKeptEntryId: 'b9',
          usage: {
            input: 50,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 55,
            cost: { total: 0.001 }
          }
        },
        {
          type: 'usage',
          id: 'u1',
          parentId: 'c1',
          timestamp: '2026-11-14T14:41:00.000Z',
          kind: 'cache_warm',
          provider: 'other',
          model: 'm',
          usage: {
            input: 0,
            output: 0,
            cacheRead: 9,
            cacheWrite: 0,
            totalTokens: 9,
            cost: { total: 0 }
          }
        }
      ]
      fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
      const records = scanPiSessionFile(file)
      expect(records.map((r) => [r.sessionId, r.provider, r.totalTokens, r.cost])).toEqual([
        ['11111111-2222-4333-8444-555555555555', 'stubco', 130, 0.000127],
        ['11111111-2222-4333-8444-555555555555', 'stubco', 55, 0.001],
        ['11111111-2222-4333-8444-555555555555', 'other', 9, 0]
      ])
      expect(records[0].at).toBe(Date.parse('2026-11-14T14:38:05.997Z'))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("reads the person's folder and each connection folder of its own, never a linked one twice", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clave-pi-roots-'))
    try {
      const home = path.join(dir, 'home')
      const conns = path.join(dir, 'pi-connections')
      fs.mkdirSync(path.join(home, 'sessions'), { recursive: true })
      fs.mkdirSync(path.join(conns, 'own', 'sessions'), { recursive: true })
      fs.mkdirSync(path.join(conns, 'linked'), { recursive: true })
      fs.symlinkSync(path.join(home, 'sessions'), path.join(conns, 'linked', 'sessions'))
      const roots = piSessionRoots({
        override: undefined,
        homeAgentDir: () => home,
        connectionsRoot: conns,
        testMode: false
      })
      expect(roots).toEqual([path.join(home, 'sessions'), path.join(conns, 'own', 'sessions')])
      // Under the test flag, the person's own folder only when a spec names one.
      expect(
        piSessionRoots({
          override: undefined,
          homeAgentDir: () => home,
          connectionsRoot: conns,
          testMode: true
        })
      ).toEqual([path.join(conns, 'own', 'sessions')])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("OpenCode's records, as OpenCode 2.3.0 answers them", () => {
  // The shape of `opencode session export --standalone <id>` on the real
  // program against a stand-in endpoint, 14 November 2026 (values made up).
  const exported = {
    info: {
      id: 'ses_e25814e9dffeR7V70TG8uC9soo',
      cost: 0,
      tokens: { input: 206, output: 14, reasoning: 0, cache: { read: 40, write: 0 } }
    },
    messages: [
      { id: 'msg_1', time: { created: 1794667098622 }, text: 'Say hello', files: [], type: 'user' },
      {
        id: 'msg_2',
        time: { created: 1794667098633, completed: 1794667098646 },
        type: 'assistant',
        model: { id: 'stub-model', providerID: 'clave-stub' },
        cost: 0.25,
        tokens: { input: 103, output: 7, reasoning: 3, cache: { read: 20, write: 1 } }
      },
      { id: 'msg_3', time: { created: 1794667098649 }, type: 'idle', outcome: 'succeeded' }
    ]
  }

  it('reads one record per assistant message, with its provider', () => {
    expect(parseSessionExport(JSON.stringify(exported))).toEqual({
      sessionId: 'ses_e25814e9dffeR7V70TG8uC9soo',
      records: [
        {
          at: 1794667098646,
          provider: 'clave-stub',
          input: 103,
          output: 10,
          cacheRead: 20,
          cacheWrite: 1,
          totalTokens: 134,
          cost: 0.25
        }
      ]
    })
  })

  it('lists the sessions of every project, a child under its parent', () => {
    expect(
      parseSessionPage(
        JSON.stringify({
          data: [
            { id: 'ses_a', time: { created: 1, updated: 5 } },
            { id: 'ses_b', parentID: 'ses_a', time: { created: 2, updated: 6 } },
            { id: '../bad', time: { updated: 1 } }
          ],
          cursor: { next: 'abc' }
        })
      )
    ).toEqual({
      sessions: [
        { id: 'ses_a', updated: 5, parentId: null },
        { id: 'ses_b', updated: 6, parentId: 'ses_a' }
      ],
      next: 'abc'
    })
  })

  it('exports a session again only when it changed, and counts a child as its root', async () => {
    const calls: string[][] = []
    let updated = 10
    const run = async (args: string[]): Promise<string> => {
      calls.push(args)
      if (args[0] === 'api')
        return JSON.stringify({
          data: [
            { id: 'ses_root', time: { updated } },
            { id: 'ses_child', parentID: 'ses_root', time: { updated: 10 } }
          ]
        })
      return JSON.stringify({ ...exported, info: { id: args[3] } })
    }
    const reader = new OpencodeSessionRecords(run, 2)
    const first = await reader.read(0)
    expect(first.map((r) => r.sessionId)).toEqual(['ses_root', 'ses_root'])
    expect(calls.filter((c) => c[0] === 'session')).toHaveLength(2)
    expect(calls[0]).toEqual(['api', '--standalone', 'GET', '/api/session?limit=200&order=desc'])
    await reader.read(0)
    expect(calls.filter((c) => c[0] === 'session')).toHaveLength(2)
    updated = 11
    await reader.read(0)
    expect(calls.filter((c) => c[0] === 'session').map((c) => c[3])).toEqual([
      'ses_root',
      'ses_child',
      'ses_root'
    ])
    // A session last changed before the range is not exported for it.
    const fresh = new OpencodeSessionRecords(run, 1)
    await fresh.read(1000)
    expect(calls.filter((c) => c[0] === 'session')).toHaveLength(3)
  })

  // PRDCT-4551, the coordinator's point 2: only the sessions a range can
  // concern are exported; "all" alone walks everything; paging by cursor.
  it('exports, for today, only the sessions updated today, across every page; all of them for all', async () => {
    const NOW_MS = new Date(2026, 10, 14, 18).getTime()
    const today = new Date(2026, 10, 14).getTime()
    const day = 24 * 60 * 60 * 1000
    // 450 sessions over three pages, newest first: 30 updated today.
    const sessions = Array.from({ length: 450 }, (_, i) => ({
      id: `ses_${String(i).padStart(4, '0')}`,
      time: { updated: i < 30 ? NOW_MS - i * 60_000 : today - (i - 29) * day }
    }))
    const exported: string[] = []
    const pages: string[] = []
    const run = async (args: string[]): Promise<string> => {
      if (args[0] === 'api') {
        const url = args[3]
        pages.push(url)
        const cursor = Number(/cursor=(\d+)/.exec(url)?.[1] ?? 0)
        const page = sessions.slice(cursor, cursor + 200)
        const next = cursor + 200 < sessions.length ? String(cursor + 200) : undefined
        return JSON.stringify({ data: page, cursor: next ? { next } : {} })
      }
      exported.push(args[3])
      return JSON.stringify({ info: { id: args[3] }, messages: [] })
    }
    const usage = new HarnessUsage({
      ledger: () => [],
      piRoots: () => [],
      opencode: () => {
        const reader = new OpencodeSessionRecords(run, 4)
        return (since) => reader.read(since)
      },
      connections: () => [],
      now: () => new Date(NOW_MS)
    })
    await usage.read('today')
    expect(pages).toHaveLength(3)
    expect(pages[1]).toContain('cursor=200')
    expect(exported.sort()).toEqual(sessions.slice(0, 30).map((s) => s.id))
    exported.length = 0
    await usage.read('7d')
    expect(exported).toHaveLength(36)
  })

  // The coordinator's point 3: the answer never waits on OpenCode's long read.
  it('answers within its budget with the records last read, says OpenCode is still read, and fills in after', async () => {
    let release: () => void = () => undefined
    let gated = false
    const record = {
      sessionId: 's',
      at: new Date(2026, 10, 14, 10).getTime(),
      provider: 'p',
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: 0
    }
    const usage = new HarnessUsage({
      // A tab Clave started on no connection: its records are the sign-in's.
      ledger: () => [
        {
          harness: 'opencode',
          sessionId: 's',
          connectionId: null,
          label: null,
          company: null,
          at: 0
        }
      ],
      piRoots: () => [],
      opencode: () => async () => {
        if (gated) await new Promise<void>((r) => (release = r))
        return [record]
      },
      connections: () => [],
      now: () => NOW,
      opencodeWaitMs: 20
    })
    const signIn = (v: Awaited<ReturnType<typeof usage.read>>): number | undefined =>
      v.rows.find((r) => r.harness === 'opencode' && r.connectionId === null)?.requests
    const first = await usage.read('today')
    expect(first.reading).toEqual([])
    expect(signIn(first)).toBe(1)
    gated = true
    const started = Date.now()
    const waiting = await usage.read('all')
    expect(Date.now() - started).toBeLessThan(1000)
    expect(waiting.reading).toEqual(['opencode'])
    // What was read before, never nothing.
    expect(signIn(waiting)).toBe(1)
    release()
    gated = false
    await new Promise((r) => setTimeout(r, 5))
    const done = await usage.read('all')
    expect(done.reading).toEqual([])
  })

  it('a wider range asked while a narrower read runs gets the wider read, never the narrower one', async () => {
    const calls: number[] = []
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => (release = r))
    const usage = new HarnessUsage({
      ledger: () => [],
      piRoots: () => [],
      opencode: () => async (since) => {
        calls.push(since)
        if (calls.length === 1) await gate
        return []
      },
      connections: () => [],
      now: () => NOW
    })
    const narrow = usage.read('today')
    const sameNarrow = usage.read('today')
    const wide = usage.read('all')
    release()
    await Promise.all([narrow, sameNarrow, wide])
    expect(calls).toEqual([new Date(2026, 10, 14).getTime(), 0])
  })
})
