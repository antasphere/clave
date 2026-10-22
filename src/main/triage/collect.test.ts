import { describe, expect, it } from 'vitest'
import { resourceKey } from '@clave/contract/fleet'
import { collectSnapshot, typedSnapshotField, type TriageSources } from './collect'
import { problemCount } from './context'
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
    expect(s.server.health).toEqual({
      live: null,
      ready: null,
      readyBody: null,
      liveError: 'timeout: GET /health/live did not answer within 100 ms',
      readyError: 'timeout: GET /health/ready did not answer within 100 ms'
    })
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

  // ── Round 1 verifier findings (VA-1…VA-4), pinned ──

  it('VA-1: sets a stale discovery file aside whole and asks the live server', async () => {
    const asked: string[] = []
    const s = await collectSnapshot(
      fakeSources({
        shellDiscovery: async () => ({
          url: 'http://127.0.0.1:56205',
          token: SHELL_TOKEN,
          mode: 'separate',
          ok: false,
          error: 'another instance failed',
          pid: 999,
          clientId: 'other-client',
          serverPid: 1000
        }),
        endpoint: () => ({ url: 'http://127.0.0.1:56155', mode: 'in-process' }),
        health: async (origin, path) => {
          asked.push(`${origin}${path}`)
          return { status: 200, body: 'ok' }
        }
      })
    )
    expect(asked.sort()).toEqual([
      'http://127.0.0.1:56155/health/live',
      'http://127.0.0.1:56155/health/ready'
    ])
    expect(s.server).toMatchObject({
      origin: 'http://127.0.0.1:56155',
      mode: 'in-process',
      discoveryShellPid: 999,
      discoveryOk: null,
      discoveryError: null,
      clientId: null,
      serverPid: 725
    })
    expect(JSON.stringify(s)).not.toContain('56205')
    expect(s.warnings.some((w) => w.includes('another instance failed'))).toBe(false)
  })

  it('VA-1: prefers the address the shell uses over the one its own discovery file names', async () => {
    const s = await collectSnapshot(
      fakeSources({ endpoint: () => ({ url: 'http://127.0.0.1:60001', mode: 'attached' }) })
    )
    expect(s.server.origin).toBe('http://127.0.0.1:60001')
    expect(s.warnings.some((w) => w.includes('http://127.0.0.1:49457'))).toBe(true)
  })

  it('VA-2: bounds nested inventories and reports every cut', async () => {
    const ids = (p: string): string[] => Array.from({ length: 8 }, (_, i) => `${p}-${i}`)
    const clients = Array.from({ length: 6 }, (_, i) => ({
      id: `c-${i}`,
      kind: 'shell',
      name: 'x',
      registeredAt: i
    }))
    const base = fakeSources()
    const s = await collectSnapshot(
      fakeSources({
        clients: async () => clients,
        windows: () => base.windows().map((w) => ({ ...w, boundSessionIds: ids(`bound-${w.id}`) })),
        windowListings: async () => [
          {
            windowId: 1,
            ok: true,
            result: {
              sessions: [],
              groups: [
                {
                  id: 'g',
                  name: 'G',
                  sessionIds: ids('member'),
                  terminals: ids('term').map((sessionId) => ({ id: sessionId, sessionId }))
                }
              ]
            }
          },
          { windowId: 2, ok: true, result: { sessions: [], groups: [] } }
        ]
      }),
      { maxSessions: 3, maxOther: 4 }
    )
    const listing = s.windowListings[0]
    if (listing.status !== 'ok') throw new Error('listing')
    expect(listing.value.groups[0].sessionIds).toHaveLength(3)
    expect(listing.value.groups[0].terminalSessionIds).toHaveLength(3)
    expect(listing.value.groups[0].terminalCount).toBe(8)
    expect(s.server.clients.status === 'ok' && s.server.clients.value).toHaveLength(4)
    expect(s.windows.every((w) => w.boundSessionIds.length === 3)).toBe(true)
    expect(s.limits.truncated).toEqual(
      expect.arrayContaining(['windowListings', 'server clients', 'window bound sessions'])
    )
    expect(s.reconciliation.complete).toBe(false)
    expect(s.warnings.some((w) => w.startsWith('Cut at their limit'))).toBe(true)
  })

  it('VA-3: lists record files it could not read and calls the comparison partial', async () => {
    const base = fakeSources()
    const s = await collectSnapshot(
      fakeSources({
        records: async () => {
          const r = await base.records('', 10)
          return {
            total: 4,
            files: [
              ...r.files,
              { key: 'zz-malformed', content: null, error: 'zz-malformed.json is not valid JSON' },
              { key: 'zz-no-cwd', content: { id: 'x' } }
            ]
          }
        }
      })
    )
    if (s.records.status !== 'ok') throw new Error('records')
    expect(s.records.value.total).toBe(4)
    expect(s.records.value.items).toHaveLength(2)
    expect(s.records.value.unreadable).toEqual([
      { key: 'zz-malformed', error: 'zz-malformed.json is not valid JSON' },
      { key: 'zz-no-cwd', error: 'not a session record (no id or cwd)' }
    ])
    expect(s.reconciliation.complete).toBe(false)
    expect(s.warnings.some((w) => w.includes('2 session record file(s)'))).toBe(true)
  })

  it('VA-4: keeps why each health route did not answer', async () => {
    const s = await collectSnapshot(
      fakeSources({
        health: async (_origin, path) => {
          if (path === '/health/live') throw new Error('VA-health-sentinel')
          return { status: 503, body: 'not ready' }
        }
      })
    )
    expect(s.server.health).toEqual({
      live: null,
      ready: 503,
      readyBody: 'not ready',
      liveError: 'error: VA-health-sentinel',
      readyError: null
    })
    expect(
      s.warnings.some((w) => w.includes('/health/live') && w.includes('VA-health-sentinel'))
    ).toBe(true)
  })

  it('VA-4: says the health routes were not asked when no address is known', async () => {
    const s = await collectSnapshot(
      fakeSources({ shellDiscovery: async () => null, endpoint: () => null })
    )
    expect(s.server.health.liveError).toBe('unavailable: no server address is known')
    expect(s.server.health.readyError).toBe('unavailable: no server address is known')
  })

  it('round 2: a discovery address carrying a token is scrubbed from the origin and the warning', async () => {
    const s = await collectSnapshot(
      fakeSources({
        shellDiscovery: async () => ({
          url: `http://${SHELL_TOKEN.toUpperCase()}.localhost:49457`,
          token: SHELL_TOKEN.toUpperCase(),
          mode: 'separate',
          ok: true,
          pid: 725,
          serverPid: 1412
        }),
        endpoint: () => null,
        mcpRuntime: () => ({ url: `http://${MCP_TOKEN}.localhost:51000/mcp`, token: MCP_TOKEN })
      })
    )
    const json = JSON.stringify(s).toLowerCase()
    expect(json).not.toContain(SHELL_TOKEN.toLowerCase())
    expect(json).not.toContain(MCP_TOKEN.toLowerCase())
    expect(s.server.origin).toContain('<redacted>')
  })

  it('round 2: the mismatch warning names neither address raw when one carries a token', async () => {
    const s = await collectSnapshot(
      fakeSources({
        shellDiscovery: async () => ({
          url: `http://${SHELL_TOKEN}.localhost:49457`,
          token: SHELL_TOKEN,
          mode: 'separate',
          ok: true,
          pid: 725,
          serverPid: 1412
        })
      })
    )
    expect(s.warnings.some((w) => w.includes('discovery file names'))).toBe(true)
    expect(JSON.stringify(s)).not.toContain(SHELL_TOKEN)
  })

  it('round 2: caps the window listings and says so', async () => {
    const replies = Array.from({ length: 6 }, (_, i) => ({
      windowId: i + 1,
      ok: true,
      result: { sessions: [], groups: [] }
    }))
    const s = await collectSnapshot(fakeSources({ windowListings: async () => replies }), {
      maxOther: 4
    })
    expect(s.windowListings).toHaveLength(4)
    expect(s.limits.truncated).toContain('windowListings')
  })

  it('round 3: a token reaching any field (a window key, a path, a workspace) is scrubbed', async () => {
    const base = fakeSources()
    const s = await collectSnapshot(
      fakeSources({
        windows: () => base.windows().map((w, i) => (i === 0 ? { ...w, key: SHELL_TOKEN } : w)),
        workspaces: () => [{ id: 'ws-1', name: 'App', rootDir: `/srv/${SHELL_TOKEN}` }],
        app: () => ({
          ...base.app(),
          paths: { userData: `/data/${MCP_TOKEN}`, logs: '/logs', crashDumps: '/dumps' }
        }),
        paths: { ...base.paths, mainLog: `/logs/${SERVER_TOKEN}/main.log` },
        neverRead: [`/data/${MCP_TOKEN}/clave-server.json`]
      })
    )
    const json = JSON.stringify(s).toLowerCase()
    for (const t of [SHELL_TOKEN, SERVER_TOKEN, MCP_TOKEN])
      expect(json).not.toContain(t.toLowerCase())
    expect(s.windows[0].key).toBe('<redacted>')
  })

  it('round 3: a discovery token of 200000 characters is scrubbed, not a failure', async () => {
    const huge = `tok-${'q'.repeat(200_000)}`
    const s = await collectSnapshot(
      fakeSources({
        shellDiscovery: async () => ({
          url: 'http://127.0.0.1:49457',
          token: huge,
          mode: 'separate',
          ok: true,
          pid: 725,
          serverPid: 1412
        }),
        windows: () => [
          {
            id: 1,
            key: huge,
            workspaceId: null,
            isPrimary: true,
            focused: true,
            boundSessionIds: []
          }
        ]
      })
    )
    expect(JSON.stringify(s)).not.toContain(huge.slice(0, 64))
    expect(s.server.mode).toBe('separate')
  })

  it('round 3: the asking window key and window inventory are scrubbed field by field', async () => {
    // A secret SHAPE, not a known token: only the per-field redaction can catch
    // it (the final known-secret pass would not), so each field's own scrub is pinned.
    const shaped = 'sk-live-abcdefghijklmnop'
    const base = fakeSources()
    const s = await collectSnapshot(
      fakeSources({
        origin: { ...base.origin, windowKey: shaped },
        windows: () => base.windows().map((w, i) => (i === 0 ? { ...w, key: shaped } : w))
      })
    )
    expect(s.origin.windowKey).toBe('<redacted>')
    expect(s.windows[0].key).toBe('<redacted>')
    expect(JSON.stringify(s)).not.toContain(shaped)
  })

  it('round 3: a known token as the asking window key is scrubbed', async () => {
    const base = fakeSources()
    const s = await collectSnapshot(
      fakeSources({ origin: { ...base.origin, windowKey: SHELL_TOKEN } })
    )
    expect(s.origin.windowKey).not.toContain(SHELL_TOKEN)
    expect(JSON.stringify(s)).not.toContain(SHELL_TOKEN)
  })

  it('round 4: a short known token (10 characters) reused in metadata is scrubbed', async () => {
    const short = 'secret1234'
    const base = fakeSources()
    const s = await collectSnapshot(
      fakeSources({
        shellDiscovery: async () => ({
          url: 'http://127.0.0.1:49457',
          token: short,
          mode: 'separate',
          ok: false,
          error: `refused ${short}`,
          pid: 725,
          serverPid: 1412
        }),
        windows: () => base.windows().map((w, i) => (i === 0 ? { ...w, key: `win-${short}` } : w)),
        sessions: async () => {
          throw new Error(`401 for ${short}`)
        }
      })
    )
    expect(JSON.stringify(s)).not.toContain(short)
    expect(s.server.mode).toBe('separate')
  })

  it('round 4: a token equal to a fixed contract value leaves the typed field intact', async () => {
    const s = await collectSnapshot(
      fakeSources({
        shellDiscovery: async () => ({
          url: 'http://127.0.0.1:49457',
          token: 'separate',
          mode: 'separate',
          ok: true,
          pid: 725,
          serverPid: 1412
        })
      })
    )
    expect(s.server.mode).toBe('separate')
    expect(s.server.ownership).toBe('shell-child')
    expect(s.sessions.status === 'ok' && s.sessions.value.map((x) => x.provider)).toEqual([
      'terminal',
      'claude'
    ])
  })

  it('round 4: only the typed field keeps the word; a window key equal to the token is scrubbed', async () => {
    const base = fakeSources()
    const s = await collectSnapshot(
      fakeSources({
        shellDiscovery: async () => ({
          url: 'http://127.0.0.1:49457',
          token: 'separate',
          mode: 'separate',
          ok: true,
          pid: 725,
          serverPid: 1412
        }),
        origin: { ...base.origin, windowKey: 'separate' },
        windows: () => base.windows().map((w, i) => (i === 0 ? { ...w, key: 'separate' } : w)),
        workspaces: () => [{ id: 'ws-1', name: 'separate', rootDir: '/srv/separate' }]
      })
    )
    expect(s.server.mode).toBe('separate')
    expect(s.origin.windowKey).toBe('<redacted>')
    expect(s.windows[0].key).toBe('<redacted>')
    expect(s.workspaces.status === 'ok' && s.workspaces.value[0]).toEqual({
      id: 'ws-1',
      name: '<redacted>',
      rootDir: '/srv/<redacted>'
    })
  })

  it('round 4: the typed-field rule names only fields the collector writes itself', () => {
    expect(typedSnapshotField(['server', 'mode'], 'separate')).toBe(true)
    expect(typedSnapshotField(['server', 'ownership'], 'shell-child')).toBe(true)
    expect(typedSnapshotField(['sessions', 'status'], 'timeout')).toBe(true)
    expect(typedSnapshotField(['sessions', 'value', 0, 'transport'], 'events')).toBe(true)
    expect(typedSnapshotField(['records', 'value', 'items', 3, 'kind'], 'claude')).toBe(true)
    // Not the collector's constants: source-reported or free-form fields.
    expect(typedSnapshotField(['windows', 0, 'key'], 'separate')).toBe(false)
    expect(typedSnapshotField(['sessions', 'value', 0, 'provider'], 'claude')).toBe(false)
    expect(typedSnapshotField(['server', 'mode'], 'some-token-value')).toBe(false)
  })

  it('VA-10: a known token in a field only the final pass covers (instanceId) is scrubbed', async () => {
    const base = fakeSources()
    const s = await collectSnapshot(
      fakeSources({ origin: { ...base.origin, instanceId: `inst-${SHELL_TOKEN}` } })
    )
    expect(s.origin.instanceId).toBe('inst-<redacted>')
    expect(JSON.stringify(s)).not.toContain(SHELL_TOKEN)
  })

  it('a remote fleet group terminal shown in a window is not a local disagreement', async () => {
    const remote = resourceKey('session', 'mac-studio', '99999999-9999-4999-8999-999999999999')
    const base = fakeSources()
    const s = await collectSnapshot(
      fakeSources({
        windowListings: async () => {
          const l = await base.windowListings(100)
          const first = l[0].result as { groups: unknown[] }
          first.groups.push({
            id: resourceKey('group', 'mac-studio', 'g-remote'),
            name: 'Remote',
            sessionIds: [],
            terminals: [{ id: 't', sessionId: remote }]
          })
          return l
        }
      })
    )
    expect(s.reconciliation.uiOnly).toEqual([])
    expect(s.reconciliation.complete).toBe(true)
    expect(
      s.warnings.some((w) =>
        w.includes('1 group(s) and 1 quick-launch terminal(s) of remote fleet servers')
      )
    ).toBe(true)
    // The remote group stays in the listing as data.
    const listing = s.windowListings[0]
    expect(
      listing.status === 'ok' && listing.value.groups.map((g) => g.terminalSessionIds)
    ).toContainEqual([remote])
  })

  // ── VA-13: the final pass keeps a fixed value only in its own field, by path ──

  it('VA-13: a token equal to a fixed value is kept only in its own field, not wherever the value is trusted', async () => {
    const base = fakeSources()
    const s = await collectSnapshot(
      fakeSources({
        shellDiscovery: async () => ({
          url: 'http://127.0.0.1:5000',
          token: 'in-process',
          mode: 'in-process',
          ok: true,
          pid: 725
        }),
        // A free-form field only the final pass covers, equal to the token.
        origin: { ...base.origin, instanceId: 'in-process' }
      })
    )
    expect(s.server.mode).toBe('in-process')
    expect(s.origin.instanceId).toBe('<redacted>')
  })

  it('VA-13: a typed field inside an array keeps its value when a token equals it', async () => {
    const s = await collectSnapshot(
      fakeSources({
        shellDiscovery: async () => ({
          url: 'http://127.0.0.1:49457',
          token: 'events',
          mode: 'separate',
          ok: true,
          pid: 725,
          serverPid: 1412
        })
      })
    )
    if (s.sessions.status !== 'ok' || s.records.status !== 'ok') throw new Error('sources')
    expect(s.sessions.value.map((x) => x.transport)).toEqual(['pty', 'events'])
    expect(s.records.value.items.find((r) => r.transport !== null)?.transport).toBe('events')
  })

  // ── VA-14: fleet ownership is classified from the raw identity, before redaction ──

  const withRemoteGroup = (
    serverId: string,
    token: string,
    extraLocalTerminal?: string
  ): ReturnType<typeof fakeSources> => {
    const base = fakeSources()
    const remote = resourceKey('session', serverId, '99999999-9999-4999-8999-999999999999')
    return fakeSources({
      shellDiscovery: async () => ({ ...(await base.shellDiscovery()), token }),
      windowListings: async () => {
        const l = await base.windowListings(100)
        const first = l[0].result as { groups: unknown[] }
        first.groups.push({
          id: resourceKey('group', serverId, 'g-remote'),
          name: 'Remote group',
          sessionIds: [],
          terminals: [{ id: 't', sessionId: remote }]
        })
        if (extraLocalTerminal)
          first.groups.push({
            id: 'g-local',
            name: 'Local group',
            sessionIds: [],
            terminals: [{ id: 'tl', sessionId: extraLocalTerminal }]
          })
        return l
      }
    })
  }
  const remoteWarning = '1 group(s) and 1 quick-launch terminal(s) of remote fleet servers'

  it('VA-14: a remote owner whose name is a known token stays remote after redaction', async () => {
    const owner = 'server-8b9a4c51-238f-4d17-a83a-1234567890ab'
    const s = await collectSnapshot(withRemoteGroup(owner, owner))
    expect(s.reconciliation.uiOnly).toEqual([])
    expect(s.warnings.some((w) => w.includes(remoteWarning))).toBe(true)
    const listing = s.windowListings[0]
    if (listing.status !== 'ok') throw new Error('listing')
    expect(listing.value.groups.find((g) => g.name === 'Remote group')?.remote).toBe(true)
    expect(JSON.stringify(s)).not.toContain(owner)
  })

  it('VA-14: a remote session id holding a short known token stays remote after redaction', async () => {
    const s = await collectSnapshot(withRemoteGroup('mac-studio', '999999'))
    expect(s.reconciliation.uiOnly).toEqual([])
    expect(s.warnings.some((w) => w.includes(remoteWarning))).toBe(true)
    expect(JSON.stringify(s)).not.toContain('999999')
  })

  it('VA-14: an escaped remote owner is still remote, and a genuinely local disagreement is still reported', async () => {
    const s = await collectSnapshot(
      withRemoteGroup('remote %:/é', SHELL_TOKEN, 'genuinely-unlisted-local-id')
    )
    expect(s.reconciliation.uiOnly).toEqual(['genuinely-unlisted-local-id'])
    expect(s.warnings.some((w) => w.includes(remoteWarning))).toBe(true)
    const listing = s.windowListings[0]
    if (listing.status !== 'ok') throw new Error('listing')
    expect(listing.value.groups.find((g) => g.name === 'Local group')?.remote).toBeUndefined()
  })

  it('VA-14: a local tab and a remote terminal that both display as <redacted> keep their own scope', async () => {
    // Two supported known tokens: the shell discovery token equals the whole
    // canonical remote key, the server discovery token equals a real local
    // session id. Both entries display alike; each keeps the scope its raw
    // identity had, so the local tab stays reconciled and the remote one
    // stays excluded.
    const base = fakeSources()
    const remote = resourceKey('session', 'mac-studio', '99999999-9999-4999-8999-999999999999')
    const s = await collectSnapshot(
      fakeSources({
        shellDiscovery: async () => ({ ...(await base.shellDiscovery()), token: remote }),
        serverDiscovery: async () => ({ ...(await base.serverDiscovery()), token: TERMINAL_ID }),
        windowListings: async () => {
          const l = await base.windowListings(100)
          const first = l[0].result as { groups: unknown[] }
          first.groups.push({
            id: resourceKey('group', 'mac-studio', 'remote-group'),
            name: 'Remote',
            sessionIds: [],
            terminals: [{ id: 't', sessionId: remote }]
          })
          return l
        }
      })
    )
    expect(s.reconciliation.serverOnly).toEqual([])
    expect(s.reconciliation.uiOnly).toEqual([])
    expect(s.warnings.some((w) => w.includes(remoteWarning))).toBe(true)
    const json = JSON.stringify(s)
    expect(json).not.toContain(TERMINAL_ID)
    expect(json).not.toContain(remote)
  })

  // ── A8: the reconciliation compares raw identities and redacts only its answer ──

  /** Two supported known tokens, each equal to a real local session id: both
   *  sessions then DISPLAY as `<redacted>`, and must still be told apart. */
  const bothLocalIdsKnown = (overrides: Partial<TriageSources>): TriageSources => {
    const base = fakeSources()
    return fakeSources({
      shellDiscovery: async () => ({ ...(await base.shellDiscovery()), token: TERMINAL_ID }),
      serverDiscovery: async () => ({ ...(await base.serverDiscovery()), token: CHAT_ID }),
      ...overrides
    })
  }

  it('A8: a session shown in no window is still a disagreement when its display equals another session', async () => {
    const base = fakeSources()
    const s = await collectSnapshot(
      bothLocalIdsKnown({
        sessions: async () =>
          (await base.sessions()).map((x) => ({ ...(x as object), windowKey: 'win-a' })),
        windows: () => [{ ...base.windows()[0], boundSessionIds: [TERMINAL_ID, CHAT_ID] }],
        // Only window A answers, and it shows the terminal, not the chat.
        windowListings: async () => [(await base.windowListings(100))[0]]
      })
    )
    expect(s.reconciliation.serverOnly).toEqual(['<redacted>'])
    expect(s.reconciliation.uiOnly).toEqual([])
    const json = JSON.stringify(s)
    expect(json).not.toContain(TERMINAL_ID)
    expect(json).not.toContain(CHAT_ID)
  })

  it('A8: records without a session are counted one by one even when they display alike', async () => {
    const s = await collectSnapshot(bothLocalIdsKnown({ sessions: async () => [] }))
    expect(s.reconciliation.recordsWithoutSession).toEqual(['<redacted>', '<redacted>'])
    expect(JSON.stringify(s)).not.toContain(TERMINAL_ID)
  })

  it('A8: a session shown in the wrong window is found among sessions that display alike', async () => {
    const base = fakeSources()
    const s = await collectSnapshot(
      bothLocalIdsKnown({
        // The server runs the terminal for window B, but window A shows it;
        // the chat is where it belongs.
        sessions: async () =>
          (await base.sessions()).map((x) => ({ ...(x as object), windowKey: 'win-b' }))
      })
    )
    expect(s.reconciliation.windowMismatch).toEqual(['<redacted>'])
    expect(s.reconciliation.serverOnly).toEqual([])
    expect(JSON.stringify(s)).not.toContain(CHAT_ID)
  })

  it('A8: an empty record link does not hide a session missing from every window', async () => {
    const base = fakeSources()
    const s = await collectSnapshot(
      fakeSources({
        sessions: async () =>
          (await base.sessions()).map((x) => ({ ...(x as object), windowKey: 'win-a' })),
        windows: () => [{ ...base.windows()[0], boundSessionIds: [TERMINAL_ID, CHAT_ID] }],
        // Window A shows only the terminal; the chat's record carries an
        // empty `link`, which names no owner and so hides nothing.
        windowListings: async () => [(await base.windowListings(100))[0]],
        records: async (dir, max) => {
          const r = await base.records(dir, max)
          return {
            ...r,
            files: r.files.map((f) =>
              (f.content as { id?: string }).id === CHAT_ID
                ? { ...f, content: { ...(f.content as object), link: {} } }
                : f
            )
          }
        }
      })
    )
    expect(s.reconciliation.serverOnly).toEqual([CHAT_ID])
    if (s.records.status !== 'ok') throw new Error('records')
    expect(s.records.value.items.find((r) => r.id === CHAT_ID)?.link).toBeNull()
  })

  it('VA-16: the reconciliation compares only the capped sessions and reports exactly the cap', async () => {
    // Seven valid, distinct local sessions; both windows answer and show no
    // tab; no records and no tmux, so nothing else can disagree. With a cap
    // of three, the comparison must see exactly the three kept sessions: an
    // uncapped raw list would report all seven while the public list still
    // reads three.
    const ids = Array.from({ length: 7 }, (_, i) => `aaaaaaa${i}-0000-4000-8000-00000000000${i}`)
    const s = await collectSnapshot(
      fakeSources({
        sessions: async () =>
          ids.map((id, i) => ({
            id,
            provider: 'terminal',
            transport: 'pty',
            cwd: '/',
            windowKey: 'win-a',
            state: 'idle',
            createdAt: i,
            adapterId: 'pty',
            title: ''
          })),
        windowListings: async () => [
          { windowId: 1, ok: true, result: { sessions: [], groups: [] } },
          { windowId: 2, ok: true, result: { sessions: [], groups: [] } }
        ],
        records: async () => ({ total: 0, files: [] }),
        tmuxSessions: async () => []
      }),
      { maxSessions: 3 }
    )
    expect(s.reconciliation.serverOnly).toEqual(ids.slice(0, 3))
    expect(problemCount(s)).toBe(3)
    expect(s.limits.truncated).toContain('sessions')
    expect(s.reconciliation.complete).toBe(false)
  })
})
