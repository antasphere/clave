/**
 * The decisions' switches of each machine as the Settings page shows them
 * (PRDCT-5179), the mirror of `helper-preferences-store.ts`: this Mac's and
 * every saved server's, by machine id (`LOCAL_SERVER_ID` for this Mac).
 * Nothing here is a truth of its own: the switches live on the machine that
 * asks Jev, every read and every write goes there (`fleetDecisions` /
 * `fleetDecisionSet`, which keep this Mac's on its own route), and the list
 * kept is that machine's last answer.
 */
import { create } from 'zustand'
import {
  DECISIONS_NEED_UPDATE,
  type DecisionPreference,
  type DecisionPreferencePatch
} from '../../../shared/decision-preferences'

export interface MachineDecisions {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** One safe sentence, never the raw error. */
  error: string | null
  decisions: DecisionPreference[]
}

export const EMPTY_MACHINE_DECISIONS: MachineDecisions = {
  status: 'idle',
  error: null,
  decisions: []
}

export const useDecisionPreferencesStore = create<{ byMachine: Record<string, MachineDecisions> }>(
  () => ({ byMachine: {} })
)

function patchMachine(
  machine: string,
  next: (current: MachineDecisions) => MachineDecisions
): void {
  useDecisionPreferencesStore.setState((state) => ({
    byMachine: {
      ...state.byMachine,
      [machine]: next(state.byMachine[machine] ?? EMPTY_MACHINE_DECISIONS)
    }
  }))
}

/** The refusal's own sentence when the machine gave one, else a plain one. */
function sentenceOf(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : ''
  // IPC wraps a refusal ("Error invoking remote method '…': Error: <sentence>").
  const sentence = message.split(/\bError: /).pop() ?? ''
  return /^(There is no decision|The switch is on or off|Decisions run on Clave's server\.|This server runs no decisions\.)/.test(
    sentence
  )
    ? sentence
    : fallback
}

/** Read a machine's decisions. */
export async function loadDecisionPreferences(machine: string): Promise<void> {
  patchMachine(machine, (current) => ({ ...current, status: 'loading', error: null }))
  try {
    const decisions = await window.electronAPI.fleetDecisions(machine)
    patchMachine(machine, () => ({ status: 'ready', error: null, decisions }))
  } catch (error) {
    // A server released before the decisions answers their routes with a
    // 404, which the client says as the update it needs.
    const message = error instanceof Error ? error.message : ''
    patchMachine(machine, (current) => ({
      ...current,
      status: 'error',
      error: message.includes(DECISIONS_NEED_UPDATE)
        ? DECISIONS_NEED_UPDATE
        : sentenceOf(error, 'The decisions could not be read from this machine.')
    }))
  }
}

/** Switch one decision on that machine; the list on screen is its answer. */
export async function setDecisionPreference(
  machine: string,
  decisionId: string,
  patch: DecisionPreferencePatch
): Promise<void> {
  try {
    const decisions = await window.electronAPI.fleetDecisionSet(machine, decisionId, patch)
    patchMachine(machine, () => ({ status: 'ready', error: null, decisions }))
  } catch (error) {
    patchMachine(machine, (current) => ({
      ...current,
      error: sentenceOf(error, 'The change did not reach the machine.')
    }))
  }
}
