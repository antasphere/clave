/**
 * The launcher's memory: the mapping between an `AgentSetup` and the four spawn
 * booleans, which agents can take a launch prompt, and the validation that
 * decides what a persisted preference file is allowed to say.
 *
 * All pure. The persistence itself (`rememberAgentSetup` / `loadLaunchPrefs`)
 * talks to the main process and is covered by the Electron specs instead — as is
 * the thing `agentAcceptsPrompt` exists to prevent: the group `+` row promising
 * a prompt the launch then drops. No unit test can see both the tooltip and the
 * spawn, so that guard lives in tests/e2e/group-prompt.spec.mjs where it can.
 */

import { describe, expect, it } from 'vitest'
import {
  agentAcceptsPrompt,
  agentSetupToModes,
  parseSetup,
  getLastAgentSetup,
  useLaunchPrefsStore,
  DEFAULT_AGENT_SETUP,
  type AgentKind
} from './launch-prefs'
import { useAccountPolicyStore } from './account-policy-store'

const KINDS: AgentKind[] = ['claude', 'claude-agents', 'antigravity', 'codex']

describe('agentSetupToModes', () => {
  it('sets exactly one boolean, whichever kind it is', () => {
    for (const kind of KINDS) {
      const modes = agentSetupToModes({ kind, dangerousMode: false })
      const on = Object.values(modes).filter(Boolean)
      expect({ kind, on: on.length }).toEqual({ kind, on: 1 })
    }
  })

  it('maps each kind to its own boolean', () => {
    expect(agentSetupToModes({ kind: 'claude', dangerousMode: false }).claudeMode).toBe(true)
    expect(
      agentSetupToModes({ kind: 'claude-agents', dangerousMode: false }).claudeAgentsMode
    ).toBe(true)
    expect(agentSetupToModes({ kind: 'antigravity', dangerousMode: false }).antigravityMode).toBe(
      true
    )
    expect(agentSetupToModes({ kind: 'codex', dangerousMode: false }).codexMode).toBe(true)
  })

  it('never sets claudeMode alongside another provider', () => {
    for (const kind of KINDS.filter((k) => k !== 'claude')) {
      expect(agentSetupToModes({ kind, dangerousMode: false }).claudeMode).toBe(false)
    }
  })
})

describe('agentAcceptsPrompt', () => {
  it('is false for a plain terminal — typed text would run as a shell command', () => {
    expect(agentAcceptsPrompt(null)).toBe(false)
  })

  it('is false for claude agents — the subcommand rejects a positional prompt', () => {
    expect(agentAcceptsPrompt({ kind: 'claude-agents', dangerousMode: false })).toBe(false)
  })

  it('is true for the agents that take one', () => {
    for (const kind of ['claude', 'antigravity', 'codex'] as AgentKind[]) {
      expect(agentAcceptsPrompt({ kind, dangerousMode: false })).toBe(true)
    }
  })
})

describe('DEFAULT_AGENT_SETUP', () => {
  it('is a safe default — Claude, permissions on', () => {
    expect(DEFAULT_AGENT_SETUP).toEqual({ kind: 'claude', dangerousMode: false })
  })
})

describe('parseSetup — what a persisted preference file is allowed to say', () => {
  it('accepts a well-formed setup', () => {
    expect(parseSetup({ kind: 'codex', dangerousMode: true })).toEqual({
      kind: 'codex',
      dangerousMode: true
    })
  })

  it('rejects an unknown kind rather than launching nothing', () => {
    // A hand-edited file, or one written by a build that had a kind this one
    // dropped. Trusting it would leave the agent button unable to launch at all.
    expect(parseSetup({ kind: 'gemini', dangerousMode: false })).toBeNull()
  })

  it('rejects anything that is not an object', () => {
    for (const bad of [null, undefined, 'claude', 42, []]) {
      expect(parseSetup(bad)).toBeNull()
    }
  })

  it('treats a missing or non-true dangerousMode as false', () => {
    expect(parseSetup({ kind: 'claude' })?.dangerousMode).toBe(false)
    expect(parseSetup({ kind: 'claude', dangerousMode: 'yes' })?.dangerousMode).toBe(false)
  })

  it('keeps a Claude account id, and drops one that cannot apply', () => {
    expect(parseSetup({ kind: 'claude', claudeProfileId: 'work' })?.claudeProfileId).toBe('work')
    // Antigravity and Codex never take a Claude account; carrying one would be
    // a value the spawn path silently ignores.
    expect(parseSetup({ kind: 'codex', claudeProfileId: 'work' })?.claudeProfileId).toBeUndefined()
  })

  it('keeps the launcher model (PRDCT-4423) and drops one no CLI flag could take', () => {
    expect(parseSetup({ kind: 'claude', model: 'claude-fable-5-1[1m]' })?.model).toBe(
      'claude-fable-5-1[1m]'
    )
    expect(parseSetup({ kind: 'codex', model: 'gpt-5.5' })?.model).toBe('gpt-5.5')
    expect(parseSetup({ kind: 'claude', model: '--dangerously-skip' })?.model).toBeUndefined()
    expect(parseSetup({ kind: 'claude', model: 7 })?.model).toBeUndefined()
  })

  it('ignores a non-string account id', () => {
    expect(parseSetup({ kind: 'claude', claudeProfileId: 7 })?.claudeProfileId).toBeUndefined()
  })
})

describe('getLastAgentSetup and the recommended account', () => {
  const remembered = {
    kind: 'claude' as const,
    dangerousMode: true,
    claudeProfileId: 'work',
    launchProfileId: 'chat',
    model: 'claude-opus-5-5'
  }

  it('replays the remembered account while the setting is off', () => {
    useLaunchPrefsStore.setState({ byWorkspace: { ws: remembered } })
    useAccountPolicyStore.setState({ useRecommendedAccount: false })
    expect(getLastAgentSetup('ws')).toEqual(remembered)
  })

  it('drops only the account once the setting is on, so the pool picks the recommendation', () => {
    useLaunchPrefsStore.setState({
      byWorkspace: {
        ws: remembered,
        cx: { kind: 'codex', dangerousMode: false, codexAccountId: 'a' }
      }
    })
    useAccountPolicyStore.setState({ useRecommendedAccount: true })
    expect(getLastAgentSetup('ws')).toEqual({
      kind: 'claude',
      dangerousMode: true,
      launchProfileId: 'chat',
      model: 'claude-opus-5-5'
    })
    expect(getLastAgentSetup('cx')).toEqual({ kind: 'codex', dangerousMode: false })
    // The stored memory is untouched: turning the setting off brings it back.
    expect(useLaunchPrefsStore.getState().byWorkspace.ws).toEqual(remembered)
    useAccountPolicyStore.setState({ useRecommendedAccount: false })
  })
})

describe('parseSetup — a remembered launch profile (PRDCT-4423, verifier round 2)', () => {
  it('keeps a saved profile picked under Advanced and drops a built-in or chat-form transport', () => {
    expect(parseSetup({ kind: 'claude', dangerousMode: false, launchProfileId: 'work' })).toEqual({
      kind: 'claude',
      dangerousMode: false,
      launchProfileId: 'work'
    })
    for (const stale of ['builtin-claude', 'claude-chat', 'codex-chat', 'chat:claude:work']) {
      expect(parseSetup({ kind: 'claude', dangerousMode: false, launchProfileId: stale })).toEqual({
        kind: 'claude',
        dangerousMode: false
      })
    }
  })
})
