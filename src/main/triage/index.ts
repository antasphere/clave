/**
 * "Debug Clave…" in main (issue #227): the running app's sources wired to
 * the core in `prepare.ts`, with the asking window as the origin.
 *
 * One collection at a time per window and call shape: a second ask while one
 * is collecting shares it, so a window that asks twice gets one bundle.
 */
import { app, type BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import * as os from 'os'
import type { TriageOrigin, TriagePrepareResult, TriageSnapshot } from '../../shared/triage'
import { windowRegistry } from '../window-registry'
import { prepareWith, snapshotWith } from './prepare'
import { electronSources } from './sources'

/** This shell's identity for every triage it prepares, minted once. */
const INSTANCE_ID = randomUUID()

export function originFor(win: Pick<BrowserWindow, 'id'> | null): TriageOrigin {
  return {
    instanceId: INSTANCE_ID,
    shellPid: process.pid,
    windowId: win?.id ?? null,
    windowKey: win ? windowRegistry.getKeyForWindow(win.id) : null
  }
}

const inFlight = new Map<string, Promise<unknown>>()

/** A failure the collection did not turn into a typed source outcome is a
 *  bug: it reaches the window as its kind only, never its message, which
 *  could quote what the collection read. */
function opaque<T>(run: () => Promise<T>): () => Promise<T> {
  return () =>
    run().catch((error: unknown) => {
      const kind = error instanceof Error ? error.name : typeof error
      throw new Error(`Debug Clave could not collect this app's facts (${kind})`)
    })
}

function once<T>(key: string, run: () => Promise<T>): Promise<T> {
  const running = inFlight.get(key)
  if (running) return running as Promise<T>
  const started = run()
  inFlight.set(key, started)
  const clear = (): void => {
    if (inFlight.get(key) === started) inFlight.delete(key)
  }
  started.then(clear, clear)
  return started
}

export function triageSnapshot(win: BrowserWindow | null): Promise<TriageSnapshot> {
  return once(
    `snapshot:${win?.id ?? 'none'}`,
    opaque(() => snapshotWith({ sources: electronSources(originFor(win)) }))
  )
}

export function triagePrepare(win: BrowserWindow | null): Promise<TriagePrepareResult> {
  return once(
    `prepare:${win?.id ?? 'none'}`,
    opaque(() =>
      prepareWith({
        sources: electronSources(originFor(win)),
        userData: app.getPath('userData'),
        home: os.homedir()
      })
    )
  )
}
