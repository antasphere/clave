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
import { readScreen, restartSession, typeIntoSession } from './lifecycle'
import { ptyManager } from '../pty-manager'
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
import {
  type SessionInfoResult,
  resizeSession,
  spawnSession,
  stopSession,
  writeTerminal
} from './lifecycle'
import { type SessionRecordsSource, sessionRecords } from './records'

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
  readonly resize: (id: string, cols: number, rows: number) => void
  /** Terminal bytes, as text: the `/clear` watch and the test journal sit
   *  on this road, so the server's bytes take it as the IPC bytes do. */
  readonly writeTerminal: (id: string, text: string) => void
}

export interface SessionHostDeps {
  readonly manager: SessionManager
  readonly lifecycle: SessionLifecycle
  /** Wave 4, lane C: the records a window brings back, their discard and a
   *  session's release (`records.ts`). A host built without one, the tests',
   *  keeps no records and says so. */
  readonly records?: SessionRecordsSource
}

const NO_RECORDS = (): never => {
  throw new Error('This host keeps no session records')
}
const noRecords: SessionRecordsSource = {
  listAdoptableRecords: NO_RECORDS,
  discardRecord: NO_RECORDS,
  release: NO_RECORDS
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

const bytesDecoder = new TextDecoder()

export function createSessionHost(deps: SessionHostDeps): SessionHostService {
  const { manager } = deps
  const records = deps.records ?? noRecords
  /** The key of the window the session's record names, for the per-window
   *  arm of its news when no server publishes them. */
  const windowOf = (id: string): string | null => manager.get(id)?.windowKey ?? null
  const host: SessionHostService = {
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
      if (input.type === 'bytes') {
        if (!manager.get(id)) throw new Error(`Unknown session: ${id}`)
        return deps.lifecycle.writeTerminal(id, bytesDecoder.decode(input.data))
      }
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
    resize: (id, cols, rows) => {
      if (!manager.get(id)) throw new Error(`Unknown session: ${id}`)
      deps.lifecycle.resize(id, cols, rows)
    },
    setView: (id, viewId) => {
      const updated = manager.setView(id, viewId)
      rememberChatView(viewId)
      return updated
    },
    models: (id) => manager.models(id),
    commands: (id) => manager.commands(id),
    capabilities: (id): SessionCapabilities => manager.capabilities(id),
    history: (id, before, limit): HistoryPage => manager.history(id, before, limit),
    // ── Wave 4, lane C: the session records (PRDCT-3376) ──
    listAdoptableRecords: (ids) => records.listAdoptableRecords(ids),
    discardRecord: (key) => records.discardRecord(key),
    release: (ids, fallbackWindowKey) => records.release(ids, fallbackWindowKey),
    // ── Wave 4, lane D: the last agent tools (PRDCT-3377) ──
    rename: (id, name) => {
      const session = manager.get(id)
      if (!session) throw new Error(`Unknown session: ${id}`)
      const folderName = ptyManager.getSession(id)?.folderName ?? ''
      const next = name.trim() || folderName
      // The name on the record, as the sidebar's rename keeps it: equal to
      // the folder name means "no name", and a rename protects it from the
      // auto-title (`userRenamed`).
      ptyManager.setSessionDisplayName(id, next === folderName ? null : next, true)
      return manager.get(id) ?? session
    },
    setPage: (id, page) => {
      if (!manager.get(id)) throw new Error(`Unknown session: ${id}`)
      ptyManager.setSessionViewRecord(id, page)
    },
    screen: (id, lines) => readScreen(id, lines),
    type: async (id, text) => {
      const session = manager.get(id)
      if (!session) throw new Error(`Unknown session: ${id}`)
      if (session.transport === 'events') {
        // A chat tab takes the message as a user message, as the composer's
        // own road does; its draft is the view's and is never in the way.
        await host.write(id, { type: 'user_message', text })
        return { submitted: true, draftHandling: 'none' }
      }
      return typeIntoSession(id, text)
    },
    restart: (id, account, resendRejected) => restartSession(id, { ...account, resendRejected })
  }
  return host
}

let host: SessionHostService | null = null

/** The app's own host, over the session manager and the PTY lifecycle, built
 *  on first use. */
export function getSessionHost(): SessionHostService {
  if (!host) {
    host = createSessionHost({
      manager: sessionManager,
      lifecycle: {
        spawn: spawnSession,
        stop: stopSession,
        resize: resizeSession,
        writeTerminal
      },
      records: sessionRecords
    })
  }
  return host
}

/** For the tests: a host over their own manager, in place of the app's. */
export function setSessionHost(next: SessionHostService | null): void {
  host = next
}

export type { Session }
