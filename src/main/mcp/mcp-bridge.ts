/**
 * How an agent tool reaches a WINDOW (wave 3, PRDCT-3294): through Clave's
 * server, never over Electron IPC. A command the renderer's dispatcher runs
 * (`src/renderer/src/lib/mcp-dispatcher.ts`) is sent as a view request
 * (`@clave/contract/views`): the server pushes it to every attached window
 * with the key of the one it is for, that window runs it and answers through
 * the server, and the answer comes back here. The window a command is for is
 * still main's decision (`mcp-server.ts` resolves it from the caller's tab
 * and the arguments); what moved is the transport, so a server running on its
 * own can carry the same frame later.
 *
 * Until wave 3 this file sent `mcp:command` to the window's web contents and
 * waited on `mcp:response`; the harness's `callMcp` still speaks that IPC
 * pair to the preload directly, which keeps the window-driving specs honest
 * while the app itself never uses it.
 */
import type { BrowserWindow } from 'electron'
import type { ViewsClient } from '@clave/client'
import { VIEW_REQUEST_TIMEOUT_MS } from '@clave/contract/view-deadlines'
import { windowRegistry } from '../window-registry'
import { focusedOrPrimaryWindow } from '../window-routing'
import { noteRoad } from './roads'
import { serverClient } from './server-client'

export interface BridgeWindows<W extends { id: number }> {
  /** The persisted key of a live window; null when the window is not one of the app's. */
  readonly keyOf: (win: W) => string | null
  /** Every live window, lowest id first. */
  readonly list: () => W[]
  /** The window a windowless caller lands in: the focused, else the primary. */
  readonly fallback: () => W | null
}

export interface BridgeOptions<W extends { id: number }> {
  readonly views: () => Promise<Pick<ViewsClient, 'request'>>
  readonly windows: BridgeWindows<W>
}

export interface Bridge<W extends { id: number }> {
  readonly callRenderer: <T>(
    command: string,
    payload: unknown,
    win?: W | null,
    timeoutMs?: number
  ) => Promise<T>
  readonly callRendererAll: <T>(
    command: string,
    payload: unknown,
    timeoutMs?: number
  ) => Promise<{ windowId: number; ok: boolean; result?: T; error?: string }[]>
  readonly requestView: <T>(
    windowKey: string,
    command: string,
    payload: unknown,
    timeoutMs?: number
  ) => Promise<T>
}

const isDestroyed = (win: { isDestroyed?: () => boolean }): boolean =>
  typeof win.isDestroyed === 'function' && win.isDestroyed()

/** The server's refusal, as the error the tools always threw: the window's
 *  own message for a refusal, the deadline for a timeout. */
export function viewError(error: unknown, command: string, timeoutMs: number): Error {
  const tagged = error as { _tag?: string; message?: string }
  if (tagged?._tag === 'ViewRequestRefused')
    return new Error(tagged.message || 'Unknown error in Clave renderer')
  if (tagged?._tag === 'ViewRequestTimeout')
    return new Error(`Clave did not respond to "${command}" within ${timeoutMs}ms`)
  return error instanceof Error ? error : new Error(String(error))
}

export function createBridge<W extends { id: number; isDestroyed?: () => boolean }>(
  options: BridgeOptions<W>
): Bridge<W> {
  const requestView = async <T>(
    windowKey: string,
    command: string,
    payload: unknown,
    timeoutMs = VIEW_REQUEST_TIMEOUT_MS
  ): Promise<T> => {
    const views = await options.views()
    noteRoad(command, 'window')
    try {
      const answer = await views.request({ windowKey, command, payload, timeoutMs })
      return answer.result as T
    } catch (error) {
      throw viewError(error, command, timeoutMs)
    }
  }
  return {
    requestView,
    callRenderer: async (command, payload, win, timeoutMs) => {
      const target = win && !isDestroyed(win) ? win : options.windows.fallback()
      const key = target ? options.windows.keyOf(target) : null
      if (!target || !key) throw new Error('Clave window not available')
      return requestView(key, command, payload, timeoutMs)
    },
    callRendererAll: async (command, payload, timeoutMs) =>
      Promise.all(
        options.windows.list().map(async (win) => {
          const key = options.windows.keyOf(win)
          if (!key) return { windowId: win.id, ok: false, error: 'Clave window not available' }
          try {
            const result = await requestView<never>(key, command, payload, timeoutMs)
            return { windowId: win.id, ok: true, result }
          } catch (err) {
            return {
              windowId: win.id,
              ok: false,
              error: err instanceof Error ? err.message : String(err)
            }
          }
        })
      )
  }
}

const appBridge: Bridge<BrowserWindow> = createBridge<BrowserWindow>({
  views: () => serverClient.api().then((api) => api.views),
  windows: {
    keyOf: (win) => windowRegistry.getKeyForWindow(win.id),
    list: () => windowRegistry.listWindows(),
    fallback: () => focusedOrPrimaryWindow()
  }
})

/**
 * Run a command in ONE window's renderer dispatcher and await its reply. The
 * sidebar state the dispatcher reads is each window's own, so the caller
 * (mcp-server) resolves which window should execute the command and passes it
 * here; with none given, the focused window (else the primary) runs it, the
 * single-window fallback for a windowless MCP client.
 */
export function callRenderer<T>(
  command: string,
  payload: unknown,
  win?: BrowserWindow | null,
  timeoutMs = VIEW_REQUEST_TIMEOUT_MS
): Promise<T> {
  return appBridge.callRenderer<T>(command, payload, win, timeoutMs)
}

/**
 * Run a command in EVERY window and collect all replies: how `clave_list`
 * aggregates across the windows and how a session named by its tab name is
 * found in the one window that holds it. A window that errors or times out
 * is reported, never fatal to the others.
 */
export function callRendererAll<T>(
  command: string,
  payload: unknown,
  timeoutMs = VIEW_REQUEST_TIMEOUT_MS
): Promise<{ windowId: number; ok: boolean; result?: T; error?: string }[]> {
  return appBridge.callRendererAll<T>(command, payload, timeoutMs)
}

/** A command to the window of a known key, for a caller that has the key. */
export function requestView<T>(
  windowKey: string,
  command: string,
  payload: unknown,
  timeoutMs = VIEW_REQUEST_TIMEOUT_MS
): Promise<T> {
  return appBridge.requestView<T>(windowKey, command, payload, timeoutMs)
}
