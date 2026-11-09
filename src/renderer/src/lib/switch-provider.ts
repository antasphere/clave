import type { HistoryItem, ModelOption, SessionStream } from '../../../shared/session-model'
import type { ProviderChoice, ProviderSwitchPlan } from '../../../preload/index.d'
import { registerProviderSwitchRoad } from './account-policy'
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

// ── The road lane E's limit policy offers as its third rung ──

/** The providers this Mac can run a tab on, read once from the host; null
 *  until the answer is in (the rung waits for it) or when the host has no
 *  such call. */
let providerChoices: ProviderChoice[] | null = null
let choicesAsked = false
function askChoices(): void {
  if (choicesAsked) return
  choicesAsked = true
  Promise.resolve()
    .then(() => window.electronAPI.adaptersList())
    .then((list) => {
      providerChoices = list
    })
    .catch(() => {
      providerChoices = []
    })
}

/** The other provider a session could continue on at a limit: Codex for a
 *  Claude tab, Claude for a Codex one, when this Mac runs it. Null for a tab
 *  without an account pool, or while the host has not said what it runs. */
export function providerSwitchTargetFor(
  session: Session
): { adapterId: string; label: string } | null {
  askChoices()
  const from = accountProviderOf(session)
  const adapterId = from === 'claude' ? 'codex-chat' : from === 'codex' ? 'claude-chat' : null
  if (!adapterId || !providerChoices) return null
  const choice = providerChoices.find((c) => c.adapterId === adapterId)
  return choice ? { adapterId: choice.adapterId, label: choice.label } : null
}

/** A conversation's past as Markdown, from the host's history alone: the
 *  limit policy moves a tab from outside its view, where the chat's own
 *  export (with the tool outputs and the files) is not at hand. The person's
 *  and the agent's words, each tool run as one line. */
export function historyMarkdown(items: readonly HistoryItem[], from: string): string {
  const out: string[] = [`# Continued from ${from} · handoff`, '']
  out.push(
    `This conversation ran on ${from} and moves to you here. You are reading a transcript of it, not continuing it: what ${from} had in its working memory and the approvals it was granted are not yours. Read, then carry on from where it stopped.`,
    '',
    '## The conversation so far'
  )
  let answer = ''
  const flush = (): void => {
    if (answer.trim()) out.push('', `## ${from}`, '', answer.trim())
    answer = ''
  }
  for (const { event } of items) {
    if ('parent' in event && event.parent) continue
    if (event.type === 'user_message') {
      flush()
      out.push('', '## You', '', event.text.trim())
    } else if (event.type === 'assistant_text') answer += event.delta
    else if (event.type === 'tool_call') {
      flush()
      out.push(`- ${event.name}`)
    }
  }
  flush()
  return out.join('\n').trimEnd() + '\n'
}

/** The move the limit policy makes on its provider rung: the road asked of
 *  the host, the target's first listed model, the handoff written from the
 *  host's history when the conversion is refused or does not apply. */
export async function switchToProvider(
  sessionId: string,
  adapterId: string
): Promise<ProviderSwitchResult> {
  const session = sessionById(sessionId)
  if (!session) return { ok: false, resumed: false, error: 'No such session', road: 'handoff' }
  const from = accountProviderOf(session) ?? 'claude'
  const [plan, models] = await Promise.all([
    planProviderSwitch(sessionId, adapterId),
    window.electronAPI.adaptersModels(adapterId, session.cwd)
  ])
  const model = models[0]
  if (!model)
    return { ok: false, resumed: false, error: 'The provider lists no model here', road: 'handoff' }
  const target: ProviderSwitchTarget = {
    adapterId,
    provider: plan.to.provider,
    label: providerSwitchTargetFor(session)?.label ?? plan.to.provider,
    model
  }
  return switchSessionProvider(sessionId, {
    from,
    target,
    road: plan.road,
    handoff: async () => {
      const items: HistoryItem[] = []
      let before: number | undefined
      for (;;) {
        const page = await window.electronAPI.sessionsHistory(sessionId, before, 2000)
        items.unshift(...page.items)
        if (page.before === null || (before !== undefined && page.before >= before)) break
        before = page.before
      }
      const fromLabel = from === 'codex' ? 'Codex' : 'Claude'
      const tape = historyMarkdown(items, fromLabel)
      const { path } = await window.electronAPI.providerSwitchHandoff(sessionId, tape)
      return `${tape}\nThe full conversation is in ${path}.\n`
    }
  })
}

/** Lane E's third rung: offered once this module is loaded by the shell. */
export function installProviderSwitchRoad(): void {
  registerProviderSwitchRoad({ targetFor: providerSwitchTargetFor, switchTo: switchToProvider })
  askChoices()
}
