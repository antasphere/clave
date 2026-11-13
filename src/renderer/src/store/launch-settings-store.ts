import { create } from 'zustand'
import {
  DEFAULT_INTERACTION_MODE,
  HARNESS_BY_ID,
  type HarnessId,
  type HarnessSettings,
  type HarnessSettingsById,
  type InteractionMode,
  type LaunchSettings
} from '../../../shared/harness'

/**
 * The launch settings on this Mac (PRDCT-4423, PRDCT-4424, PRDCT-4425): the
 * interaction mode and the per-harness preferred model and permission rung,
 * mirrored from main (`src/main/launch-settings.ts`) and pushed on every
 * change from any window. `load()` once at boot; the writers answer with the
 * record as stored, so the store never guesses.
 */
interface LaunchSettingsState extends LaunchSettings {
  loaded: boolean
  load: () => Promise<void>
  setInteractionMode: (mode: InteractionMode) => Promise<void>
  setHarness: (
    id: HarnessId,
    patch: Partial<Record<keyof HarnessSettings, string | null>>
  ) => Promise<void>
}

let unsubscribe: (() => void) | null = null

export const useLaunchSettingsStore = create<LaunchSettingsState>((set) => ({
  interactionMode: DEFAULT_INTERACTION_MODE,
  harnesses: {},
  loaded: false,
  load: async () => {
    const api = window.electronAPI
    if (!api?.launchSettingsGet) return
    const settings = await api.launchSettingsGet()
    set({ ...settings, loaded: true })
    if (!unsubscribe && api.onLaunchSettingsChanged) {
      unsubscribe = api.onLaunchSettingsChanged((next) => set({ ...next, loaded: true }))
    }
  },
  setInteractionMode: async (mode) => {
    const settings = await window.electronAPI.launchSettingsSet({ interactionMode: mode })
    set({ ...settings, loaded: true })
  },
  setHarness: async (id, patch) => {
    const settings = await window.electronAPI.launchSettingsSet({ harnesses: { [id]: patch } })
    set({ ...settings, loaded: true })
  }
}))

/** The settings of one harness, the empty record when none were set. */
export function harnessSettingsOf(harnesses: HarnessSettingsById, id: HarnessId): HarnessSettings {
  return harnesses[id] ?? {}
}

/** The permission rung a launch of this harness starts on: the person's
 *  default when set, else nothing (the CLI's own). */
export function permissionRungFor(
  harnesses: HarnessSettingsById,
  id: HarnessId
): string | undefined {
  const rung = harnesses[id]?.permissionDefault
  return rung && HARNESS_BY_ID[id].permissionRungs.some((r) => r.id === rung) ? rung : undefined
}
