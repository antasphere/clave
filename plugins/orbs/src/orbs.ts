/**
 * What the orbs pack owns: the orb that stands for the agent, saved on this
 * machine, and the orb that stands for each kind of tool call.
 *
 * The nine orbs are `thinking-orbs`' nine states, each a hand-tuned animation.
 * The agent's one is the user's choice (the pack's settings block), resolved
 * against the table on load so a value from a build that no longer offers it
 * falls back instead of drawing nothing. The tools' are fixed here: the point
 * of a different orb per kind is that a reader learns them.
 */
import { create } from 'zustand'
import type { OrbState } from 'thinking-orbs'
import type { Theme } from '../../../src/renderer/src/store/session-types'

export const ORB_STATES: ReadonlyArray<{ id: OrbState; label: string; hint: string }> = [
  { id: 'working', label: 'Working', hint: 'Particles on tilted orbits' },
  { id: 'searching', label: 'Searching', hint: 'A scan sweeps a dotted globe' },
  { id: 'solving', label: 'Solving', hint: 'Bands scramble, then click back' },
  { id: 'listening', label: 'Listening', hint: 'A waveform rolls through the rings' },
  { id: 'connecting', label: 'Connecting', hint: 'A constellation wires itself' },
  { id: 'weaving', label: 'Weaving', hint: 'Three strands plait around the sphere' },
  { id: 'composing', label: 'Composing', hint: 'An undulating sash' },
  { id: 'breathing', label: 'Breathing', hint: 'A ring slowly morphing' },
  { id: 'shaping', label: 'Shaping', hint: 'Circle, triangle, square' }
]

export const DEFAULT_ORB_STATE: OrbState = 'working'

export function resolveOrbState(saved: string | null): OrbState {
  return ORB_STATES.find((s) => s.id === saved)?.id ?? DEFAULT_ORB_STATE
}

/** The orb for a kind of tool call in flight (`plugins/chat-view/src/tools.ts`
 *  names the kinds); a kind this table does not know breathes. */
export const TOOL_ORBS: Readonly<Record<string, OrbState>> = {
  read: 'searching',
  search: 'searching',
  edit: 'composing',
  command: 'working',
  skill: 'solving',
  web: 'connecting',
  agent: 'weaving',
  other: 'breathing'
}

export function toolOrb(kind: string): OrbState {
  return TOOL_ORBS[kind] ?? 'breathing'
}

/** The orb paints light ink on a dark ground and dark ink on a light one. The
 *  library's own detection reads `data-theme="dark|light"` off an ancestor, and
 *  the app's root carries the skin's id (`coffee`, `charcoal`), so the substrate
 *  is decided here from the skin's base instead. */
export function orbThemeFor(theme: Theme): 'dark' | 'light' {
  return theme === 'light' || theme === 'coffee' ? 'light' : 'dark'
}

const STORAGE_KEY = 'clave-orbs-state'

interface OrbsState {
  state: OrbState
  setState: (state: OrbState) => void
}

/** The pack's own setting, kept the way the app keeps its appearance choices. */
export const useOrbsStore = create<OrbsState>((set) => ({
  state: resolveOrbState(
    typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY)
  ),
  setState: (state) => {
    localStorage.setItem(STORAGE_KEY, state)
    set({ state })
  }
}))
