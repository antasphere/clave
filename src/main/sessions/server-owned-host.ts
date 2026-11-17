import { CapabilityUnavailable } from '@clave/contract/errors'
import { SessionTimeline, type Timeline } from './timeline'
import type { SessionHostService } from '@clave/server'
import type { SidebarLayouts } from '@clave/server/sidebar-layouts'
import { SERVER_LAYOUT_KEY } from '@clave/contract/sidebar'
import type { RestartedSession, Session, SessionRecord } from '@clave/contract/sessions'
import type { SessionManager } from './session-manager'
import { serverHistory } from './server-history'
import { historyPageOf } from './history'
import { resumeOptions } from './resume-options'
import { providerSwitchOptions } from './provider-switch'
import type { PtySpawnOptions } from './adapters/pty-backend'
import type { ServerConversations } from '../session-history/server-conversations'

export interface ServerOwnedHostOptions {
  host: SessionHostService
  sidebar: SidebarLayouts
  dataDir: string
  subscribeAll: SessionManager['subscribeAll']
  ready: (id: string) => void
  /** The live session's current state as a `state_change` frame, with its
   *  run (`SessionManager.currentState`): told to every subscriber the
   *  moment it binds and again when a Resume binds it to the new process
   *  (PRDCT-4191). Absent, nothing is told, as before. */
  currentState?: SessionManager['currentState']
  /** The server's own History (PRDCT-4321): told each tab's conversation as
   *  it changes, and its last word before its record goes, so a deleted tab's
   *  conversation stays listed and resumable. Absent, nothing is kept. */
  conversations?: ServerConversations
  /** Each chat's run kept whole on disk (PRDCT-4666): a stopped tab's
   *  timeline read from its last run's file, and the file removed when the
   *  tab goes for good. Absent, a stopped tab answers its bounded checkpoint. */
  timelines?: {
    stopped(id: string): Timeline | undefined
    forget(id: string): void
  }
}

/** Recover a tab's identity, never its process. Only restart is Resume. */
export function stoppedSession(record: SessionRecord): Session {
  return {
    id: record.id,
    cwd: record.cwd,
    windowKey: SERVER_LAYOUT_KEY,
    state: 'ended',
    createdAt: record.startedAt ?? 0,
    title: record.displayName ?? record.folderName,
    ...(record.workspaceId !== undefined && { workspaceId: record.workspaceId }),
    transport: record.transport ?? 'pty',
    adapterId: record.adapterId ?? 'pty',
    provider: record.codexMode
      ? 'codex'
      : record.piMode
        ? 'pi'
        : record.opencodeMode
          ? 'opencode'
          : record.antigravityMode
            ? 'antigravity'
            : record.claudeMode
              ? 'claude'
              : 'terminal'
  }
}

/** How often a turn's end may re-read a tab's record for the History, at
 *  most, per tab (PRDCT-4321). */
export const OBSERVE_EVERY_MS = 5_000

export function serverOwnedSessionHost(options: ServerOwnedHostOptions): {
  host: SessionHostService
  close: () => void
} {
  const base = options.host
  const sidebar = options.sidebar
  const history = serverHistory(options.dataDir)
  const conversations = options.conversations
  /** When each tab was last observed at a turn's end. */
  const observedAt = new Map<string, number>()
  const stopHistory = options.subscribeAll((id, stream) => {
    // A terminal's screen only: a chat's events are kept whole in its run's
    // file by the manager (PRDCT-4666), never rewritten here at every event.
    if (stream.kind === 'pty') history.record(id, stream)
    // A turn's end is where a tab's conversation shows a change: the first
    // idle after its start, a new conversation after `/clear`. A terminal
    // ends a turn `idle`, a chat `done` (the Claude and Codex adapters), and
    // a tab that stops `ended`. An observe re-reads every record, so a tab is
    // observed at most once per OBSERVE_EVERY_MS from here, and never at a
    // turn's start.
    if (
      conversations &&
      stream.kind === 'event' &&
      stream.event.type === 'state_change' &&
      (stream.event.state === 'idle' ||
        stream.event.state === 'done' ||
        stream.event.state === 'ended')
    ) {
      const now = Date.now()
      const last = observedAt.get(id)
      if (last === undefined || now - last >= OBSERVE_EVERY_MS) {
        observedAt.set(id, now)
        conversations.observe(id)
      }
    }
  })
  const stoppedTimelines = new Map<string, Timeline>()
  /** Drops a stopped tab's cached timeline, releasing its file. */
  const dropStopped = (id: string): void => {
    stoppedTimelines.get(id)?.close()
    stoppedTimelines.delete(id)
  }
  /** Tabs whose run file could not be read, said once each. */
  const unreadable = new Set<string>()
  /** A stopped tab's last run, when its file can be read: a file that cannot
   *  (a data directory restored without its modes) never breaks the tab, it
   *  answers the checkpoint as a tab with no file does. */
  const stoppedRun = (id: string): Timeline | undefined => {
    try {
      return options.timelines?.stopped(id)
    } catch (error) {
      if (!unreadable.has(id)) {
        unreadable.add(id)
        console.error(
          `The run file of session ${id} cannot be read; answering its checkpoint:`,
          error instanceof Error ? error.message : String(error)
        )
      }
      return undefined
    }
  }
  const stoppedTimeline = (id: string): Timeline => {
    let saved = stoppedTimelines.get(id)
    if (!saved) {
      // The last run's file, whole; else the legacy checkpoint, bounded and
      // with no durable ordering generation.
      saved = stoppedRun(id) ?? new SessionTimeline(() => history.read(id).items, true)
      stoppedTimelines.set(id, saved)
    }
    return saved
  }
  const bindings = new Map<string, Set<() => void>>()
  const unsubscriptions = new Set<() => void>()
  const bind = (id: string): void => {
    for (const attach of bindings.get(id) ?? []) attach()
  }
  const follow = (id: string, attach: () => () => void): (() => void) => {
    let off: (() => void) | undefined
    const connect = (): void => {
      off?.()
      off = attach()
    }
    const set = bindings.get(id) ?? new Set<() => void>()
    set.add(connect)
    bindings.set(id, set)
    if (base.get(id)) connect()
    const unsubscribe = (): void => {
      off?.()
      set.delete(connect)
      unsubscriptions.delete(unsubscribe)
      if (!set.size) bindings.delete(id)
    }
    unsubscriptions.add(unsubscribe)
    return unsubscribe
  }
  const close = (): void => {
    stopHistory()
    for (const off of [...unsubscriptions]) off()
    for (const id of [...stoppedTimelines.keys()]) dropStopped(id)
  }
  const pending = new Map<string, Promise<RestartedSession>>()
  const closing = new Set<string>()
  const records = (): readonly SessionRecord[] => base.listAdoptableRecords()
  const recordOf = (id: string): SessionRecord | undefined => records().find((r) => r.id === id)
  const get = (id: string): Session | undefined =>
    base.get(id) ?? (recordOf(id) ? stoppedSession(recordOf(id)!) : undefined)
  const requireLive = (id: string): void => {
    if (!base.get(id))
      throw new Error(`Resume this stopped session explicitly before using it: ${id}`)
  }
  const host: SessionHostService = {
    ...base,
    get,
    list: () => {
      const live = base.list()
      const ids = new Set(live.map((s) => s.id))
      return [
        ...live,
        ...records()
          .filter((r) => !ids.has(r.id))
          .map(stoppedSession)
      ]
    },
    listAdoptableRecords: (ids) =>
      records()
        .filter((r) => !ids || ids.includes(r.id))
        .map((r) => ({
          ...r,
          windowKey: SERVER_LAYOUT_KEY,
          running: !!base.get(r.id),
          live: base.get(r.id) ? r.live : false
        })),
    start: async (input) => {
      if (input.options?.adoptSessionId && recordOf(input.options.adoptSessionId)) {
        throw new Error('Resume this stopped session explicitly with restart')
      }
      const result = await base.start({
        ...input,
        windowKey: SERVER_LAYOUT_KEY,
        options: { ...input.options, tmuxMode: false }
      })
      // A routine's run (ADR 0004) is never a sidebar row: the scheduler
      // starts, watches and stops it, and the daemon's shared sidebar never
      // shows it.
      if (input.options?.link?.kind !== 'routine')
        sidebar.placeSession(
          SERVER_LAYOUT_KEY,
          result.id,
          input.options?.link?.kind === 'group-terminal' ? input.options.link.groupId : null
        )
      bind(result.id)
      if (base.get(result.id)?.transport === 'events') options.ready(result.id)
      conversations?.observe(result.id)
      return result
    },
    stop: async (id) => {
      closing.add(id)
      try {
        // A close racing a resume closes the process that actually landed.
        await pending.get(id)?.catch(() => {})
        const record = recordOf(id)
        await base.stop(id)
        // The record's last word, read again after the stop (a running tab's
        // record can still change as it stops), before the record goes.
        const last = recordOf(id) ?? record
        if (last) conversations?.closing(last)
        if (record) base.discardRecord(record.tmuxName ?? record.id)
        history.remove(id)
        options.timelines?.forget(id)
        observedAt.delete(id)
        dropStopped(id)
        sidebar.removeSession(SERVER_LAYOUT_KEY, id)
      } finally {
        closing.delete(id)
      }
    },
    discardRecord: (key) => {
      const record = records().find((r) => (r.tmuxName ?? r.id) === key)
      if (record && base.get(record.id)) throw new Error('Close a running session through stop')
      if (record) conversations?.closing(record)
      base.discardRecord(key)
      if (record) {
        history.remove(record.id)
        options.timelines?.forget(record.id)
        observedAt.delete(record.id)
        dropStopped(record.id)
        sidebar.removeSession(SERVER_LAYOUT_KEY, record.id)
      }
    },
    subscribe: (id, listener) => {
      if (!get(id)) throw new Error(`Unknown session: ${id}`)
      const saved = history.read(id)
      if (saved.terminal) listener({ kind: 'pty', data: Buffer.from(saved.terminal, 'base64') })
      // A subscriber is told the state it binds to (PRDCT-4191): the pane
      // seeds itself from the list it read at mount, a copy a restart leaves
      // stale, and a resumed chat starts idle, a state nothing publishes when
      // it is already the record's. So the word comes here: at the bind made
      // by this subscribe, and again at the bind a Resume makes on the new
      // process (`bind(id)` below), with the run the state belongs to; a
      // stopped record is told `ended`, with no run, since nothing runs.
      const told = (): void => {
        const live = base.get(id)
        const frame = live ? options.currentState?.(id) : undefined
        if (frame) listener({ kind: 'event', event: frame })
        else if (!live) listener({ kind: 'event', event: { type: 'state_change', state: 'ended' } })
      }
      const unsubscribe = follow(id, () => {
        const off = base.subscribe(id, listener)
        told()
        return off
      })
      // A record with no process yet (a stopped tab) binds nothing above, so
      // its `ended` is said here, once, for the subscriber that just arrived.
      if (!base.get(id)) told()
      return unsubscribe
    },
    subscribeExit: (id, listener) => follow(id, () => base.subscribeExit(id, listener)),
    resize: (id, cols, rows) => {
      if (base.get(id)) base.resize(id, cols, rows)
    },
    history: (id, before, limit) => {
      if (!get(id)) throw new Error(`Unknown session: ${id}`)
      if (base.get(id)) return base.history(id, before, limit)
      // A stopped tab: its last run's file, or its legacy checkpoint.
      return historyPageOf(
        stoppedTimeline(id).read(before === undefined ? undefined : before + 1, limit)
      )
    },
    timeline: (id, before, limit) => {
      if (!get(id)) throw new Error(`Unknown session: ${id}`)
      if (base.get(id)) {
        if (!base.timeline)
          throw new CapabilityUnavailable({
            capability: 'session timeline',
            message: 'This host does not provide ordered conversation history.'
          })
        return base.timeline(id, before, limit)
      }
      return stoppedTimeline(id).read(before, limit)
    },
    write: async (id, input) => {
      requireLive(id)
      await base.write(id, input)
    },
    type: async (id, text) => {
      requireLive(id)
      return base.type(id, text)
    },
    models: (id) => (base.get(id) ? base.models(id) : Promise.resolve([])),
    commands: (id) => (base.get(id) ? base.commands(id) : Promise.resolve([])),
    capabilities: (id) => (base.get(id) ? base.capabilities(id) : { images: false }),
    setView: (id, view) => {
      requireLive(id)
      return base.setView(id, view)
    },
    rename: (id, name) => {
      requireLive(id)
      const renamed = base.rename(id, name)
      conversations?.observe(id)
      return renamed
    },
    setPage: (id, page) => {
      requireLive(id)
      base.setPage(id, page)
    },
    // A `/clear` moves a tab onto a new conversation, and the window keeps
    // it here (PRDCT-4321): the record names the new one from now on, so the
    // History is told now. Left to the next list, a second `/clear` before it
    // would replace the record's conversation unseen, and that one is lost.
    keepOnRecord: (id, fields) => {
      base.keepOnRecord(id, fields)
      if (fields.claudeSessionId) conversations?.observe(id)
    },
    // A session's work is its record's (PRDCT-4123), so a stopped session's
    // can change too: no requireLive. Its Resume carries the work on, the
    // spawn reading the record by the id `resumeOptions` adopts.
    changeWork: (id, change) => base.changeWork(id, change),
    // Releasing a client window is not a server lifecycle operation.
    release: () => ({ released: [], refused: [] }),
    restart: (id, account, resendRejected, onlyIfStopped, provider) => {
      if (closing.has(id)) return Promise.reject(new Error('This session is closing'))
      // A Resume already in flight is joined, whoever asks second (round 5).
      const existing = pending.get(id)
      if (existing) return existing
      // A Resume asked of a RUNNING session is refused here, on the server's
      // own word: a Mac reading a stale view (a connection blip) must never
      // cut a live turn (PRDCT-4193, round 3 C2). Running is a live process:
      // a chat whose CLI exited on its own is still held by the manager, in
      // state ended, and is exactly what a Resume is for (round 5). A move
      // to another account (no `onlyIfStopped`) restarts a running session.
      const live = base.get(id)
      if (onlyIfStopped && live && live.state !== 'ended')
        return Promise.reject(new Error('This session is running; there is nothing to resume.'))
      const resume = async (): Promise<RestartedSession> => {
        if (base.get(id)) {
          // A session the host still holds, running (a move to another
          // account) or ended on its own (a Resume): the new process is a
          // new entry, so the subscribers are bound to it again and it is
          // made ready here, as the stopped-record road below does. Until
          // round 6 nothing started a resumed chat whose CLI had exited
          // until a pane happened to bind (PRDCT-4191).
          // The provider switch (PRDCT-4300) rides through to the lifecycle.
          const result = await base.restart(id, account, resendRejected, undefined, provider)
          bind(id)
          if (base.get(id)?.transport === 'events') options.ready(id)
          dropStopped(id)
          return result
        }
        const record = recordOf(id)
        if (!record) throw new Error(`Unknown session: ${id}`)
        const spawn = resumeOptions(record)
        // A stopped record moved to another provider (PRDCT-4300): the same
        // rebuild of the spawn the lifecycle's restart makes.
        const resumed = { ...spawn, ...account, tmuxMode: false }
        const result = await base.start({
          cwd: record.cwd,
          windowKey: SERVER_LAYOUT_KEY,
          options: provider
            ? // The wire's spawn options mirror the shell's (records-contract.test.ts).
              (providerSwitchOptions(
                resumed as unknown as PtySpawnOptions,
                provider
              ) as unknown as typeof resumed)
            : resumed
        })
        base.keepOnRecord(id, {
          name: {
            displayName: record.displayName ?? null,
            userRenamed: record.userRenamed === true
          },
          page: record.view ?? null
        })
        sidebar.placeSession(
          SERVER_LAYOUT_KEY,
          result.id,
          record.link?.kind === 'group-terminal' ? record.link.groupId : null
        )
        bind(id)
        dropStopped(id)
        if (base.get(id)?.transport === 'events') options.ready(id)
        return { ...result, resumed: !!spawn.resumeSessionId }
      }
      const work = resume()
        .then((result) => {
          conversations?.observe(id)
          return result
        })
        .finally(() => {
          pending.delete(id)
        })
      pending.set(id, work)
      return work
    }
  }
  return { host, close }
}
