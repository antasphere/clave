import type { SessionRecord } from '../../../preload/index.d'

/** Live persistent toolbar-terminal sessions, keyed by `${pinId}:${terminalIndex}`.
 *
 *  These PTYs (dev servers behind toolbar server buttons) are spawned outside
 *  the session store, so the only handle on them used to be component state in
 *  ToolbarTerminalPopover — and workspace switching UNMOUNTS those buttons,
 *  which would orphan a running server and spawn a duplicate on the next
 *  click. This module owns the handle for the session's whole lifetime; the
 *  popover just reads it on mount.
 */
const registry = new Map<string, string>()

/** Toolbar sessions that SURVIVED the last quit, keyed the same way: their
 *  record, parked at boot for the button to reattach to when it is next
 *  opened (PRDCT-1756). A toolbar terminal is not a sidebar citizen — before
 *  this it came back as a mystery tab, and the button, knowing nothing about
 *  it, started a second server on the same port. Nothing is reattached at
 *  boot: the process is running in tmux and costs nothing until looked at. */
const pending = new Map<string, SessionRecord>()

export function adoptPersistentToolbarSession(key: string, sessionId: string): void {
  registry.set(key, sessionId)
  pending.delete(key)
  // The exit listener lives at module level, NOT in the component: a session
  // dying while its workspace is hidden must still clear the entry, or
  // switching back would "reattach" to a corpse.
  const cleanup = window.electronAPI.onSessionExit(sessionId, () => {
    if (registry.get(key) === sessionId) registry.delete(key)
    cleanup()
  })
}

export function getPersistentToolbarSession(key: string): string | null {
  return registry.get(key) ?? null
}

/** Park a survivor for its button (boot restore). */
export function parkToolbarSurvivor(key: string, record: SessionRecord): void {
  if (!registry.has(key)) pending.set(key, record)
}

/** Take the parked survivor for this button, if any — one shot, so a failed
 *  reattach falls through to a fresh spawn rather than looping. */
export function takeToolbarSurvivor(key: string): SessionRecord | null {
  const record = pending.get(key) ?? null
  if (record) pending.delete(key)
  return record
}
