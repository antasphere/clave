/**
 * The plugins as the server's `Plugins` port (`packages/server/src/plugins/port.ts`,
 * PRDCT-3433): the store, the host, the view leases, the secret requests and
 * the focused session, in one object built in whichever process runs the
 * server. Electron main builds it over `utilityProcess` with the OS
 * notification (`shell-plugins.ts`); the standalone server builds it over a
 * forked runner and tells its clients when a plugin notifies
 * (`standalone-plugins.ts`). Nothing here imports Electron: the folder
 * dialog, the notification, the preview protocol that mints a page's URL and
 * the window a focus report comes from are the shell's, outside this file.
 *
 * What moved here from `ipc-handlers/plugin-ipc.ts` kept its rules: a view's
 * lease fixes ONE session at its birth and every later call names the lease;
 * the grants are read at each call, not at the lease's; a stopped plugin keeps
 * no lease and no pending secret; a plugin's adapters are re-synced into this
 * process's session manager on every change, so a session the server starts
 * can run them.
 */
import { randomUUID } from 'node:crypto'
import type { PluginsEvent, PluginsService } from '@clave/server'
import type {
  PluginPage,
  PluginRecord as WirePluginRecord,
  PluginSecretRequest,
  PluginViewLease
} from '@clave/contract/plugins'
import type { PluginPermission, PluginSession } from '@clave/plugin-sdk'
import { SessionInputSchema } from '../../shared/session-model'
import { syncPluginAdapters } from '../sessions/plugin-adapters'
import { pluginSessionOf } from '../sessions/plugin-sessions'
import { type SessionManager, sessionManager } from '../sessions/session-manager'
import { PluginHost, type RunnerSpawner } from './plugin-host'
import { PluginStore, pluginFile, type PluginRecord } from './plugin-store'

export interface PluginNotice {
  readonly pluginId: string
  readonly name: string
  readonly title: string
  readonly body?: string
}

export interface PluginServiceOptions {
  /** Where the installed plugins live (`installed.json`, `plugins/`). */
  readonly root: string
  /** The folder of the plugins the app ships. */
  readonly bundled: string
  /** The host's version, the one a manifest's `engines.clave` is judged against. */
  readonly version: string
  readonly spawner: RunnerSpawner
  /** Shows a plugin's notification to the person, when this entry can. Absent,
   *  the service tells its listeners (`plugins.notified`) and shows nothing. */
  readonly notify?: (notice: PluginNotice) => void
  /** The sessions the plugins read and write: this process's manager. */
  readonly manager?: SessionManager
  /** How long a secret request waits for an answer; two minutes by default. */
  readonly secretTimeoutMs?: number
}

export interface PluginService extends PluginsService {
  readonly store: PluginStore
  readonly host: PluginHost
  /** Stop every plugin process; the entry calls it at its quit. */
  close(): void
}

/** One policy for every plugin page: its own files, inline scripts and
 *  styles, and the network only when the plugin was granted it. */
export function pluginCsp(record: PluginRecord): string {
  const net = record.permissionsGranted.includes('net') ? 'https: http:' : ''
  return `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: ${net}; connect-src 'self' ${net}; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`
}

interface ViewLease {
  pluginId: string
  viewId: string
  sessionId: string
  file: string
}

interface SecretRequest {
  pluginId: string
  title: string
  description?: string
  resolve: (value: string | null) => void
  timer: NodeJS.Timeout
}

export function createPluginService(options: PluginServiceOptions): PluginService {
  const manager = options.manager ?? sessionManager
  const store = new PluginStore(options.root, options.bundled, options.version)
  store.discover()
  syncPluginAdapters(store)

  const listeners = new Set<(event: PluginsEvent) => void>()
  const emit = (event: PluginsEvent): void => {
    for (const listener of [...listeners]) {
      try {
        listener(event)
      } catch (error) {
        console.error('[plugins] listener failed:', error)
      }
    }
  }
  const changed = (): void => {
    syncPluginAdapters(store)
    emit({ _tag: 'plugins.changed' })
  }

  /** Which session the person is looking at: each window reports its own,
   *  and the most recent report wins, since the last window to move focus is
   *  the window the person is in. A window that closes clears its report
   *  through the same call, from the shell that saw it close. */
  let focused: { windowKey: string; sessionId: string } | null = null
  const viewLeases = new Map<string, ViewLease>()
  const revokeLeasesOf = (pluginId: string): void => {
    for (const [id, lease] of viewLeases) if (lease.pluginId === pluginId) viewLeases.delete(id)
  }
  const secretRequests = new Map<string, SecretRequest>()
  const clearSecrets = (pluginId: string): void => {
    for (const [key, request] of secretRequests)
      if (request.pluginId === pluginId) {
        clearTimeout(request.timer)
        secretRequests.delete(key)
        request.resolve(null)
      }
  }

  const host = new PluginHost(
    store,
    {
      sessions: {
        // The whole service reads the session registry, not the PTY manager:
        // one row per live session whatever its transport, `alive` from the
        // record's own state, and focus resolved the same way, so `list` and
        // `focused` can never disagree about a chat session.
        list: () => manager.list().map(pluginSessionOf),
        focused: () => {
          if (!focused) return null
          const session = manager.get(focused.sessionId)
          return session ? pluginSessionOf(session) : null
        },
        send: (id, text) => {
          const session = manager.get(id)
          if (!session || session.state === 'ended') throw new Error('Session is not running')
          // A granted sessions.write must reach a chat session too, not only a terminal.
          manager.write(
            id,
            session.transport === 'events'
              ? { type: 'user_message', text }
              : new TextEncoder().encode(text)
          )
        }
      },
      // A linked plugin edited on disk re-discovers through the host's own
      // watcher, which never passes through the commands below.
      changed,
      stopped: (id) => {
        // A stopped plugin keeps no authority over a session: its panes go
        // blank on the next render, and their leases answer nothing before.
        revokeLeasesOf(id)
        clearSecrets(id)
      },
      notify: (id, title, body) => {
        const notice: PluginNotice = {
          pluginId: id,
          name: store.get(id).manifest?.name ?? id,
          title,
          ...(body !== undefined && { body })
        }
        if (options.notify) options.notify(notice)
        else emit({ _tag: 'plugins.notified', ...notice })
      },
      requestSecret: (pluginId, title, description) => {
        if ([...secretRequests.values()].some((r) => r.pluginId === pluginId))
          return Promise.reject(new Error('A secret request is already pending'))
        return new Promise((resolve) => {
          const id = randomUUID()
          const timer = setTimeout(() => {
            secretRequests.delete(id)
            resolve(null)
            emit({ _tag: 'plugins.changed' })
          }, options.secretTimeoutMs ?? 120_000)
          secretRequests.set(id, {
            pluginId,
            title,
            ...(description !== undefined && { description }),
            resolve,
            timer
          })
          emit({ _tag: 'plugins.changed' })
        })
      }
    },
    options.spawner
  )
  // A session that is gone takes its leases with it: nothing is left holding
  // authority over an id the manager no longer knows.
  manager.subscribeRemoved((sessionId) => {
    for (const [id, lease] of viewLeases) if (lease.sessionId === sessionId) viewLeases.delete(id)
  })

  const active = (record: PluginRecord): boolean =>
    record.enabled && record.status === 'active' && !record.error

  const service: PluginService = {
    store,
    host,
    list: () => store.list() as unknown as ReadonlyArray<WirePluginRecord>,
    enable: (id, grants) => {
      if (!Array.isArray(grants)) throw new Error('Permission grants are required')
      store.enable(id, grants as PluginPermission[])
      syncPluginAdapters(store)
      host.start(id)
      emit({ _tag: 'plugins.changed' })
    },
    disable: (id) => {
      store.disable(id)
      syncPluginAdapters(store)
      host.stop(id)
      emit({ _tag: 'plugins.changed' })
    },
    link: (folder) => {
      const id = store.link(folder)
      host.reload()
      syncPluginAdapters(store)
      return id
    },
    remove: (id) => {
      if (store.get(id).source === 'bundled')
        throw new Error('Bundled plugins can be disabled, not removed')
      host.stop(id)
      store.remove(id)
      syncPluginAdapters(store)
      emit({ _tag: 'plugins.changed' })
    },
    command: (id, command) => host.execute(id, command),
    panel: (pluginId, panelId): PluginPage => {
      const record = store.get(pluginId)
      if (
        !active(record) ||
        !record.panels.includes(panelId) ||
        record.manifest?.ui !== 'surface' ||
        !record.manifest.uiEntry
      )
        throw new Error('Panel is not active')
      return { file: pluginFile(record.directory, record.manifest.uiEntry), csp: pluginCsp(record) }
    },
    context: (windowKey, sessionId) => {
      if (sessionId !== null && (typeof sessionId !== 'string' || sessionId.length > 256))
        throw new Error('Invalid session id')
      if (sessionId === null) {
        if (focused?.windowKey === windowKey) focused = null
      } else focused = { windowKey, sessionId }
      host.contextChanged()
    },
    /** Open a plugin's view on ONE session: check the plugin, the contribution
     *  and the grant, then hand back the page and a lease id. The session id is
     *  fixed here and never travels again: every later call names the lease. */
    leaseView: (pluginId, viewId, sessionId): PluginViewLease => {
      const record = store.get(pluginId)
      const manifest = record.manifest
      if (!active(record) || manifest?.ui !== 'surface' || !manifest.uiEntry)
        throw new Error('View is not active')
      const view = manifest.contributes.views.find((entry) => entry.id === viewId)
      if (!view) throw new Error('Undeclared view')
      if (!record.permissionsGranted.includes('sessions.read'))
        throw new Error('Plugin may not read sessions')
      const session = manager.get(sessionId)
      if (!session) throw new Error('Unknown session')
      if (!view.renders.includes(session.transport))
        throw new Error('View does not render this transport')
      const file = pluginFile(record.directory, manifest.uiEntry)
      const leaseId = randomUUID()
      viewLeases.set(leaseId, { pluginId, viewId, sessionId, file })
      manager.ready(sessionId)
      return { leaseId, sessionId, file, csp: pluginCsp(record) }
    },
    /** One call from a plugin view, relayed by the pane that holds its lease.
     *  The grants are read HERE, not at the lease's birth: a permission taken
     *  away stops the next write, not only the next pane. */
    requestView: (leaseId, method, params) => {
      const lease = viewLeases.get(leaseId)
      if (!lease) throw new Error('Unknown view lease')
      const record = store.get(lease.pluginId)
      if (!active(record)) throw new Error('View is not active')
      const session = manager.get(lease.sessionId)
      if (!session) throw new Error('Unknown session')
      if (method === 'session.get') {
        if (!record.permissionsGranted.includes('sessions.read'))
          throw new Error('Plugin may not read sessions')
        return session
      }
      if (method === 'session.write') {
        if (!record.permissionsGranted.includes('sessions.write'))
          throw new Error('Plugin may not write sessions')
        // The lease's session, never one the guest named: `params` carries the
        // input and nothing else that could select a target.
        manager.write(lease.sessionId, SessionInputSchema.parse(params))
        return null
      }
      throw new Error(`Unknown plugin view method: ${method}`)
    },
    revokeView: (leaseId) => {
      viewLeases.delete(leaseId)
    },
    secrets: (): ReadonlyArray<PluginSecretRequest> =>
      [...secretRequests].map(([id, { pluginId, title, description }]) => ({
        id,
        pluginId,
        title,
        ...(description !== undefined && { description })
      })),
    replySecret: (id, value) => {
      const request = secretRequests.get(id)
      if (!request) throw new Error('Unknown secret request')
      if (value !== null && (typeof value !== 'string' || value.length > 64_000))
        throw new Error('Invalid secret')
      clearTimeout(request.timer)
      secretRequests.delete(id)
      request.resolve(value)
      emit({ _tag: 'plugins.changed' })
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    close: () => host.close()
  }
  host.startAll()
  return service
}

/** A service whose registry could not be read: every call says why, as the
 *  IPC handlers did, so Settings shows the sentence instead of an empty list. */
export function refusingPluginService(message: string): PluginService {
  const refuse = (): never => {
    throw new Error(message)
  }
  return {
    store: undefined as unknown as PluginStore,
    host: undefined as unknown as PluginHost,
    list: refuse,
    enable: refuse,
    disable: refuse,
    link: refuse,
    remove: refuse,
    command: () => Promise.reject(new Error(message)),
    panel: refuse,
    context: refuse,
    leaseView: refuse,
    requestView: refuse,
    revokeView: refuse,
    secrets: refuse,
    replySecret: refuse,
    subscribe: () => () => {},
    close: () => {}
  }
}

/** What the host tells a plugin about a session; re-exported for the tests. */
export type { PluginSession }
