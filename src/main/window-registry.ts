import { BrowserWindow } from 'electron'
import type { WindowIdentity } from '../shared/workspace-types'

export type { WindowIdentity }

/**
 * The WindowRegistry — the single in-main source of truth for multi-window
 * Clave (PRDCT-1703). A window is the whole app once more, on whatever
 * workspace it shows; any number of windows may show the same workspace.
 * The registry answers three questions and nothing else:
 *
 *   1. which window is which: its runtime `BrowserWindow` id, its persisted
 *      `key` (the name of its layout file and the stamp on the session
 *      records it opened), and the workspace it currently shows,
 *   2. which WINDOW hosts each live session (the renderer holding its xterm
 *      and receiving its `pty:data`), bound at spawn / adoption / move,
 *      unbound at exit,
 *   3. which window is the PRIMARY — the lowest live id, re-elected when it
 *      closes while others remain. The primary takes in what a closing
 *      window leaves behind, adopts orphans at boot, and carries app-level
 *      fallbacks.
 *
 * The registry emits nothing; callers route. It is deliberately generic over
 * a minimal `WindowLike` so the class runs in plain node: the unit tests
 * exercise every rule without Electron, and `BrowserWindow.getFocusedWindow`
 * — the one Electron static the resolution ladder needs — is injected. The
 * `windowRegistry` singleton below is the production instance.
 *
 * Nothing here is persisted: BrowserWindow ids restart at 1 on every launch;
 * the keys come from windows.json (window-state.ts).
 */
export interface WindowLike {
  readonly id: number
  isDestroyed(): boolean
}

export interface WindowRegistryDeps<W extends WindowLike> {
  /** `BrowserWindow.getFocusedWindow`, injected so the registry is electron-free. */
  getFocusedWindow: () => W | null
}

interface Entry<W extends WindowLike> {
  win: W
  key: string
  workspaceId: string | null
}

export class WindowRegistry<W extends WindowLike = WindowLike> {
  private readonly windows = new Map<number, Entry<W>>()
  private readonly sessionHosts = new Map<string, number>()
  private primaryId: number | null = null

  constructor(private readonly deps: WindowRegistryDeps<W>) {}

  // ── Windows ────────────────────────────────────────────────────────────────

  registerWindow(win: W, key: string, workspaceId: string | null): void {
    this.windows.set(win.id, { win, key, workspaceId })
    if (this.primaryId === null || !this.isLive(this.primaryId)) this.primaryId = win.id
  }

  /** Forget a window (on 'closed'). Its session bindings are dropped — the
   *  teardown ladder detaches those sessions BEFORE calling this, and the
   *  primary re-adopts them through the spawn path — and the primary is
   *  re-elected as the lowest surviving id when the primary itself left. */
  unregisterWindow(windowId: number): void {
    this.windows.delete(windowId)
    for (const [sessionId, host] of this.sessionHosts) {
      if (host === windowId) this.sessionHosts.delete(sessionId)
    }
    if (this.primaryId === windowId) this.primaryId = this.electPrimary()
  }

  setWindowWorkspace(windowId: number, workspaceId: string | null): void {
    const entry = this.windows.get(windowId)
    if (!entry) return
    entry.workspaceId = workspaceId
  }

  getWindow(windowId: number): W | null {
    return this.isLive(windowId) ? this.windows.get(windowId)!.win : null
  }

  getWindowByKey(key: string): W | null {
    for (const [id, entry] of this.windows) {
      if (entry.key === key && this.isLive(id)) return entry.win
    }
    return null
  }

  getKeyForWindow(windowId: number): string | null {
    return this.isLive(windowId) ? this.windows.get(windowId)!.key : null
  }

  getWorkspaceForWindow(windowId: number): string | null {
    return this.isLive(windowId) ? this.windows.get(windowId)!.workspaceId : null
  }

  /** Every live window showing a workspace, lowest id first. */
  getWindowsForWorkspace(workspaceId: string): W[] {
    return this.listWindows().filter((w) => this.windows.get(w.id)!.workspaceId === workspaceId)
  }

  getPrimaryWindow(): W | null {
    if (this.primaryId === null || !this.isLive(this.primaryId)) {
      this.primaryId = this.electPrimary()
    }
    return this.primaryId === null ? null : this.getWindow(this.primaryId)
  }

  isPrimary(windowId: number): boolean {
    return this.getPrimaryWindow()?.id === windowId
  }

  identityOf(windowId: number): WindowIdentity | null {
    if (!this.isLive(windowId)) return null
    const entry = this.windows.get(windowId)!
    return {
      windowId,
      windowKey: entry.key,
      workspaceId: entry.workspaceId,
      isPrimary: this.isPrimary(windowId)
    }
  }

  /** Live windows, lowest id first. */
  listWindows(): W[] {
    return [...this.windows.keys()]
      .filter((id) => this.isLive(id))
      .sort((a, b) => a - b)
      .map((id) => this.windows.get(id)!.win)
  }

  /** The keys of every live window. */
  liveKeys(): Set<string> {
    return new Set(this.listWindows().map((w) => this.windows.get(w.id)!.key))
  }

  // ── Sessions ───────────────────────────────────────────────────────────────

  bindSession(sessionId: string, windowId: number): void {
    this.sessionHosts.set(sessionId, windowId)
  }

  unbindSession(sessionId: string): void {
    this.sessionHosts.delete(sessionId)
  }

  getWindowForSession(sessionId: string): W | null {
    const host = this.sessionHosts.get(sessionId)
    return host === undefined ? null : this.getWindow(host)
  }

  getSessionsForWindow(windowId: number): string[] {
    const out: string[] = []
    for (const [sessionId, host] of this.sessionHosts) if (host === windowId) out.push(sessionId)
    return out
  }

  // ── Routing ────────────────────────────────────────────────────────────────

  /** The ladder every UI-landing call resolves through: the subject session's
   *  hosting window → the explicitly named window → the focused window → the
   *  primary → null. Every rung is checked non-destroyed. */
  resolveTargetWindow(opts: { sessionId?: string; windowId?: number }): W | null {
    if (opts.sessionId) {
      const bySession = this.getWindowForSession(opts.sessionId)
      if (bySession) return bySession
    }
    if (opts.windowId !== undefined) {
      const byId = this.getWindow(opts.windowId)
      if (byId) return byId
    }
    const focused = this.deps.getFocusedWindow()
    if (focused && !focused.isDestroyed() && this.windows.has(focused.id)) return focused
    return this.getPrimaryWindow()
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private isLive(windowId: number): boolean {
    const entry = this.windows.get(windowId)
    return !!entry && !entry.win.isDestroyed()
  }

  private electPrimary(): number | null {
    let lowest: number | null = null
    for (const id of this.windows.keys()) {
      if (this.isLive(id) && (lowest === null || id < lowest)) lowest = id
    }
    return lowest
  }
}

/** The production registry. `BrowserWindow` is only touched inside the
 *  injected lookup, never at import — this module stays loadable in node. */
export const windowRegistry = new WindowRegistry<BrowserWindow>({
  getFocusedWindow: () => BrowserWindow.getFocusedWindow()
})
