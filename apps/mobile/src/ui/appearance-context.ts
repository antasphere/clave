/**
 * Appearance → Theme, the phone's way: the chosen appearance is a device
 * preference (one per phone, whoever is signed in), read once at launch and
 * written on each change; `system` follows the phone's own light or dark.
 */
import { createContext, useContext } from 'react'
import type { KeyValueStore } from '../chat/drafts'
import { APPEARANCE_KEY, isAppearance, type Appearance } from './theme'

export interface AppearanceState {
  readonly appearance: Appearance
  readonly setAppearance: (next: Appearance) => void
}

export const AppearanceContext = createContext<AppearanceState>({
  appearance: 'system',
  setAppearance: () => {}
})

export async function readAppearance(kv: Pick<KeyValueStore, 'getItem'>): Promise<Appearance> {
  const stored = await kv.getItem(APPEARANCE_KEY).catch(() => null)
  return isAppearance(stored) ? stored : 'system'
}

export function useAppearance(): AppearanceState {
  return useContext(AppearanceContext)
}
