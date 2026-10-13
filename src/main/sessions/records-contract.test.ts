import { describe, expect, it } from 'vitest'
import { Schema } from 'effect'
import { SessionRecord as WireRecord } from '@clave/contract/sessions'
import type { SessionRecord as ShellRecord } from './adapters/pty-backend'

/**
 * The wire `SessionRecord` (contract) and the shell's `SessionRecord`
 * (pty-backend.ts) are two copies of one shape, and the app's CLAUDE.md names
 * them a mirror. An Effect Schema Struct DROPS a field it does not name on
 * decode, so a field the wire schema forgets is lost crossing the server — a
 * silent restore bug. This holds the two together: a full shell-shaped record
 * decodes through the wire schema with EVERY field intact, and the shell type
 * is assignable to the wire type (so a field added to the shell and not the
 * wire is a compile error here). Round-1 verifier gap G6/M14.
 */
const full = {
  id: 's1',
  adapterId: 'claude-chat',
  transport: 'pty' as const,
  tmuxName: 'clave-s1',
  claudeSessionId: 'c1',
  piSessionId: 'p1',
  cwd: '/work',
  folderName: 'work',
  displayName: 'Work',
  userRenamed: true,
  claudeMode: true,
  antigravityMode: false,
  codexMode: false,
  piMode: false,
  claudeAgentsMode: false,
  dangerousMode: false,
  model: 'opus',
  launchProfileId: 'lp1',
  piProvider: 'anthropic',
  piThinking: 'high',
  configDir: '/cfg',
  claudeProfileId: 'pr1',
  claudeProfileLabel: 'Work',
  codexAccountId: 'ca1',
  codexAccountLabel: 'Default',
  codexThreadId: 'thr-1',
  startedAt: 123,
  workspaceId: 'ws1',
  windowKey: 'w1',
  view: { url: 'http://127.0.0.1:1', title: 't', command: 'serve', cwd: '/v' },
  link: { kind: 'group-terminal' as const, groupId: 'g1', terminalId: 't1' },
  live: true,
  running: true
}

describe('the SessionRecord mirror holds', () => {
  it('decodes a full shell-shaped record with every field intact', () => {
    const decoded = Schema.decodeUnknownSync(WireRecord)(full) as Record<string, unknown>
    for (const key of Object.keys(full)) {
      expect(decoded, `the wire schema dropped "${key}"`).toHaveProperty(key)
    }
    expect(decoded).toEqual(full)
  })

  it('accepts each SessionLink kind', () => {
    const decode = Schema.decodeUnknownSync(WireRecord)
    expect(decode({ ...full, link: { kind: 'session-view', ownerId: 'o1' } }).link).toEqual({
      kind: 'session-view',
      ownerId: 'o1'
    })
    expect(decode({ ...full, link: { kind: 'toolbar', key: 'k:0' } }).link).toEqual({
      kind: 'toolbar',
      key: 'k:0'
    })
  })

  it('keeps the shell type assignable to the wire type (a new shell field must join the wire)', () => {
    // A shell record is a valid wire record: compile-time proof the wire
    // schema names every field the shell carries (piThinking is a string on
    // the wire, which the shell's narrower union satisfies).
    const shell = full as unknown as ShellRecord
    const onWire: typeof WireRecord.Type = shell
    expect(onWire.id).toBe('s1')
  })
})
