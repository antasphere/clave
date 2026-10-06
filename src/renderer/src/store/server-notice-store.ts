import { create } from 'zustand'

/**
 * What the server said it cannot do, shown where the sessions would be. A
 * window on a server that runs no sessions (an app attached to a standalone
 * server, before its terminal process exists) gets a declared
 * `CapabilityUnavailable` on its list and on every start; the preload sees the
 * refusal at the client boundary and relays its sentence here
 * (`onServerRefusal`), since the tag does not survive the context bridge. The
 * notice goes down when a routed call next succeeds, so a server that gains
 * the capability takes it with it.
 */
interface ServerNoticeState {
  message: string | null
}

export const useServerNoticeStore = create<ServerNoticeState>(() => ({ message: null }))

let bound = false
/** Bind the store to the preload's relay, once per window. */
export function bindServerNotices(): void {
  if (bound || !window.electronAPI?.onServerRefusal) return
  bound = true
  window.electronAPI.onServerRefusal((refusal) =>
    useServerNoticeStore.setState({ message: refusal?.message ?? null })
  )
}
