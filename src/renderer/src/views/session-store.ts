import type { StoreApi, UseBoundStore } from 'zustand'
import { useSessionStore } from '../store/session-store'
import type { Session, SessionGroup } from '../store/session-types'
import type { AgentState } from '../../../shared/session-model'

// The legacy store's circular initializer currently leaks `any`. Keep every
// native-view call behind an explicit, narrow boundary until that store is typed.
interface ViewSessionState {
  sessions: Session[]
  groups: SessionGroup[]
  focusedSessionId: string | null
  removeSession: (id: string) => void
  setFocusedSession: (id: string) => void
  updateSessionAlive: (id: string, alive: boolean) => void
  setAgentState: (id: string, state: Exclude<AgentState, 'ended'>) => void
}
export const useViewSessionStore: UseBoundStore<StoreApi<ViewSessionState>> = useSessionStore
