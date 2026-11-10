import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentState, Session } from '../../../src/shared/session-model'
import type { ProviderSwitchPlan } from '../../../src/preload/index.d'
import { claudeModelName } from '../../../src/shared/claude-models'
import {
  canWriteHandoffNote,
  planProviderSwitch,
  providerSwitchLanding,
  requestHandoffNote,
  sessionById,
  settleProviderSwitchAsk,
  switchSessionProvider,
  takeProviderSwitchAsk
} from '../../../src/renderer/src/lib/switch-provider'
import { useViewSessionStore } from '../../../src/renderer/src/views/session-store'
import { handoffBudgetChars } from '../../../src/renderer/src/lib/handoff-budget'
import type { ProviderPick } from './ModelMenu'
import type { ProviderSwitchLanding } from './ProviderSwitch'
import { reduceConversation, type Conversation, type Entry } from './reducer'
import { editedFiles, handoffMessage, transcriptMarkdown, type TranscriptMeta } from './export'
import { providerLabel } from './models'

export { handoffBudgetChars }

/** The whole conversation, the pages not yet read pulled in first, the way
 *  the transcript's export reads it: a handoff must carry what was said
 *  before the pane's first page too. */
export async function wholeConversation(
  sessionId: string,
  source: { conversation: Conversation; before: number | null }
): Promise<Entry[]> {
  let { conversation: whole, before: cursor } = source
  while (cursor !== null) {
    const page = await window.electronAPI.sessionsHistory(sessionId, cursor, 2000)
    whole = reduceConversation(whole, { prepend: page.items })
    // A cursor that does not move would ask the same page forever.
    cursor = page.before !== null && page.before < cursor ? page.before : null
  }
  return whole.entries
}

/** Whether the agent is in the middle of a turn: working, or held on a
 *  permission prompt (the reducer counts both as mid-turn). A note asked
 *  then would come back as the tail of that turn (verifier round 1 F5,
 *  round 2 R1). */
export const midTurn = (state: AgentState): boolean => state === 'working' || state === 'blocked'

/** Whether the note the person ticked is asked at Continue: only while the
 *  agent is idle NOW, not when the popover opened (verifier round 2 R2). */
export const noteToAsk = (ticked: boolean, working: boolean): boolean => ticked && !working

export interface ProviderSwitchState {
  target: ProviderPick
  plan: ProviderSwitchPlan | null
  landing: ProviderSwitchLanding
  noteOffered: boolean
  busy: string | null
  error: string | null
}

/**
 * The move of a chat tab to another provider, as the view drives it
 * (PRDCT-4300): a pick in the menu opens the popover and asks the host which
 * road the move takes; Continue makes it, the handoff note first when asked,
 * the conversion when the road is convert, the handoff message built from
 * this view's conversation when it is not or when Codex refuses. The store
 * remounts the pane on the answer, as an account switch does.
 */
export function useProviderSwitch({
  session,
  source,
  meta,
  working,
  visible,
  onError
}: {
  session: Session
  /** Whether the agent is working now: a note cannot be asked of it mid-turn
   *  (its answer would be the tail of the running turn), and Continue cuts
   *  that turn, which the popover says. */
  working: () => boolean
  /** The conversation as the view holds it and where its unread past starts,
   *  read when the move is made. */
  source: () => { conversation: Conversation; before: number | null }
  meta: () => Pick<TranscriptMeta, 'title' | 'cwd' | 'model'>
  /** Whether this view is the one on screen for the tab: the limit card's
   *  ask is taken by the visible pane alone (integration round 3, R2-3),
   *  never by a hidden sibling view mounted beside it. */
  visible: boolean
  onError: (error: unknown) => void
}): {
  state: ProviderSwitchState | null
  begin: (target: ProviderPick) => void
  cancel: () => void
  confirm: (options: { note: boolean }) => Promise<void>
} {
  const [state, setState] = useState<ProviderSwitchState | null>(null)
  const begin = useCallback(
    (target: ProviderPick): void => {
      const stored = sessionById(session.id)
      setState({
        target,
        plan: null,
        landing: providerSwitchLanding(target),
        noteOffered: stored ? canWriteHandoffNote(stored) && !working() : false,
        busy: null,
        error: null
      })
    },
    [session.id, working]
  )
  // The limit card's provider rung (integration round 2, F11): the card asks
  // for the move; the popover opens on it here, and settles the card's
  // promise with the move's result or the cancel.
  const asked = useViewSessionStore(
    (s) => s.sessions.find((x) => x.id === session.id)?.providerSwitchAsk ?? null
  )
  const askedFlag = useRef<boolean | undefined>(undefined)
  useEffect(() => {
    if (!asked || !visible) return
    const ask = takeProviderSwitchAsk(session.id)
    if (!ask) return
    askedFlag.current = ask.resendRejected
    begin({ adapterId: ask.adapterId, provider: ask.provider, label: ask.label, model: ask.model })
  }, [asked, visible, session.id, begin])
  // The road, asked once per target.
  useEffect(() => {
    if (!state || state.plan !== null) return
    let live = true
    const target = state.target
    planProviderSwitch(session.id, target.adapterId)
      .then((plan) => {
        if (live) setState((s) => (s && s.target === target ? { ...s, plan } : s))
      })
      .catch((error) => {
        if (live) setState((s) => (s && s.target === target ? { ...s, error: String(error) } : s))
      })
    return () => {
      live = false
    }
  }, [session.id, state])
  const cancel = useCallback((): void => {
    settleProviderSwitchAsk(session.id, { cancelled: true })
    askedFlag.current = undefined
    setState(null)
  }, [session.id])
  const confirm = useCallback(
    async ({ note }: { note: boolean }): Promise<void> => {
      if (!state?.plan) return
      const { target, plan } = state
      try {
        const result = await performProviderSwitch({
          sessionId: session.id,
          provider: session.provider,
          target,
          plan,
          note,
          working: working(),
          resendRejected: askedFlag.current,
          source: source(),
          meta: meta(),
          onBusy: (busy) => setState((s) => (s ? { ...s, busy } : s)),
          onError
        })
        settleProviderSwitchAsk(session.id, result)
        askedFlag.current = undefined
        if (!result.ok) {
          // The refusal stays on screen here, in the popover (G6).
          setState((s) => (s ? { ...s, busy: null, error: result.error ?? 'The move failed.' } : s))
          return
        }
        if (result.fallback)
          onError(
            `The conversion was refused (${result.fallback}); the conversation went to ${target.label} as a handoff message.`
          )
        setState(null)
      } catch (error) {
        setState((s) => (s ? { ...s, busy: null, error: String(error) } : s))
      }
    },
    [state, session.id, session.provider, source, meta, working, onError]
  )
  return { state, begin, cancel, confirm }
}

/** The current model's name for the note's checkbox: Clave's name for a
 *  Claude id, the id itself for another provider's. */
export function noteAgentName(model: string | null, provider: string): string {
  return claudeModelName(model) ?? model ?? providerLabel(provider)
}

/** The move the popover makes on Continue, outside React so the tests
 *  reach it (integration round 3, R2-4): the note asked first when ticked
 *  and the agent idle now, the conversion when the road is convert, the
 *  handoff built from the view's whole conversation under the one budget
 *  when it is not or when Codex refuses, the rejected message carried
 *  across when the move is the limit's doing. */
export async function performProviderSwitch(input: {
  sessionId: string
  provider: string
  target: ProviderPick
  plan: ProviderSwitchPlan
  note: boolean
  working: boolean
  /** The limit card's word when it asked; else the report the tab holds decides. */
  resendRejected?: boolean
  source: { conversation: Conversation; before: number | null }
  meta: Pick<TranscriptMeta, 'title' | 'cwd' | 'model'>
  onBusy: (busy: string) => void
  onError: (error: unknown) => void
}): Promise<Awaited<ReturnType<typeof switchSessionProvider>>> {
  const { sessionId, target, plan } = input
  const from = providerLabel(input.provider)
  let noteText: string | null = null
  if (noteToAsk(input.note, input.working)) {
    input.onBusy(`Asking ${from} for a handoff note…`)
    noteText = await requestHandoffNote(sessionId)
  } else if (input.note) {
    input.onError(
      `The handoff note was skipped: ${from} was in the middle of a turn when you pressed Continue.`
    )
  }
  input.onBusy(
    plan.road === 'convert'
      ? `Converting the conversation for ${target.label}…`
      : 'Writing the handoff…'
  )
  const stored = sessionById(sessionId)
  return switchSessionProvider(sessionId, {
    from: input.provider,
    target,
    road: plan.road,
    // The move the limit caused carries the rejected message across (G7):
    // the card's word when it asked, else the report the tab holds.
    resendRejected: input.resendRejected ?? !!stored?.limitReported,
    handoff: async () => {
      const entries = await wholeConversation(sessionId, input.source)
      const head: TranscriptMeta = { ...input.meta, agent: from, exportedAt: new Date() }
      // The whole conversation, every output whole, beside the work.
      const tape = transcriptMarkdown(entries, head, {
        lastStretchOutputs: true,
        outputChars: Number.MAX_SAFE_INTEGER
      })
      const { path, diffStat } = await window.electronAPI.providerSwitchHandoff(sessionId, tape)
      return handoffMessage(entries, head, {
        from,
        note: noteText,
        files: editedFiles(entries),
        diffStat,
        tapePath: path,
        budgetChars: handoffBudgetChars(target.model.id)
      })
    }
  })
}
