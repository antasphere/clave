import { create } from 'zustand'
import type { SessionRecord } from '../../../preload/index.d'

/** Launch-gate state for the restore prompt. The rule (deliberate UX): a
 *  session that was never disrupted (live tmux survivor) comes back silently;
 *  anything that needs an actual RELAUNCH — plain records, or tmux records
 *  whose server died — is offered here first, because bringing it back means
 *  starting processes on the user's behalf. */
interface RestorePromptState {
  pending: SessionRecord[] | null
  resolver: ((restore: boolean) => void) | null
}

export const useRestorePromptStore = create<RestorePromptState>(() => ({
  pending: null,
  resolver: null
}))

/** Ask whether to relaunch the dead survivors. Boot awaits the answer — the
 *  dialog is modal, so the choice is settled before groups are restored and
 *  sidebar persistence turns on. */
export function promptRestore(records: SessionRecord[]): Promise<boolean> {
  return new Promise((resolve) => {
    useRestorePromptStore.setState({
      pending: records,
      resolver: (restore: boolean) => {
        useRestorePromptStore.setState({ pending: null, resolver: null })
        resolve(restore)
      }
    })
  })
}
