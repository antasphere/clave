/**
 * The session host: the shell's sessions as the server's `SessionHost` port
 * (`packages/server/src/sessions/port.ts`), and the one place the session
 * calls are answered whatever transport brought them. The IPC handlers
 * (`ipc.ts`, for a window the server has not reached yet) and the server's
 * handlers (through `src/main/server/clave-server.ts`) both call this object,
 * so a write prepares its attachments, remembers a model pick and asks for a
 * title the same way over either.
 *
 * The object is plain and its methods are looked up at call time, which is
 * what lets the end-to-end hook (`e2e-hooks.ts`) wrap one of them under
 * `--test-no-activate`, the way the specs used to wrap an IPC handler.
 *
 * Nothing here imports Electron (PRDCT-3293): a window is its key, and the
 * standalone server builds the same host over the same manager and lifecycle
 * (`standalone-host.ts`).
 */
import type { SessionHostService, StartInput } from '@clave/server'
import type {
  HistoryPage,
  Session,
  SessionCapabilities,
  SessionInfo,
  SessionStream,
  SessionWrite
} from '@clave/contract/sessions'
import type { SessionInput } from '../../shared/session-model'
import type { PtySpawnOptions } from '../pty-manager'
import { type SessionManager, sessionManager } from './session-manager'
import { preparePrompt } from './attachments'
import * as titleGenerator from '../title-generator'
import { rememberChatEffort, rememberChatModel } from './chat-model-default'
import { rememberChatView } from './chat-view-default'
import { type SessionInfoResult, spawnSession, stopSession } from './lifecycle'

/** Built-in adapters whose `provider_event` is the CLI's own frame, verbatim. */
const RAW_WIRE_PROVIDERS: ReadonlySet<string> = new Set(['claude', 'codex'])

/** The built-in CLIs' raw wire frames stay in main. No view renders them,
 *  and they are most of the stream: a Claude turn that writes one file sends
 *  hundreds of tool-input chunks, and every event a window receives
 *  re-renders its chat; the flood froze the window under long lanes. A
 *  plugin provider's own events still pass: its view may read them. */
export const isRawWireFrame = (value: SessionStream): boolean =>
  value.kind === 'event' &&
  value.event.type === 'provider_event' &&
  RAW_WIRE_PROVIDERS.has(value.event.provider)

export interface SessionLifecycle {
  readonly spawn: (
    windowKey: string | null,
    cwd: string,
    options?: PtySpawnOptions
  ) => Promise<SessionInfoResult>
  readonly stop: (id: string) => Promise<void>
}

export interface SessionHostDeps {
  readonly manager: SessionManager
  readonly lifecycle: SessionLifecycle
}

const asInfo = (result: SessionInfoResult): SessionInfo => ({
  id: result.id,
  cwd: result.cwd,
  folderName: result.folderName,
  alive: result.alive,
  claudeSessionId: result.claudeSessionId,
  piSessionId: result.piSessionId,
  ...(result.launchProfileId !== undefined && { launchProfileId: result.launchProfileId }),
  ...(result.model !== undefined && { model: result.model }),
  ...(result.piProvider !== undefined && { piProvider: result.piProvider }),
  ...(result.piThinking !== undefined && { piThinking: result.piThinking })
})

export function createSessionHost(deps: SessionHostDeps): SessionHostService {
  const { manager } = deps
  /** The key of the window the session's record names, for the per-window
   *  arm of its news when no server publishes them. */
  const windowOf = (id: string): string | null => manager.get(id)?.windowKey ?? null
  return {
    list: (windowKey) => manager.list(windowKey),
    get: (id) => manager.get(id),
    subscribe: (id, listener) => {
      const off = manager.subscribe(id, (value) => {
        if (!isRawWireFrame(value)) listener(value)
      })
      // A pane that subscribes after the list last changed would otherwise
      // show nothing running until the next change.
      const background = manager.background(id)
      if (background.length)
        listener({ kind: 'event', event: { type: 'background_tasks', tasks: background } })
      manager.ready(id)
      return off
    },
    subscribeExit: (id, listener) => manager.subscribeExit(id, listener),
    start: async (input: StartInput) => {
      // `initialInput` is main's own (a restart's resend): a caller's start
      // never carries one, and the wire does not know the field.
      const options = input.options as PtySpawnOptions | undefined
      return asInfo(await deps.lifecycle.spawn(input.windowKey ?? null, input.cwd, options))
    },
    stop: (id) => deps.lifecycle.stop(id),
    write: async (id: string, input: SessionWrite) => {
      if (input.type === 'bytes') return manager.write(id, input.data)
      const value = input as SessionInput
      if (value.type === 'set_model') {
        // The composer's pick is the next chat's default too. Remembered only
        // once the session took the switch: a refused name throws before this.
        manager.write(id, value)
        const adapterId = manager.get(id)?.adapterId
        if (adapterId) rememberChatModel(adapterId, value.model)
        return
      }
      if (value.type === 'set_effort') {
        manager.write(id, value)
        const adapterId = manager.get(id)?.adapterId
        if (adapterId) rememberChatEffort(adapterId, value.effort)
        return
      }
      if (value.type !== 'user_message') return manager.write(id, value)
      // A chat tab is named by its first message, and this is where that
      // message is first seen in main; the title comes back as a server event
      // (or on `session:auto-title:<id>` to the tab's window without a server).
      titleGenerator.notifyChatMessage(id, value.text, windowOf(id))
      // A user message's prepared prompt is main's to build, from the attachment
      // records and the files they name, never the caller's to supply: the
      // files are read here, at send time, against the adapter's capabilities,
      // and a failure rejects the write so the composer keeps its draft.
      const attachments = value.attachments?.length ? value.attachments : undefined
      if (!attachments) return manager.write(id, { type: 'user_message', text: value.text })
      const prepared = await preparePrompt(value.text, attachments, manager.capabilities(id).images)
      manager.write(id, { type: 'user_message', text: value.text, attachments, prepared })
    },
    setView: (id, viewId) => {
      const updated = manager.setView(id, viewId)
      rememberChatView(viewId)
      return updated
    },
    models: (id) => manager.models(id),
    commands: (id) => manager.commands(id),
    capabilities: (id): SessionCapabilities => manager.capabilities(id),
    history: (id, before, limit): HistoryPage => manager.history(id, before, limit)
  }
}

let host: SessionHostService | null = null

/** The app's own host, over the session manager and the PTY lifecycle, built
 *  on first use. */
export function getSessionHost(): SessionHostService {
  if (!host) {
    host = createSessionHost({
      manager: sessionManager,
      lifecycle: { spawn: spawnSession, stop: stopSession }
    })
  }
  return host
}

/** For the tests: a host over their own manager, in place of the app's. */
export function setSessionHost(next: SessionHostService | null): void {
  host = next
}

export type { Session }
