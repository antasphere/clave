/**
 * A session's artefact, owned by the server the session runs on (PRDCT-4472).
 *
 * The server keeps the link between a session and its HTML artefact (a
 * folder holding a page, or one `.html` file) in its data folder, runs the
 * Slideless preview beside the files with its own copy of the command line,
 * and saves a version at each finished turn of the session, with no window
 * anywhere. A window that shows the page HOLDS the preview: the first hold
 * starts it and registers its port with the forwarder, so the window reaches
 * it over the server's one port (`ForwardRegistry`); a hold lives ninety
 * seconds unless renewed, and a preview nobody has held for a minute is
 * stopped and its lease given back. A preview that dies under its holders is said to
 * them (`artefact.preview_exited`): they hold again and a new one starts.
 *
 * Built by both entries, in-process by main and standalone by
 * `server-entry.ts`, over the entry's data folder. Imports no Electron,
 * directly or through anything it imports (`service-graph.test.ts`).
 */
import { spawn as spawnChild, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import type { ForwardRegistry } from '@clave/server/forward-registry'
import type {
  Artefact,
  ArtefactEvent,
  ArtefactPreview,
  ArtefactVersion,
  SlidelessState
} from '@clave/contract/artefacts'
import type { AgentState } from '@clave/contract/sessions'
import type { ArtefactsService } from '@clave/server'
import { finishesTurn } from '../../shared/turn-state'
import type { ArtefactLinks } from './links'
import { PreviewServers } from './preview-servers'
import { previewHostPath, writePreviewHost } from './preview-host'
import { DEFAULT_REGISTRY, describeState, installSlideless, resolveCli } from './slideless-cli'

/** How long a hold lives unless it is renewed. */
export const HOLD_TTL_MS = 90_000
/** How often the holds past their time are dropped. */
export const SWEEP_MS = 15_000
/** How long a preview nobody holds is kept running: a person who looks at
 *  another tab and comes back finds the page at once, where a stop at the
 *  last release would start the preview again at every return. */
export const LINGER_MS = 60_000
/** How long a one-shot `slideless snapshot` may run. */
export const SNAPSHOT_COMMAND_TIMEOUT_MS = 60_000
/** A registry to install from instead of npm's (the end-to-end specs' fixture). */
export const REGISTRY_ENV = 'CLAVE_TEST_SLIDELESS_REGISTRY'

export const NO_SUCH_SESSION = 'No such session on this server.'
export const NOT_AN_ARTEFACT = 'An artefact is a folder holding an HTML page, or one .html file.'
export const NOT_ABSOLUTE = 'An artefact is an absolute path.'
export const NO_ARTEFACT_OPEN = 'This session has no artefact open.'
export const NO_PAGE = 'The folder holds no HTML page: write its index.html first'
export const SEVERAL_PAGES =
  'The folder holds several HTML pages and no index.html: name one index.html'

/**
 * The implementation's "no", answered as `ArtefactRefused` with its sentence.
 * Defined here, not imported from the server package: the handlers know it
 * by its name, and this module must not load the framework (the routines'
 * refusal does the same).
 */
export class ArtefactRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArtefactRefusal'
  }
}

export interface ArtefactDeps {
  /** `slideless/cli`, `slideless/versions` and `slideless/preview-host.mjs` live under it. */
  readonly dataDir: string
  /** The Node that runs the command line (the app's binary as Node, or the one named). */
  readonly execPath: string
  /** Read for `CLAVE_SLIDELESS_CLI` and `CLAVE_TEST_SLIDELESS_REGISTRY`. */
  readonly env: NodeJS.ProcessEnv
  readonly links: ArtefactLinks
  readonly forwards: ForwardRegistry
  readonly sessions: {
    /** A live session or a saved record of this server. */
    readonly knows: (sessionId: string) => boolean
    readonly onState: (listener: (sessionId: string, state: AgentState) => void) => () => void
  }
  /** Install Slideless in the background when it is missing (off under test mode with no fixture registry). */
  readonly autoInstall: boolean
  readonly spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess
  readonly fetch?: typeof globalThis.fetch
  readonly now?: () => number
  readonly log?: (message: string) => void
}

export interface ArtefactServiceHandle extends ArtefactsService {
  start(): void
  stop(): Promise<void>
  /** Drop the holds past their time; run every `SWEEP_MS` once started. */
  sweep(): void
}

interface Hold {
  readonly sessionId: string
  readonly target: string
  expiresAt: number
}

interface Preview {
  readonly target: string
  /** What `PreviewServers` named this service's hold on the child. */
  readonly holder: string
  readonly url: string
  readonly lease: string
  readonly releaseLease: () => void
}

/** The folder or file a path names, with its entry page, or the sentence why not. */
function resolveArtefact(path: string): { target: string; page: string; title: string } {
  if (!isAbsolute(path)) throw new ArtefactRefusal(NOT_ABSOLUTE)
  const target = resolve(path)
  if (!existsSync(target)) throw new ArtefactRefusal(`No such file or folder: ${target}`)
  const info = statSync(target)
  if (info.isFile()) {
    if (!/\.html?$/i.test(target)) throw new ArtefactRefusal(NOT_AN_ARTEFACT)
    return { target, page: target, title: basename(target) }
  }
  if (!info.isDirectory()) throw new ArtefactRefusal(NOT_AN_ARTEFACT)
  return { target, page: entryOf(target), title: basename(target) }
}

/** A folder's entry page: index.html, else index.htm, else its one .html file. */
function entryOf(root: string): string {
  for (const name of ['index.html', 'index.htm'])
    if (existsSync(join(root, name)) && statSync(join(root, name)).isFile()) return join(root, name)
  const pages = readdirSync(root).filter(
    (name) => /\.html?$/i.test(name) && statSync(join(root, name)).isFile()
  )
  if (pages.length === 1) return join(root, pages[0]!)
  throw new ArtefactRefusal(pages.length === 0 ? NO_PAGE : SEVERAL_PAGES)
}

/** The sentence a hold or a version is refused with while Slideless is not ready. */
function notReady(state: SlidelessState): string | null {
  switch (state.phase) {
    case 'ready':
      return null
    case 'installing':
      return 'Slideless is being installed on this server.'
    case 'missing':
      return 'Slideless is not installed on this server.'
    case 'error':
      return `Slideless could not be installed on this server: ${state.error ?? 'unknown error'}`
  }
}

const portOf = (url: string): number => Number(new URL(url).port)

export function createArtefactService(deps: ArtefactDeps): ArtefactServiceHandle {
  const spawn = deps.spawn ?? spawnChild
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((message: string): void => console.warn(message))
  const cliDir = join(deps.dataDir, 'slideless', 'cli')
  const store = join(deps.dataDir, 'slideless', 'versions')
  const hostPath = previewHostPath(deps.dataDir)

  const listeners = new Set<(event: ArtefactEvent) => void>()
  const tell = (event: ArtefactEvent): void => {
    for (const listener of [...listeners]) {
      try {
        listener(event)
      } catch (error) {
        log(`[artefacts] a listener failed: ${String(error)}`)
      }
    }
  }

  // ── Slideless, this server's own copy ──
  let installing: Promise<SlidelessState> | null = null
  let lastError: string | null = null
  const state = (): SlidelessState =>
    describeState(resolveCli(cliDir, deps.env), installing !== null, lastError)

  const install = (): Promise<SlidelessState> => {
    if (installing) return installing
    lastError = null
    installing = installSlideless(cliDir, {
      fetch: fetchImpl,
      registry: deps.env[REGISTRY_ENV]?.trim() || DEFAULT_REGISTRY
    })
      .then(() => {
        lastError = null
      })
      .catch((error: unknown) => {
        lastError = error instanceof Error ? error.message : String(error)
        log(`[artefacts] Slideless could not be installed: ${lastError}`)
      })
      .then(() => {
        installing = null
        const next = state()
        tell({ _tag: 'slideless.state_changed', state: next })
        return next
      })
    tell({ _tag: 'slideless.state_changed', state: state() })
    return installing
  }
  const installWhenMissing = (): void => {
    if (deps.autoInstall && state().phase === 'missing') void install()
  }

  // ── The previews and their holds ──
  let hostWritten = false
  const servers = new PreviewServers({
    spawn,
    fetch: fetchImpl,
    execPath: deps.execPath,
    hostPath,
    store,
    env: deps.env,
    resolveCli: () => resolveCli(cliDir, deps.env),
    log,
    // A preview that died under its holders: they are told, and hold again.
    onExit: (target) => previewExited(target)
  })
  const holds = new Map<string, Hold>()
  const previews = new Map<string, Preview>()
  /** A target → when its last hold went; stopped by the sweep `LINGER_MS` later. */
  const idleSince = new Map<string, number>()
  /** Each session's last state, for the turn that ends and the tab that ended. */
  const previousState = new Map<string, AgentState>()
  const starting = new Map<string, Promise<Preview>>()

  const previewFor = (target: string): Promise<Preview> => {
    const running = previews.get(target)
    if (running) return Promise.resolve(running)
    const pending = starting.get(target)
    if (pending) return pending
    const start = (async (): Promise<Preview> => {
      if (!hostWritten) {
        writePreviewHost(deps.dataDir)
        hostWritten = true
      }
      let served: { url: string; holder: string }
      try {
        served = await servers.serve(target)
      } catch (error) {
        throw new ArtefactRefusal(error instanceof Error ? error.message : String(error))
      }
      // The first hold of a running preview registers its port: the window
      // reaches it through the forwarder, never on this machine's loopback.
      const { lease, release } = deps.forwards.register(portOf(served.url))
      const preview: Preview = {
        target,
        holder: served.holder,
        url: served.url,
        lease,
        releaseLease: release
      }
      previews.set(target, preview)
      return preview
    })().finally(() => starting.delete(target))
    starting.set(target, start)
    return start
  }

  /** The preview's end, whatever ended it: its lease goes with it. */
  const forgetPreview = (target: string): Preview | undefined => {
    const preview = previews.get(target)
    if (!preview) return undefined
    previews.delete(target)
    preview.releaseLease()
    return preview
  }

  const stopNow = (target: string): void => {
    idleSince.delete(target)
    const preview = forgetPreview(target)
    if (preview) servers.release(target, preview.holder)
  }

  /** Whether a session that still runs shows this target: a preview is kept
   *  waiting only for a person who may come back to such a tab. A tab that
   *  ended, a tab closed for good or a link that moved on keeps none. */
  const awaited = (target: string): boolean =>
    Object.entries(deps.links.all()).some(
      ([sessionId, link]) =>
        link.target === target &&
        previousState.get(sessionId) !== 'ended' &&
        deps.sessions.knows(sessionId)
    )

  /** A target lost its last hold: kept a minute when a running session shows
   *  it (the sweep stops it then), stopped at once otherwise. */
  const noteIfUnheld = (target: string): void => {
    for (const hold of holds.values()) if (hold.target === target) return
    if (!previews.has(target)) return
    if (!awaited(target)) stopNow(target)
    else if (!idleSince.has(target)) idleSince.set(target, now())
  }

  const dropHold = (holdId: string): void => {
    const hold = holds.get(holdId)
    if (!hold) return
    holds.delete(holdId)
    noteIfUnheld(hold.target)
  }

  const dropSessionHolds = (sessionId: string): void => {
    for (const [holdId, hold] of [...holds]) if (hold.sessionId === sessionId) dropHold(holdId)
  }

  function previewExited(target: string): void {
    idleSince.delete(target)
    forgetPreview(target)
    const told = new Set<string>()
    for (const [holdId, hold] of [...holds]) {
      if (hold.target !== target) continue
      holds.delete(holdId)
      told.add(hold.sessionId)
    }
    for (const sessionId of told) tell({ _tag: 'artefact.preview_exited', sessionId })
  }

  const sweep = (): void => {
    const at = now()
    for (const [holdId, hold] of [...holds]) if (hold.expiresAt <= at) dropHold(holdId)
    for (const [target, since] of [...idleSince]) if (at - since >= LINGER_MS) stopNow(target)
  }

  // ── The versions ──
  const chains = new Map<string, Promise<unknown>>()
  /** One version of a target at a time: a turn's save never races the next. */
  const serially = <A>(target: string, run: () => Promise<A>): Promise<A> => {
    const previous = chains.get(target) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(run)
    const settled = next.catch(() => undefined)
    chains.set(target, settled)
    void settled.then(() => {
      if (chains.get(target) === settled) chains.delete(target)
    })
    return next
  }

  /** `slideless snapshot <target> --store <store> --json`, once, for a target no preview runs. */
  const snapshotCommand = (cliPath: string, target: string): Promise<ArtefactVersion> =>
    new Promise((resolveVersion, reject) => {
      const child = spawn(
        deps.execPath,
        [cliPath, 'snapshot', target, '--store', store, '--json'],
        {
          env: { ...deps.env, ELECTRON_RUN_AS_NODE: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true
        }
      )
      let out = ''
      let errors = ''
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error('Slideless did not save the version in time'))
      }, SNAPSHOT_COMMAND_TIMEOUT_MS)
      child.stdout?.on('data', (chunk: Buffer) => {
        out = (out + chunk.toString('utf8')).slice(-64_000)
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        errors = (errors + chunk.toString('utf8')).slice(-4000)
      })
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        const line = out
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.startsWith('{'))
          .pop()
        try {
          const answer = JSON.parse(line ?? '') as { version?: unknown; created?: unknown }
          if (code === 0 && typeof answer.version === 'number' && Number.isFinite(answer.version)) {
            resolveVersion({ version: answer.version, created: answer.created === true })
            return
          }
        } catch {
          // Not an answer: said below with what the command printed.
        }
        reject(
          new Error(
            errors.trim().split('\n').pop() ||
              `Slideless snapshot exited (${code ?? 'signal'}) without a version`
          )
        )
      })
    })

  const linkOf = (sessionId: string): Artefact | undefined => {
    const link = deps.links.get(sessionId)
    return link && { sessionId, ...link }
  }

  const readyCli = (): string => {
    const resolved = resolveCli(cliDir, deps.env)
    const why = notReady(describeState(resolved, installing !== null, lastError))
    if (why !== null || !resolved.cli) throw new ArtefactRefusal(why ?? NOT_AN_ARTEFACT)
    return resolved.cli.cliPath
  }

  const saveVersion = async (sessionId: string): Promise<ArtefactVersion> => {
    const link = linkOf(sessionId)
    if (!link) throw new ArtefactRefusal(NO_ARTEFACT_OPEN)
    const cliPath = readyCli()
    return serially(link.target, async () =>
      // A running preview saves it itself, so the page in front of a person
      // hears of the new version; with none, the command line runs once.
      servers.targets().includes(link.target)
        ? servers.snapshot(link.target)
        : snapshotCommand(cliPath, link.target)
    )
  }

  // ── A version at each finished turn ──
  const onState = (sessionId: string, next: AgentState): void => {
    const previous = previousState.get(sessionId)
    previousState.set(sessionId, next)
    // The tab ended: its preview is not kept waiting for it.
    const shown = next === 'ended' ? deps.links.get(sessionId) : undefined
    if (shown) noteIfUnheld(shown.target)
    if (!finishesTurn(previous, next)) return
    if (!deps.links.get(sessionId) || state().phase !== 'ready') return
    saveVersion(sessionId).catch((error: unknown) =>
      log(
        `[artefacts] no version saved at the end of a turn of ${sessionId}: ${error instanceof Error ? error.message : String(error)}`
      )
    )
  }

  /** Drop the links whose session this server no longer knows. */
  const dropUnknown = (): void => {
    for (const sessionId of Object.keys(deps.links.all()))
      if (!deps.sessions.knows(sessionId)) {
        dropSessionHolds(sessionId)
        deps.links.remove(sessionId)
      }
  }

  let sweeper: ReturnType<typeof setInterval> | null = null
  let stopStates: (() => void) | null = null

  return {
    open: async (sessionId, path) => {
      if (!deps.sessions.knows(sessionId)) throw new ArtefactRefusal(NO_SUCH_SESSION)
      const { target, page, title } = resolveArtefact(path)
      // The link replaces the session's previous one, and its holds with it:
      // written first, so the preview of a folder the session no longer
      // shows is stopped at once rather than kept waiting.
      const link = { target, page, title, openedAt: new Date(now()).toISOString() }
      deps.links.set(sessionId, link)
      dropSessionHolds(sessionId)
      const artefact: Artefact = { sessionId, ...link }
      tell({ _tag: 'artefact.changed', sessionId, artefact })
      installWhenMissing()
      return artefact
    },
    close: async (sessionId) => {
      // The link goes first, so the preview stops with the holds instead of
      // waiting a minute for a tab that shows it no more.
      const link = deps.links.get(sessionId)
      if (link) deps.links.remove(sessionId)
      dropSessionHolds(sessionId)
      if (!link) return
      noteIfUnheld(link.target)
      tell({ _tag: 'artefact.changed', sessionId, artefact: null })
    },
    hold: async (sessionId, holdId): Promise<ArtefactPreview> => {
      const link = linkOf(sessionId)
      if (!link) throw new ArtefactRefusal(NO_ARTEFACT_OPEN)
      readyCli()
      const known = holdId === undefined ? undefined : holds.get(holdId)
      const preview = await previewFor(link.target)
      // Held again: a preview that was waiting out its minute stays.
      idleSince.delete(link.target)
      if (known && known.sessionId === sessionId && known.target === link.target) {
        known.expiresAt = now() + HOLD_TTL_MS
        return { holdId: holdId!, lease: preview.lease, url: preview.url, ttlMs: HOLD_TTL_MS }
      }
      const id = randomUUID()
      holds.set(id, { sessionId, target: link.target, expiresAt: now() + HOLD_TTL_MS })
      return { holdId: id, lease: preview.lease, url: preview.url, ttlMs: HOLD_TTL_MS }
    },
    release: async (sessionId, holdId) => {
      if (holds.get(holdId)?.sessionId === sessionId) dropHold(holdId)
    },
    saveVersion,
    list: async () => {
      dropUnknown()
      return Object.entries(deps.links.all()).map(([sessionId, link]) => ({ sessionId, ...link }))
    },
    slidelessState: async () => state(),
    installSlideless: () => install(),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    sweep,
    start: () => {
      writePreviewHost(deps.dataDir)
      hostWritten = true
      dropUnknown()
      stopStates ??= deps.sessions.onState(onState)
      if (!sweeper) {
        sweeper = setInterval(sweep, SWEEP_MS)
        sweeper.unref?.()
      }
      installWhenMissing()
    },
    stop: async () => {
      stopStates?.()
      stopStates = null
      if (sweeper) clearInterval(sweeper)
      sweeper = null
      holds.clear()
      idleSince.clear()
      for (const target of [...previews.keys()]) forgetPreview(target)
      servers.stopAll()
    }
  }
}
