import type { ModelOption, SessionStream } from '../../../shared/session-model'
import type { ProviderSwitchPlan } from '../../../preload/index.d'
import { useSessionStore, type Session } from '../store/session-store'
import { accountsUsageFor, claudeUsageForModel, headroomLabel } from '../store/usage-store'
import {
  accountForLaunch,
  accountProviderOf,
  restartSessionProcess,
  sessionAccountExhausted,
  type SwitchResult
} from './switch-account'

/**
 * A tab moves to another provider (PRDCT-4300): the same tab, restarted
 * under the same id on the other adapter, the conversation reconstructed
 * there rather than continued. Two roads, decided by the host before
 * Continue (`providerSwitchPlan`): the conversation converted into the
 * target's own storage and resumed (Claude to Codex through the session
 * bridge), or carried as a handoff message that opens the fresh
 * conversation. The popover in the chat view says which, in the person's
 * words; this module makes the move. Lane E's limit policy registers the
 * road from here for its "Continue on Codex" rung.
 */
export interface ProviderSwitchTarget {
  adapterId: string
  /** The provider's own name (`claude`, `codex`, a plugin's). */
  provider: string
  /** How the person reads it: Claude, Codex. */
  label: string
  model: ModelOption
}

/** Where the move lands: the pool's pick for the target's model, with the
 *  account's headroom as its menu row would read it. A provider with no
 *  account pool (the echo fixture, a plugin) lands nowhere in particular. */
export function providerSwitchLanding(target: Pick<ProviderSwitchTarget, 'provider' | 'model'>): {
  account: { id: string; label: string } | null
  headroom: string | null
  overrides: {
    claudeProfileId?: string
    claudeProfileLabel?: string
    codexAccountId?: string
    codexAccountLabel?: string
  }
} {
  if (target.provider === 'claude') {
    const profile = accountForLaunch('claude', undefined, target.model.id)
    const summary = claudeUsageForModel(accountsUsageFor('claude')[profile.id], target.model.id)
    return {
      account: { id: profile.id, label: profile.label },
      headroom: headroomLabel(summary),
      overrides: { claudeProfileId: profile.id, claudeProfileLabel: profile.label }
    }
  }
  if (target.provider === 'codex') {
    const account = accountForLaunch('codex', undefined, target.model.id)
    const summary = claudeUsageForModel(accountsUsageFor('codex')[account.id], target.model.id)
    return {
      account: { id: account.id, label: account.label },
      headroom: headroomLabel(summary),
      overrides: { codexAccountId: account.id, codexAccountLabel: account.label }
    }
  }
  return { account: null, headroom: null, overrides: {} }
}

/** Which road the move would take, from the host, before anything is written. */
export function planProviderSwitch(
  sessionId: string,
  adapterId: string
): Promise<ProviderSwitchPlan> {
  return window.electronAPI.providerSwitchPlan(sessionId, adapterId)
}

/** Whether the tab's own agent can still write one more message: the
 *  handoff note is offered only while its account has room for the turn. */
export function canWriteHandoffNote(session: Session): boolean {
  return session.alive && accountProviderOf(session) !== null && !sessionAccountExhausted(session)
}

/** What the current agent is asked for before the move, when the person
 *  wants a note from it. */
export const HANDOFF_NOTE_REQUEST =
  'This conversation is about to move to another agent, which will read a transcript of it rather than continue it. Write a handoff note for that agent: what we are working on, where it stands, what has been decided and why, what is next, and the files that matter. Plain text, no questions back.'

/** One more turn on the current conversation: the request above, answered
 *  as the note. Resolves with the agent's text once its turn ends; null when
 *  the turn gave nothing within `timeoutMs` or the session ended first. */
export function requestHandoffNote(
  sessionId: string,
  timeoutMs = 120_000,
  request = HANDOFF_NOTE_REQUEST
): Promise<string | null> {
  return new Promise((resolve) => {
    let text = ''
    let asked = false
    let settled = false
    const done = (value: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stop()
      resolve(value)
    }
    const stop = window.electronAPI.onSessionStream(sessionId, (stream: SessionStream) => {
      if (stream.kind !== 'event') return
      const event = stream.event
      if (event.type === 'user_message') {
        if (event.text === request) asked = true
        return
      }
      if (!asked) return
      if (event.type === 'assistant_text' && !event.parent) text += event.delta
      else if (
        event.type === 'state_change' &&
        (event.state === 'idle' || event.state === 'done') &&
        text.trim()
      )
        done(text.trim())
      else if (event.type === 'state_change' && event.state === 'ended') done(text.trim() || null)
      else if (event.type === 'turn_interrupted') done(text.trim() || null)
    })
    const timer = setTimeout(() => done(text.trim() || null), timeoutMs)
    window.electronAPI
      .sessionsWrite(sessionId, { type: 'user_message', text: request })
      .catch(() => done(null))
  })
}

export interface ProviderSwitchInput {
  /** The provider the tab is on now, as the host names it (`claude`). */
  from: string
  target: ProviderSwitchTarget
  /** The road the plan announced; a refused conversion falls back to the handoff. */
  road: 'convert' | 'handoff'
  /** The handoff message, built when the move takes that road: the chat view
   *  holds the conversation and writes it (`export.ts`, `handoffMessage`). */
  handoff: () => Promise<string>
}

export type ProviderSwitchResult = SwitchResult & {
  /** The road taken in the end. */
  road: 'converted' | 'handoff'
  /** Why the conversion was refused, when the plan said convert. */
  fallback?: string
}

/** The move: the conversion when the road is convert (else, or when Codex
 *  refuses it, the handoff message), then the same tab restarted under the
 *  same id on the target adapter, resuming the converted thread or opening
 *  on the handoff, the store told what the tab is now. */
export async function switchSessionProvider(
  sessionId: string,
  input: ProviderSwitchInput
): Promise<ProviderSwitchResult> {
  const { target } = input
  const landing = providerSwitchLanding(target)
  let resume: string | undefined
  let fallback: string | undefined
  if (input.road === 'convert') {
    const converted = await window.electronAPI.providerSwitchConvert(sessionId, {
      ...landing.overrides,
      model: target.model.id
    })
    if (converted.ok) resume = converted.threadId
    else fallback = converted.reason
  }
  const firstMessage = resume === undefined ? await input.handoff() : undefined
  const road = resume !== undefined ? 'converted' : 'handoff'
  const continuedFrom = { provider: input.from, road } as const
  const codex = target.adapterId === 'codex-chat'
  const claude = target.adapterId === 'claude-chat'
  const result = await restartSessionProcess(sessionId, {
    overrides: {
      ...landing.overrides,
      adapterId: target.adapterId,
      model: target.model.id,
      ...(resume !== undefined ? { resume } : {}),
      ...(firstMessage !== undefined ? { firstMessage } : {}),
      continuedFrom
    },
    patch: {
      ...landing.overrides,
      claudeMode: !codex,
      codexMode: codex,
      claudeAgentsMode: false,
      launchProfileId: target.adapterId === 'echo' ? 'dev-echo-adapter' : target.adapterId,
      model: target.model.id,
      continuedFrom,
      ...(codex
        ? { claudeProfileId: undefined, claudeProfileLabel: undefined, claudeConfigDir: undefined }
        : {}),
      ...(claude ? { codexAccountId: undefined, codexAccountLabel: undefined } : {})
    }
  })
  return { ...result, road, ...(fallback !== undefined ? { fallback } : {}) }
}

/** The session as the store holds it, for callers outside React. */
export function sessionById(sessionId: string): Session | undefined {
  return useSessionStore.getState().sessions.find((s) => s.id === sessionId)
}
