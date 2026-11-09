import { useCallback, useEffect, useState } from 'react'
import type { AgentState, Session } from '../../../src/shared/session-model'
import type { ProviderSwitchPlan } from '../../../src/preload/index.d'
import { claudeContextWindow, claudeModelName } from '../../../src/shared/claude-models'
import {
  canWriteHandoffNote,
  planProviderSwitch,
  providerSwitchLanding,
  requestHandoffNote,
  sessionById,
  switchSessionProvider
} from '../../../src/renderer/src/lib/switch-provider'
import type { ProviderPick } from './ModelMenu'
import type { ProviderSwitchLanding } from './ProviderSwitch'
import { reduceConversation, type Conversation, type Entry } from './reducer'
import { editedFiles, handoffMessage, transcriptMarkdown, type TranscriptMeta } from './export'
import { providerLabel } from './models'

/** The characters the handoff message may take: half the target model's
 *  window when its id names one (Clave's table), else a 200k window, at
 *  four characters a token. The full tape goes to the file regardless. */
export function handoffBudgetChars(modelId: string): number {
  const window = claudeContextWindow(modelId) ?? 200_000
  return Math.round(window * 0.5 * 4)
}

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
  const cancel = useCallback((): void => setState(null), [])
  const confirm = useCallback(
    async ({ note }: { note: boolean }): Promise<void> => {
      if (!state?.plan) return
      const { target, plan } = state
      const from = providerLabel(session.provider)
      try {
        let noteText: string | null = null
        if (noteToAsk(note, working())) {
          setState((s) => (s ? { ...s, busy: `Asking ${from} for a handoff note…` } : s))
          noteText = await requestHandoffNote(session.id)
        } else if (note) {
          onError(
            `The handoff note was skipped: ${from} was in the middle of a turn when you pressed Continue.`
          )
        }
        setState((s) =>
          s
            ? {
                ...s,
                busy:
                  plan.road === 'convert'
                    ? `Converting the conversation for ${target.label}…`
                    : 'Writing the handoff…'
              }
            : s
        )
        const result = await switchSessionProvider(session.id, {
          from: session.provider,
          target,
          road: plan.road,
          handoff: async () => {
            const entries = await wholeConversation(session.id, source())
            const head: TranscriptMeta = { ...meta(), agent: from, exportedAt: new Date() }
            // The whole conversation, every output whole, beside the work.
            const tape = transcriptMarkdown(entries, head, {
              lastStretchOutputs: true,
              outputChars: Number.MAX_SAFE_INTEGER
            })
            const { path, diffStat } = await window.electronAPI.providerSwitchHandoff(
              session.id,
              tape
            )
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
        if (!result.ok) {
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
