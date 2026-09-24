import { describe, expect, it } from 'vitest'
import { resolveSpawnModes } from './open-session-modes'

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
