import { AgentStateSchema, type AgentState, type Session } from '../../../shared/session-model'

/* The kernel record is the one source of an events session's state: the main
   process publishes every `state_change` on `agent:state:<id>` and keeps the
   same word on the session record. A view may paint from it; nothing in the
   renderer may write it from a view's own reading of the transcript. This
   binding is the whole of that rule, kept out of the component so it can be
   tested without a window. */

export interface KernelStateBridge {
  onAgentState: (sessionId: string, callback: (state: string) => void) => () => void
  sessionsList: () => Promise<Session[]>
}

export interface KernelStateSink {
  /** Whether the sidebar still holds this session as running. */
  isAlive: (sessionId: string) => boolean | undefined
  setAlive: (sessionId: string, alive: boolean) => void
  setState: (sessionId: string, state: Exclude<AgentState, 'ended'>) => void
}

/**
 * Paint `sessionId`'s sidebar state from the kernel until the returned
 * disposer runs: the live channel first, then the session record for the state
 * that was already true when this binding was made. Returns the disposer.
 */
export function bindKernelState(
  sessionId: string,
  bridge: KernelStateBridge,
  sink: KernelStateSink
): () => void {
  let active = true
  let receivedState = false
  const apply = (state: string): void => {
    // The kernel's vocabulary is AgentState and nothing else. Validating against
    // the schema rather than a hand-written list is what makes a word added to
    // the model reach the sidebar instead of being dropped in silence.
    const parsed = AgentStateSchema.safeParse(state)
    if (!parsed.success) return
    if (parsed.data === 'ended') {
      if (sink.isAlive(sessionId)) sink.setAlive(sessionId, false)
      return
    }
    sink.setState(sessionId, parsed.data)
  }
  const stop = bridge.onAgentState(sessionId, (state) => {
    receivedState = true
    apply(state)
  })
  // Bind before reading so mounting/remounting cannot miss a transition, and
  // never let an older list response overwrite a state already received live.
  void bridge
    .sessionsList()
    .then((records) => {
      const record = records.find((s) => s.id === sessionId)
      if (active && !receivedState && record) apply(record.state)
    })
    .catch(console.error)
  return () => {
    active = false
    stop()
  }
}
