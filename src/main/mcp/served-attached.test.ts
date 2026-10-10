import { describe, expect, it } from 'vitest'
import type { ClaveApiClient } from '@clave/client'
import type { SessionRecord } from '../sessions/adapters/pty-backend'
import { ATTACHED_COMMANDS, attachedShell } from './served-attached'
import type { ServedShell } from './served-core'

/**
 * The attached road's facts (wave 4): what a tool reads of the server before
 * it runs, answered through the shell as if main had them, and only what the
 * command needs.
 */
const NO_MODE = { claudeMode: false, antigravityMode: false, codexMode: false, piMode: false }
const record = (id: string, extra: Partial<SessionRecord> = {}): SessionRecord => ({
  ...{ id, cwd: '/w', folderName: 'w', ...NO_MODE, claudeAgentsMode: false, dangerousMode: false },
  ...extra
})

function fakes(): {
  api: ClaveApiClient
  calls: string[]
  base: ServedShell
  records: SessionRecord[]
} {
  const calls: string[] = []
  const records: SessionRecord[] = [
    record('srv', { link: { kind: 'session-view', ownerId: 'tab' } }),
    record('tab', { displayName: 'A tab' })
  ]
  const api = {
    sessions: {
      listAdoptable: async () => {
        calls.push('records')
        return records
      }
    },
    settings: {
      claudeAccounts: {
        list: async () => {
          calls.push('claude')
          return [
            { id: 'default', label: 'Default', hasToken: false, tokenInvalid: false },
            { id: 'a2', label: 'Two', hasToken: true, tokenInvalid: false },
            { id: 'a3', label: 'Dead', hasToken: true, tokenInvalid: true }
          ]
        }
      },
      codexAccounts: {
        list: async () => {
          calls.push('codex')
          return [
            { id: 'default', label: 'Default', kind: 'chatgpt', hasCredential: true },
            { id: 'key', label: 'Key', kind: 'apiKey', hasCredential: true }
          ]
        }
      },
      usage: {
        claudeSnapshot: async () => ({
          a2: { windows: [{ kind: 'session', usedPercentage: 97, severity: 'normal' }] },
          default: { error: 'no read' }
        }),
        codexSnapshot: async () => ({})
      },
      launchProfiles: {
        list: async () => {
          calls.push('profiles')
          return { customProfiles: [{ id: 'c1', name: 'Custom', family: 'claude' }] }
        }
      },
      workspaces: {
        load: async () => {
          calls.push('pins')
          return { pins: [{ id: 'p1', name: 'Pin', cwd: null, sessions: [], terminals: [] }] }
        }
      }
    }
  } as unknown as ClaveApiClient
  const base = {
    record: () => undefined,
    servingSessionsOf: () => ['mine'],
    accounts: () => [{ id: 'base', label: 'Base', usable: true }],
    launchProfiles: () => [{ id: 'base-p', name: 'Base profile' }],
    pins: () => [{ id: 'base-pin', name: 'Base pin', cwd: null, sessions: [], terminals: [] }]
  } as unknown as ServedShell
  return { api, calls, base, records }
}

describe('the attached shell', () => {
  it('names the seven commands', () => {
    expect([...ATTACHED_COMMANDS].sort()).toEqual([
      'launchGroup',
      'openSession',
      'readSession',
      'rename',
      'sendToSession',
      'setSessionView',
      'switchAccount'
    ])
  })
  it('reads only what the command needs, and answers the base for the rest', async () => {
    const f = fakes()
    const shell = await attachedShell(f.base, f.api, 'rename')
    expect(f.calls).toEqual([])
    expect(shell.record('tab')).toBeUndefined()
    expect(shell.accounts('claude')).toEqual([{ id: 'base', label: 'Base', usable: true }])
    expect(shell.launchProfiles('claude')).toEqual([{ id: 'base-p', name: 'Base profile' }])
    expect(shell.pins().map((p) => p.id)).toEqual(['base-pin'])
  })
  it('reads the records for every command that names, reads or types into a tab', async () => {
    for (const command of ['setSessionView', 'readSession', 'sendToSession']) {
      const f = fakes()
      await attachedShell(f.base, f.api, command)
      expect(f.calls, command).toEqual(['records'])
    }
  })
  it('answers the records and the serving sessions from the server', async () => {
    const f = fakes()
    const shell = await attachedShell(f.base, f.api, 'readSession')
    expect(f.calls).toEqual(['records'])
    expect(shell.record('tab')?.displayName).toBe('A tab')
    expect(shell.servingSessionsOf('tab')).toEqual(['mine', 'srv'])
    f.records.push(record('new'))
    expect(shell.record('new')).toBeUndefined()
    await shell.syncRecords?.()
    expect(shell.record('new')?.id).toBe('new')
  })
  it('answers the accounts with their usage summarized, the usable rule as the window had it', async () => {
    const f = fakes()
    const shell = await attachedShell(f.base, f.api, 'switchAccount')
    expect(f.calls.sort()).toEqual(['claude', 'codex', 'records'])
    expect(shell.accounts('claude')).toEqual([
      { id: 'default', label: 'Default', usable: true },
      {
        id: 'a2',
        label: 'Two',
        usable: true,
        usage: {
          tightest: { kind: 'session', usedPercentage: 97, severity: 'normal' },
          windows: [{ kind: 'session', usedPercentage: 97, severity: 'normal' }]
        }
      },
      { id: 'a3', label: 'Dead', usable: false }
    ])
    expect(shell.accounts('codex')).toEqual([
      { id: 'default', label: 'Default', usable: true },
      { id: 'key', label: 'Key', usable: true, fallback: true }
    ])
  })
  it('answers the launch profiles, built-ins first, and the pins', async () => {
    const f = fakes()
    const open = await attachedShell(f.base, f.api, 'openSession')
    const claude = open.launchProfiles('claude')
    expect(claude.at(-1)).toEqual({ id: 'c1', name: 'Custom' })
    expect(claude.length).toBeGreaterThan(1)
    expect(open.launchProfiles('pi').some((p) => p.id === 'c1')).toBe(false)
    const launch = await attachedShell(f.base, f.api, 'launchGroup')
    expect(launch.pins().map((p) => p.id)).toEqual(['p1'])
  })
})
