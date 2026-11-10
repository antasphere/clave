import { create } from 'zustand'
import type { SlidelessState } from '../../../shared/slideless'

/**
 * The Slideless command line as main manages it (PRDCT-4262): the state every
 * artefact view and the Settings row read, pushed by main on each change and
 * pulled once on first use.
 */
export const useSlidelessStore = create<{
  state: SlidelessState | null
  install: () => Promise<void>
}>((set) => ({
  state: null,
  install: async () => {
    set({ state: await window.electronAPI.slideless.install() })
  }
}))

let started = false
/** Start following main's state; idempotent, so every view may call it. */
export function initSlideless(): void {
  if (started) return
  started = true
  window.electronAPI.slideless.onState((state) => useSlidelessStore.setState({ state }))
  void window.electronAPI.slideless
    .getState()
    .then((state) => useSlidelessStore.setState({ state }))
    .catch(console.error)
}
