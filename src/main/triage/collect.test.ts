import { describe, expect, it } from 'vitest'
import { collectSnapshot } from './collect'
import {
  CHAT_ID,
  CLAUDE_CONVERSATION,
  CODEX_THREAD,
  GENERATED_TITLE,
  HOME,
  MCP_TOKEN,
  SERVER_TOKEN,
  SHELL_TOKEN,
  TERMINAL_ID,
  fakeSources
} from './testing'

const never = <T>(): Promise<T> => new Promise<T>(() => {})

describe('collectSnapshot', () => {
  it('describes a separate server the shell owns, with its terminal process', async () => {
    const s = await collectSnapshot(fakeSources())
    expect(s.server).toMatchObject({
      mode: 'separate',
      ownership: 'shell-child',
      origin: 'http://127.0.0.1:49457',
      serverPid: 1412,
      serverAlive: true,
      version: '2.4.0',
      terminalProcess: { pid: 1483, alive: true, generation: 1, givenUp: null },
      health: { live: 200, ready: 200 }
    })
    expect(s.server.clients).toMatchObject({ status: 'ok', value: [{ kind: 'shell', pid: 725 }] })
    expect(s.mcp).toEqual({ listening: true, origin: 'http://127.0.0.1:51000' })
    expect(s.windows.map((w) => w.id)).toEqual([1, 2])
    expect(s.workspaces).toMatchObject({ status: 'ok', value: [{ id: 'ws-1' }, { id: 'ws-2' }] })
  })

  it('lists terminal and chat sessions across every window', async () => {
    const s = await collectSnapshot(fakeSources())
    expect(s.sessions.status).toBe('ok')
    if (s.sessions.status !== 'ok') return
    expect(s.sessions.value.map((x) => [x.id, x.transport, x.windowKey])).toEqual([
      [TERMINAL_ID, 'pty', 'win-a'],
      [CHAT_ID, 'events', 'win-b']
    ])
    expect(s.windowListings.map((l) => l.status)).toEqual(['ok', 'ok'])
    expect(s.reconciliation).toEqual({
      uiOnly: [],
      serverOnly: [],
      windowMismatch: [],
      recordsWithoutSession: [],
      tmuxWithoutRecord: [],
      complete: true
    })
  })

  it('never carries a token, a generated title, a conversation id or a command', async () => {
    const json = JSON.stringify(await collectSnapshot(fakeSources()))
    for (const leak of [
      SHELL_TOKEN,
      SERVER_TOKEN,
      MCP_TOKEN,
      GENERATED_TITLE,
      CLAUDE_CONVERSATION,
      CODEX_THREAD,
      'sk-live-abcdefghijkl',
      'npm run dev',
      'tester@example.com',
      'abc123456789',
      HOME
    ])
      expect(json, leak).not.toContain(leak)
  })

  it('keeps the label a user gave a tab and drops a generated one', async () => {
    const s = await collectSnapshot(fakeSources())
    if (s.sessions.status !== 'ok' || s.records.status !== 'ok') throw new Error('sources')
    expect(s.sessions.value.find((x) => x.id === TERMINAL_ID)?.userLabel).toBe('Release checklist')
    expect(s.sessions.value.find((x) => x.id === CHAT_ID)?.userLabel).toBeNull()
    const chat = s.records.value.items.find((r) => r.id === CHAT_ID)
    expect(chat).toMatchObject({ kind: 'claude', hasProviderConversation: true, userLabel: null })
    expect(s.records.value.items.find((r) => r.id === TERMINAL_ID)?.kind).toBe('terminal')
  })

  it('scrubs a token quoted back in a source error', async () => {
    const s = await collectSnapshot(
      fakeSources({
        sessions: async () => {
          throw new Error(`401 for Bearer ${SERVER_TOKEN} at ${HOME}/x`)
        }
      })
    )
    expect(s.sessions.status).toBe('error')
    const json = JSON.stringify(s)
    expect(json).not.toContain(SERVER_TOKEN)
    expect(json).not.toContain(HOME)
    expect(s.warnings.some((w) => w.includes('server sessions'))).toBe(true)
  })

  it('answers a partial snapshot when the server hangs, within the deadline', async () => {
    const started = Date.now()
    const s = await collectSnapshot(
      fakeSources({
        sessions: never,
        clients: never,
        windowListings: never,
        health: never,
        isAlive: (pid) => pid !== 1412
      }),
      { sourceTimeoutMs: 100 }
    )
    expect(Date.now() - started).toBeLessThan(2000)
    expect(s.sessions.status).toBe('timeout')
    expect(s.server.clients.status).toBe('timeout')
    expect(s.server.health).toEqual({ live: null, ready: null, readyBody: null })
    expect(s.server.serverAlive).toBe(false)
    expect(s.windowListings.map((l) => l.status)).toEqual(['timeout', 'timeout'])
    expect(s.reconciliation.complete).toBe(false)
    expect(s.warnings.some((w) => w.includes('is not running'))).toBe(true)
    // What main knows by itself is still there.
    expect(s.windows).toHaveLength(2)
    expect(s.records.status).toBe('ok')
  })

  it('reports an attached server as external, version unknown, records not readable', async () => {
    const s = await collectSnapshot(
      fakeSources({
        shellDiscovery: async () => ({
          url: 'http://10.0.0.5:7000',
          token: SHELL_TOKEN,
          mode: 'attached',
          ok: true,
          pid: 725,
          clientId: 'c'
        })
      })
    )
    expect(s.server).toMatchObject({
      mode: 'attached',
      ownership: 'external',
      version: 'unknown',
      serverPid: null,
      serverAlive: null,
      terminalProcess: null
    })
    expect(s.records.status).toBe('unavailable')
    expect(s.paths.serverData).toBeNull()
  })

  it('reports an in-process server as the shell process itself', async () => {
    const s = await collectSnapshot(
      fakeSources({
        shellDiscovery: async () => ({
          url: 'http://127.0.0.1:5000',
          token: SHELL_TOKEN,
          mode: 'in-process',
          ok: true,
          pid: 725,
          clientId: 'c'
        })
      })
    )
    expect(s.server).toMatchObject({
      mode: 'in-process',
      ownership: 'shell-process',
      serverPid: 725,
      serverAlive: true,
      terminalProcess: null
    })
    expect(s.paths.sessionRecords).toBe('~/Library/Application Support/Clave/session-records')
  })

  it('does not trust a discovery file another shell wrote', async () => {
    const s = await collectSnapshot(
      fakeSources({
        shellDiscovery: async () => ({
          url: 'http://127.0.0.1:1',
          token: SHELL_TOKEN,
          mode: 'separate',
          ok: true,
          pid: 999,
          serverPid: 1000
        })
      })
    )
    expect(s.server.mode).toBe('unknown')
    expect(s.server.discoveryShellPid).toBe(999)
    expect(s.warnings.some((w) => w.includes('pid 999'))).toBe(true)
  })

  it('names the disagreements between the server, the windows, records and tmux', async () => {
    const ghost = '33333333-3333-4333-8333-333333333333'
    const s = await collectSnapshot(
      fakeSources({
        sessions: async () => [
          {
            id: TERMINAL_ID,
            provider: 'terminal',
            transport: 'pty',
            cwd: '/',
            windowKey: 'win-b',
            state: 'idle',
            createdAt: 1,
            adapterId: 'pty',
            title: ''
          },
          {
            id: ghost,
            provider: 'terminal',
            transport: 'pty',
            cwd: '/',
            windowKey: 'win-a',
            state: 'idle',
            createdAt: 1,
            adapterId: 'pty',
            title: ''
          }
        ],
        tmuxSessions: async () => [`clave-${TERMINAL_ID}`, 'clave-orphan', 'not-clave']
      })
    )
    expect(s.reconciliation).toEqual({
      uiOnly: [CHAT_ID],
      serverOnly: [ghost],
      windowMismatch: [TERMINAL_ID],
      recordsWithoutSession: [CHAT_ID],
      tmuxWithoutRecord: ['clave-orphan'],
      complete: true
    })
  })

  it('does not call a hidden or group-terminal session an orphan', async () => {
    const serving = '44444444-4444-4444-8444-444444444444'
    const groupTerm = '55555555-5555-4555-8555-555555555555'
    const base = fakeSources()
    const s = await collectSnapshot(
      fakeSources({
        sessions: async () => [
          ...(await base.sessions()),
          {
            id: serving,
            provider: 'terminal',
            transport: 'pty',
            cwd: '/',
            windowKey: 'win-a',
            state: 'idle',
            createdAt: 1,
            adapterId: 'pty',
            title: ''
          },
          {
            id: groupTerm,
            provider: 'terminal',
            transport: 'pty',
            cwd: '/',
            windowKey: 'win-a',
            state: 'idle',
            createdAt: 1,
            adapterId: 'pty',
            title: ''
          }
        ],
        records: async () => {
          const r = await base.records('', 10)
          return {
            total: 3,
            files: [
              ...r.files,
              {
                key: serving,
                content: {
                  id: serving,
                  cwd: '/',
                  claudeMode: false,
                  link: { kind: 'session-view', ownerId: TERMINAL_ID }
                }
              }
            ]
          }
        },
        windowListings: async () => {
          const l = await base.windowListings(100)
          const first = l[0].result as { groups: { terminals: unknown[] }[] }
          first.groups[0].terminals = [
            { id: 't', sessionId: groupTerm, command: 'SECRET=x npm start' }
          ]
          return l
        }
      })
    )
    expect(s.reconciliation.serverOnly).toEqual([])
    expect(JSON.stringify(s)).not.toContain('npm start')
  })

  it('cuts lists at their limit and says so', async () => {
    const many = Array.from({ length: 7 }, (_, i) => ({
      id: `id-${i}`,
      provider: 'terminal',
      transport: 'pty',
      cwd: '/',
      windowKey: 'win-a',
      state: 'idle',
      createdAt: i,
      adapterId: 'pty',
      title: ''
    }))
    const s = await collectSnapshot(fakeSources({ sessions: async () => many }), { maxSessions: 3 })
    expect(s.sessions.status === 'ok' && s.sessions.value.length).toBe(3)
    expect(s.limits.truncated).toContain('sessions')
    expect(s.reconciliation.complete).toBe(false)
  })

  it('keeps only Clave mode flags as the sources give them, and redacts their values', async () => {
    const base = fakeSources()
    const s = await collectSnapshot(
      fakeSources({
        app: () => ({ ...base.app(), flags: ['--dev-x', `--test-token=${SHELL_TOKEN}`] })
      })
    )
    expect(s.app.flags[0]).toBe('--dev-x')
    expect(s.app.flags[1]).not.toContain(SHELL_TOKEN)
  })
})
