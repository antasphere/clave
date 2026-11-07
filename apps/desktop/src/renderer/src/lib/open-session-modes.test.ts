import { describe, expect, it } from 'vitest'
import { chatDefaultFor, resolveSpawnModes, resolveProfileRef } from './open-session-modes'
import type { LaunchProfilePreferences } from '../../../../../../packages/shared/src/agent-launch'

describe('clave_open_session spawn modes', () => {
  it('lets the skip-approvals flag through for codex, as the spawn turns it into --yolo', () => {
    const modes = resolveSpawnModes({ mode: 'codex', dangerous: true })
    expect(modes.codexMode).toBe(true)
    expect(modes.claudeMode).toBe(false)
    expect(modes.dangerousMode).toBe(true)
    expect(modes.family).toBe('codex')
  })
  it('keeps the flag for claude', () => {
    expect(resolveSpawnModes({ mode: 'claude', dangerous: true }).dangerousMode).toBe(true)
    expect(resolveSpawnModes({ dangerous: true }).dangerousMode).toBe(true)
  })
  it('never sets it without the flag, whatever the mode', () => {
    for (const mode of ['claude', 'codex', 'pi', 'antigravity', 'terminal'] as const) {
      expect(resolveSpawnModes({ mode }).dangerousMode).toBe(false)
      expect(resolveSpawnModes({ mode, dangerous: false }).dangerousMode).toBe(false)
    }
  })
  it('drops it for the agents whose CLI has no such flag, and for a terminal', () => {
    expect(resolveSpawnModes({ mode: 'pi', dangerous: true }).dangerousMode).toBe(false)
    expect(resolveSpawnModes({ mode: 'antigravity', dangerous: true }).dangerousMode).toBe(false)
    expect(resolveSpawnModes({ mode: 'gemini', dangerous: true }).dangerousMode).toBe(false)
    expect(resolveSpawnModes({ mode: 'terminal', dangerous: true }).dangerousMode).toBe(false)
  })
  it('maps the mode to its family, gemini to antigravity and a terminal to none', () => {
    expect(resolveSpawnModes({ mode: 'gemini' })).toMatchObject({
      antigravityMode: true,
      family: 'antigravity'
    })
    expect(resolveSpawnModes({ mode: 'terminal' })).toMatchObject({
      claudeMode: false,
      codexMode: false,
      piMode: false,
      family: null
    })
  })
  it('keeps the model for the agents that take one and drops it otherwise', () => {
    expect(resolveSpawnModes({ mode: 'codex', model: 'gpt-5.5' }).model).toBe('gpt-5.5')
    expect(resolveSpawnModes({ mode: 'pi', model: 'x' }).model).toBe('x')
    expect(resolveSpawnModes({ mode: 'antigravity', model: 'x' }).model).toBeUndefined()
    expect(resolveSpawnModes({ mode: 'terminal', model: 'x' }).model).toBeUndefined()
  })
})

describe('clave_open_session chat view', () => {
  it('opens claude and codex in their chat profiles', () => {
    expect(resolveProfileRef({ chat: true })).toBe('claude-chat')
    expect(resolveProfileRef({ mode: 'claude', chat: true })).toBe('claude-chat')
    expect(resolveProfileRef({ mode: 'codex', chat: true })).toBe('codex-chat')
  })
  it('leaves the profile alone without chat', () => {
    expect(resolveProfileRef({ mode: 'claude' })).toBeUndefined()
    expect(resolveProfileRef({ mode: 'claude', chat: false, profile: 'mine' })).toBe('mine')
  })
  it('accepts the chat profile named alongside chat', () => {
    expect(resolveProfileRef({ mode: 'codex', chat: true, profile: 'codex-chat' })).toBe(
      'codex-chat'
    )
  })
  it('refuses chat where there is no chat view, rather than opening a terminal', () => {
    for (const mode of ['pi', 'antigravity', 'gemini', 'terminal'] as const) {
      expect(() => resolveProfileRef({ mode, chat: true })).toThrow(/no chat view/)
    }
  })
  it('refuses chat beside a different profile', () => {
    expect(() => resolveProfileRef({ chat: true, profile: 'builtin-claude' })).toThrow(
      /drop profile/
    )
  })
})

/* The chat an agent opens is the chat the person would get from the launcher
   in that workspace. On 3 November 2026 a wave's Codex chats, opened with
   chat: true, ran on the built-in profile and its default approval policy
   while the workspace's Codex default was the chat form of the person's own
   profile: every command asked first. */
describe('clave_open_session chat default', () => {
  it('opens the chat profile the workspace is set to, when it is one', () => {
    expect(resolveProfileRef({ mode: 'codex', chat: true }, 'chat:codex:yolo')).toBe(
      'chat:codex:yolo'
    )
    expect(resolveProfileRef({ chat: true }, 'chat:claude:no-key')).toBe('chat:claude:no-key')
    expect(resolveProfileRef({ mode: 'codex', chat: true }, 'codex-chat')).toBe('codex-chat')
  })
  it('falls back to the built-in chat when the default is no chat profile of the family', () => {
    expect(resolveProfileRef({ mode: 'codex', chat: true }, undefined)).toBe('codex-chat')
    expect(resolveProfileRef({ mode: 'codex', chat: true }, 'builtin-codex')).toBe('codex-chat')
    expect(resolveProfileRef({ mode: 'codex', chat: true }, 'chat:claude:no-key')).toBe(
      'codex-chat'
    )
  })
  it('lets an explicit chat profile win over the default, derived forms included', () => {
    expect(
      resolveProfileRef(
        { mode: 'codex', chat: true, profile: 'chat:codex:strict' },
        'chat:codex:yolo'
      )
    ).toBe('chat:codex:strict')
    expect(
      resolveProfileRef({ mode: 'codex', chat: true, profile: 'codex-chat' }, 'chat:codex:yolo')
    ).toBe('codex-chat')
  })
  it('still refuses a terminal profile beside chat, whatever the default', () => {
    expect(() =>
      resolveProfileRef({ mode: 'codex', chat: true, profile: 'builtin-codex' }, 'chat:codex:yolo')
    ).toThrow(/drop profile/)
    expect(() =>
      resolveProfileRef({ mode: 'codex', chat: true, profile: 'chat:claude:no-key' })
    ).toThrow(/drop profile/)
  })
  const prefs = (over: Partial<LaunchProfilePreferences>): LaunchProfilePreferences => ({
    version: 1,
    customProfiles: [
      {
        id: 'yolo',
        name: 'yolo codex',
        family: 'codex',
        command: ['codex', '--yolo'],
        additionalArgs: []
      },
      {
        id: 'chat:codex:yolo',
        name: 'yolo codex (chat)',
        family: 'codex',
        command: ['codex', '--yolo'],
        additionalArgs: [],
        sourceProfileId: 'yolo'
      },
      {
        id: 'plugin-agent',
        name: 'Plugin',
        family: 'claude',
        command: ['plugin'],
        additionalArgs: []
      }
    ],
    globalDefaults: {},
    workspaceOverrides: {},
    ...over
  })
  it("reads the workspace's chat default first, then the global one", () => {
    const p = prefs({
      globalDefaults: { codex: 'codex-chat' },
      workspaceOverrides: { ws1: { codex: 'chat:codex:yolo' } }
    })
    expect(chatDefaultFor(p, 'codex', 'ws1')).toBe('chat:codex:yolo')
    expect(chatDefaultFor(p, 'codex', 'ws2')).toBe('codex-chat')
    expect(chatDefaultFor(p, 'codex', null)).toBe('codex-chat')
  })
  it("answers the chat form of a terminal default: the person's profile, in the chat view", () => {
    expect(chatDefaultFor(prefs({ globalDefaults: { codex: 'yolo' } }), 'codex', null)).toBe(
      'chat:codex:yolo'
    )
    expect(
      chatDefaultFor(prefs({ globalDefaults: { codex: 'builtin-codex' } }), 'codex', null)
    ).toBe('codex-chat')
    expect(chatDefaultFor(prefs({}), 'codex', null)).toBe('codex-chat')
  })
  it('answers nothing for a default without a chat form, and for a family without a chat view', () => {
    expect(
      chatDefaultFor(prefs({ globalDefaults: { claude: 'plugin-agent' } }), 'claude', null)
    ).toBe(undefined)
    expect(chatDefaultFor(prefs({}), 'pi', null)).toBeUndefined()
    expect(chatDefaultFor(prefs({}), 'antigravity', null)).toBeUndefined()
  })
  it('survives a preferences object missing its default tables', () => {
    expect(
      chatDefaultFor({ customProfiles: [] } as unknown as LaunchProfilePreferences, 'codex', 'ws1')
    ).toBe('codex-chat')
  })
})
