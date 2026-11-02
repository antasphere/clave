import { CapabilityUnavailable } from '@clave/contract/errors'
import { SessionTimeline } from './timeline'
import type { SessionHostService } from '@clave/server'
import type { SidebarLayouts } from '@clave/server/sidebar-layouts'
import { SERVER_LAYOUT_KEY } from '@clave/contract/sidebar'
import type {
  RestartedSession,
  Session,
  SessionRecord,
  SpawnOptions
} from '@clave/contract/sessions'
import type { SessionManager } from './session-manager'
import { pageHistory } from './history'
import { serverHistory } from './server-history'

export interface ServerOwnedHostOptions {
  host: SessionHostService
  sidebar: SidebarLayouts
  dataDir: string
  subscribeAll: SessionManager['subscribeAll']
  ready: (id: string) => void
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
        : record.antigravityMode
          ? 'antigravity'
          : record.claudeMode
            ? 'claude'
            : 'terminal'
  }
}

/** An allowlist deliberately excludes initial commands, prompts and tmux adoption. */
export function resumeOptions(record: SessionRecord): SpawnOptions {
  return {
    adoptSessionId: record.id,
    resumeSessionId: record.codexThreadId ?? record.claudeSessionId,
    claudeSessionId: record.claudeSessionId,
    piSessionId: record.piSessionId,
    claudeMode: record.claudeMode,
    codexMode: record.codexMode,
    antigravityMode: record.antigravityMode,
    piMode: record.piMode,
    claudeAgentsMode: record.claudeAgentsMode,
    dangerousMode: record.dangerousMode,
    model: record.model,
    launchProfileId: record.launchProfileId,
    launchProfile: record.launchProfile,
    piProvider: record.piProvider,
    piThinking: record.piThinking,
    configDir: record.configDir,
    claudeProfileId: record.claudeProfileId,
    claudeProfileLabel: record.claudeProfileLabel,
    codexAccountId: record.codexAccountId,
    codexAccountLabel: record.codexAccountLabel,
    workspaceId: record.workspaceId,
    link: record.link,
    spawnedBy: record.spawnedBy
  }
}

export function serverOwnedSessionHost(options: ServerOwnedHostOptions): {
  host: SessionHostService
  close: () => void
} {
  const base = options.host
  const sidebar = options.sidebar
  const history = serverHistory(options.dataDir)
  const stopHistory = options.subscribeAll((id, stream) => history.record(id, stream))
  const stoppedTimelines = new Map<string, SessionTimeline>()
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
      sidebar.placeSession(
        SERVER_LAYOUT_KEY,
        result.id,
        input.options?.link?.kind === 'group-terminal' ? input.options.link.groupId : null
      )
      bind(result.id)
      if (base.get(result.id)?.transport === 'events') options.ready(result.id)
      return result
    },
    stop: async (id) => {
      closing.add(id)
      try {
        // A close racing a resume closes the process that actually landed.
        await pending.get(id)?.catch(() => {})
        const record = recordOf(id)
        await base.stop(id)
        if (record) base.discardRecord(record.tmuxName ?? record.id)
        history.remove(id)
        stoppedTimelines.delete(id)
        sidebar.removeSession(SERVER_LAYOUT_KEY, id)
      } finally {
        closing.delete(id)
      }
    },
    discardRecord: (key) => {
      const record = records().find((r) => (r.tmuxName ?? r.id) === key)
      if (record && base.get(record.id)) throw new Error('Close a running session through stop')
      base.discardRecord(key)
      if (record) {
        history.remove(record.id)
        stoppedTimelines.delete(record.id)
        sidebar.removeSession(SERVER_LAYOUT_KEY, record.id)
      }
    },
    subscribe: (id, listener) => {
      if (!get(id)) throw new Error(`Unknown session: ${id}`)
      const saved = history.read(id)
      if (saved.terminal) listener({ kind: 'pty', data: Buffer.from(saved.terminal, 'base64') })
      return follow(id, () => base.subscribe(id, listener))
    },
    subscribeExit: (id, listener) => follow(id, () => base.subscribeExit(id, listener)),
    resize: (id, cols, rows) => {
      if (base.get(id)) base.resize(id, cols, rows)
    },
    history: (id, before, limit) => {
      if (!get(id)) throw new Error(`Unknown session: ${id}`)
      if (base.get(id)) {
        const page = base.history(id, before, limit)
        if (page.items.length || page.before !== null) return page
        // An empty older page can mean the adapter cursor reached its start,
        // rather than that the adapter has no transcript. Never mix those offsets.
        if (before !== undefined) {
          const latest = base.history(id)
          if (latest.items.length || latest.before !== null) return page
        }
      }
      // Adapters without available history still have the daemon's captured stream.
      return pageHistory(history.read(id).items, before, limit)
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
      let saved = stoppedTimelines.get(id)
      if (!saved) {
        // A checkpoint is bounded and has no durable ordering generation.
        saved = new SessionTimeline(() => history.read(id).items, true)
        stoppedTimelines.set(id, saved)
      }
      return saved.read(before, limit)
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
      return base.rename(id, name)
    },
    setPage: (id, page) => {
      requireLive(id)
      base.setPage(id, page)
    },
    // Releasing a client window is not a server lifecycle operation.
    release: () => ({ released: [], refused: [] }),
    restart: (id, account, resendRejected) => {
      if (closing.has(id)) return Promise.reject(new Error('This session is closing'))
      const existing = pending.get(id)
      if (existing) return existing
      const resume = async (): Promise<RestartedSession> => {
        if (base.get(id)) {
          const result = await base.restart(id, account, resendRejected)
          bind(id)
          stoppedTimelines.delete(id)
          return result
        }
        const record = recordOf(id)
        if (!record) throw new Error(`Unknown session: ${id}`)
        const spawn = resumeOptions(record)
        const result = await base.start({
          cwd: record.cwd,
          windowKey: SERVER_LAYOUT_KEY,
          options: { ...spawn, ...account, tmuxMode: false }
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
        stoppedTimelines.delete(id)
        if (base.get(id)?.transport === 'events') options.ready(id)
        return { ...result, resumed: !!(spawn.resumeSessionId || spawn.piSessionId) }
      }
      const work = resume().finally(() => {
        pending.delete(id)
      })
      pending.set(id, work)
      return work
    }
  }
  return { host, close }
}
