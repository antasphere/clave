import type { ChildProcess, SpawnOptions } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync, statSync } from 'fs'
import { createServer } from 'net'
import { isAbsolute, resolve } from 'path'
import type { SlidelessSnapshot } from '../../shared/slideless'
import type { ResolvedCli } from './slideless-cli'

/**
 * The artefacts Clave shows, each served by one `slideless dev` child
 * (PRDCT-4262). A target is a folder or one .html file; every holder of the
 * same target (two windows, a panel re-mounted) shares its server, which stops
 * with its last holder or when Clave quits. The child is the CLI run with
 * Electron's own Node (`ELECTRON_RUN_AS_NODE`), on a free loopback port, its
 * versions kept in Clave's own store; its address is the `url` of the one JSON
 * line it prints on start.
 *
 * The child runs under the preview host (`preview-host.ts`, PRDCT-4472) with
 * its input a pipe this process holds open and never writes to: when this
 * process ends, however it ends, the pipe closes and the preview ends with
 * it. A holder here is named `holder`, never `lease`: a lease is the
 * forwarder's (`ForwardRegistry`), handed to a window by the artefact service.
 *
 * Saving a version is the dev server's own route, `POST /__slideless/snapshot`
 * with the header `x-slideless: snapshot`, called from here: a request from
 * Node carries no Origin, which is what the route accepts besides its own page.
 */

export interface ServerDeps {
  spawn: (command: string, args: string[], options: SpawnOptions) => ChildProcess
  fetch: typeof globalThis.fetch
  /** Electron's executable: run as Node through ELECTRON_RUN_AS_NODE. */
  execPath: string
  /** The preview host the CLI runs under (`preview-host.ts`): it exits when its input closes. */
  hostPath: string
  /** Where the versions are kept (the CLI's --store). */
  store: string
  /** The CLI to run, or why there is none. */
  resolveCli: () => { cli: ResolvedCli } | { cli: null; reason: string }
  env?: NodeJS.ProcessEnv
  /** How long a child may take to print its address. */
  startTimeoutMs?: number
  /** A server that still had holders exited on its own (a crash): the holders may serve again. */
  onExit?: (target: string) => void
  log?: (message: string) => void
}

interface Running {
  target: string
  /** Null while the port is being found: the entry exists before the child does. */
  child: ChildProcess | null
  url: Promise<string>
  holders: number
  /** Set by stop(): the exit that follows is ours, not a crash. */
  stopped: boolean
  /** Set once the child printed its address: only a server that started can crash. */
  started: boolean
  /** Who holds this server, by holder: a release with another server's holder does nothing here. */
  holderIds: Set<string>
}

export interface Served {
  url: string
  /** What the holder hands back to release: it names this server, not just the target. */
  holder: string
}

const SNAPSHOT_TIMEOUT_MS = 30_000

/** A free port on the loopback, as the OS hands one out. */
export function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer()
    probe.unref()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => (port ? resolvePort(port) : reject(new Error('No free port'))))
    })
  })
}

/** The target as a key: absolute, normalised, and an existing folder or .html file. */
export function artefactTarget(raw: string): string {
  if (typeof raw !== 'string' || !isAbsolute(raw))
    throw new Error('An artefact is an absolute path')
  const target = resolve(raw)
  if (!existsSync(target)) throw new Error(`No such file or folder: ${target}`)
  const info = statSync(target)
  if (info.isFile() && !/\.html?$/i.test(target))
    throw new Error('An artefact is a folder or an .html file')
  if (!info.isFile() && !info.isDirectory())
    throw new Error('An artefact is a folder or an .html file')
  return target
}

export class PreviewServers {
  private readonly running = new Map<string, Running>()

  constructor(private readonly deps: ServerDeps) {}

  /** Start (or join) the server of a target and answer its address. */
  async serve(raw: string): Promise<Served> {
    const target = artefactTarget(raw)
    const holder = randomUUID()
    const existing = this.running.get(target)
    if (
      existing &&
      !existing.stopped &&
      (existing.child === null || existing.child.exitCode === null)
    ) {
      existing.holderIds.add(holder)
      existing.holders++
      return { url: await existing.url, holder }
    }
    const resolved = this.deps.resolveCli()
    if (!resolved.cli) throw new Error(resolved.reason)
    const cliPath = resolved.cli.cliPath
    // The entry is recorded BEFORE anything is awaited: a second caller in the
    // same moment joins this start instead of spawning a second child.
    const entry: Running = {
      target,
      child: null,
      url: Promise.resolve(''),
      holders: 1,
      stopped: false,
      started: false,
      holderIds: new Set([holder])
    }
    entry.url = (async () => {
      const port = await freePort()
      if (entry.stopped) throw new Error('Released before it started')
      const child = this.deps.spawn(
        this.deps.execPath,
        [
          this.deps.hostPath,
          cliPath,
          'dev',
          target,
          '--port',
          String(port),
          '--no-open',
          '--json',
          '--store',
          this.deps.store
        ],
        {
          env: { ...(this.deps.env ?? process.env), ELECTRON_RUN_AS_NODE: '1' },
          // The input is the host's line to this process: held open, never
          // written to, closed by the system when this process ends.
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true
        }
      )
      entry.child = child
      child.once('exit', () => {
        // Only a server that had started can crash: a child that fails while
        // starting gave its holder the error already, and reporting it would
        // start a CLI that cannot start again, forever.
        const crashed = entry.started && !entry.stopped && entry.holders > 0
        if (this.running.get(target) === entry) this.running.delete(target)
        if (crashed) this.deps.onExit?.(target)
      })
      const url = await this.readAddress(child, target)
      entry.started = true
      return url
    })()
    this.running.set(target, entry)
    try {
      return { url: await entry.url, holder }
    } catch (err) {
      this.stop(entry)
      throw err
    }
  }

  /**
   * One holder lets go, by the holder its serve answered; the last one stops
   * the server. The holder of a server that is gone (it crashed, and another
   * holder serves a new one) does nothing to the new one.
   */
  release(raw: string, holder: string): void {
    const entry = this.running.get(resolve(raw))
    if (!entry || !entry.holderIds.delete(holder)) return
    entry.holders--
    if (entry.holders <= 0) this.stop(entry)
  }

  /** Save a version of a served target. */
  async snapshot(raw: string): Promise<SlidelessSnapshot> {
    const entry = this.running.get(resolve(raw))
    if (!entry) throw new Error('This artefact is not being served')
    const base = await entry.url
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), SNAPSHOT_TIMEOUT_MS)
    try {
      const res = await this.deps.fetch(`${base}__slideless/snapshot`, {
        method: 'POST',
        headers: { 'x-slideless': 'snapshot' },
        signal: controller.signal
      })
      const body = (await res.json().catch(() => ({}))) as {
        version?: unknown
        created?: unknown
        error?: unknown
      }
      if (!res.ok || typeof body.version !== 'number')
        throw new Error(
          typeof body.error === 'string' ? body.error : `Snapshot answered ${res.status}`
        )
      return { version: body.version, created: body.created === true }
    } finally {
      clearTimeout(timer)
    }
  }

  /** The targets being served, for tests and diagnostics. */
  targets(): string[] {
    return [...this.running.keys()]
  }

  stopAll(): void {
    for (const entry of [...this.running.values()]) this.stop(entry)
  }

  private stop(entry: Running): void {
    entry.stopped = true
    if (this.running.get(entry.target) === entry) this.running.delete(entry.target)
    if (entry.child && entry.child.exitCode === null && !entry.child.killed) entry.child.kill()
  }

  private readAddress(child: ChildProcess, target: string): Promise<string> {
    return new Promise((resolveUrl, reject) => {
      let buffer = ''
      let errors = ''
      const timer = setTimeout(
        () => fail(new Error('Slideless did not start in time')),
        this.deps.startTimeoutMs ?? 15_000
      )
      const done = (): void => {
        clearTimeout(timer)
        child.stdout?.off('data', onData)
        child.off('exit', onExit)
        // Keep draining: a full pipe would stall the child.
        child.stdout?.resume()
      }
      const fail = (err: Error): void => {
        done()
        reject(err)
      }
      const onData = (chunk: Buffer): void => {
        buffer += chunk.toString('utf8')
        let newline: number
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (!line.startsWith('{')) continue
          try {
            const parsed = JSON.parse(line) as { url?: unknown }
            if (
              typeof parsed.url === 'string' &&
              /^http:\/\/127\.0\.0\.1:\d+\/$/.test(parsed.url)
            ) {
              done()
              resolveUrl(parsed.url)
              return
            }
          } catch {
            // Not the address line.
          }
        }
      }
      const onExit = (code: number | null): void => {
        const reason = errors.trim().split('\n').pop()
        fail(new Error(reason || `Slideless exited (${code ?? 'signal'}) while starting ${target}`))
      }
      child.stdout?.on('data', onData)
      child.stderr?.on('data', (chunk: Buffer) => {
        errors = (errors + chunk.toString('utf8')).slice(-4000)
      })
      child.on('exit', onExit)
      child.on('error', (err) => fail(err))
    })
  }
}
