import { describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { harnessUsageText } from '@clave/contract/settings/harness-usage-view'
import { HarnessUsage, billingOf, harnessUsageRows, piSessionRoots } from './harness-usage'
import { scanPiSessionFile } from './pi-usage'
import { parseSessionExport, parseSessionPage, OpencodeSessionRecords } from './opencode-usage'
import type { LedgerLine, UsageRecord } from './usage-attribution'

const NOW = new Date(2026, 10, 14, 18, 0, 0)
const AT = new Date(2026, 10, 14, 10, 0, 0).getTime()

describe('the rows each place reads (PRDCT-4551)', () => {
  it('bills a plan and a local model with no cost, everything else per use', () => {
    expect(billingOf('moonshot')).toBe('plan')
    expect(billingOf('zai')).toBe('plan')
    expect(billingOf('ollama')).toBe('local')
    expect(billingOf('deepseek')).toBe('payPerUse')
    expect(billingOf('mistral')).toBe('payPerUse')
    expect(billingOf(null)).toBe('payPerUse')
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
        record({ sessionId: 'mine', provider: 'anthropic', totalTokens: 7 })
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
    expect(pi.map((r) => [r.label, r.billing, r.removed, r.totalTokens])).toEqual([
      ['Kimi A', 'plan', false, 120],
      ['Kimi B', 'plan', false, 0],
      ['Pi sign-in', 'signIn', false, 7],
      ['Old DeepSeek', 'payPerUse', true, 40]
    ])
    expect(view.rows.filter((r) => r.harness === 'opencode').map((r) => r.label)).toEqual([
      'Kimi A',
      'OpenCode sign-in'
    ])
    // What each kind of connection shows, by the one line.
    const [kimiA, , signIn, gone] = pi
    expect(harnessUsageText(kimiA, kimiA.billing, 'today')).toBe('1 request · 120 tokens today')
    expect(harnessUsageText(gone, gone.billing, 'today')).toBe('40 tokens · $0.02 today')
    expect(harnessUsageText(signIn, signIn.billing, 'today')).toBe('7 tokens · $0.50 today')
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
})
