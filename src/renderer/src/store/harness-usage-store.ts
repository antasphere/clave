/**
 * What Pi and OpenCode tabs used, per connection (PRDCT-4551), as the window
 * keeps it: one read per machine (`LOCAL_SERVER_ID` for this Mac or the
 * window's own server, else the saved server's id) and range, from the host
 * that runs the tabs. The places that show it read it here: the launcher's
 * connection rows, the sidebar's foot, Settings → Usage, the Connections card
 * (`useConnectionUsage`), and `clave_launch_options` reads the same answer.
 *
 * Local reads on the host, never on a clock that spends anything: read when
 * a place opens, when a Pi or OpenCode tab's turn ends, and on Refresh.
 */
import { useEffect } from 'react'
import { create } from 'zustand'
import { LOCAL_SERVER_ID } from '@clave/contract/fleet'
import {
  connectionUsageOf,
  harnessUsageText,
  signInUsageOf,
  type HarnessUsageFigures,
  type HarnessUsageBilling,
  type HarnessUsageRange,
  type HarnessUsageView,
  type UsageHarness
} from '@clave/contract/settings/harness-usage-view'

export type HarnessUsageStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface HarnessUsageEntry {
  /** The last answer; kept through a failed read after it. */
  view: HarnessUsageView | null
  status: HarnessUsageStatus
  readAt: number | null
}

const key = (machineId: string, range: HarnessUsageRange): string => `${machineId}\u0000${range}`

export const useHarnessUsageStore = create<{ byKey: Record<string, HarnessUsageEntry> }>(() => ({
  byKey: {}
}))

/** How a machine's usage is read: injected by the window (the IPC and fleet
 *  roads), so this module is tested without one. */
export type HarnessUsageReader = (
  machineId: string,
  range: HarnessUsageRange
) => Promise<HarnessUsageView>

const defaultReader: HarnessUsageReader = (machineId, range) => {
  const api = window.electronAPI
  return machineId === LOCAL_SERVER_ID
    ? api.harnessUsageRead({ range })
    : api.fleetHarnessUsage(machineId, { range })
}
let reader: HarnessUsageReader = defaultReader

/** Test seam: the reader, and forget every read. */
export function setHarnessUsageReader(next: HarnessUsageReader | null): void {
  reader = next ?? defaultReader
  inFlight.clear()
  for (const timer of rereads.values()) clearTimeout(timer)
  rereads.clear()
  useHarnessUsageStore.setState({ byKey: {} })
}

/** A read answered within this long is fresh enough for a place that opens. */
export const HARNESS_USAGE_FRESH_MS = 30_000

const inFlight = new Map<string, Promise<void>>()

/** How soon the window asks again while the host is still reading. */
export const HARNESS_USAGE_REREAD_MS = 2_000
const rereads = new Map<string, ReturnType<typeof setTimeout>>()

function scheduleReread(machineId: string, range: HarnessUsageRange): void {
  const k = key(machineId, range)
  if (rereads.has(k)) return
  rereads.set(
    k,
    setTimeout(() => {
      rereads.delete(k)
      void ensureHarnessUsage(machineId, range, { force: true })
    }, HARNESS_USAGE_REREAD_MS)
  )
}

/** Whether a harness's figures on a machine are still being read: nothing
 *  read yet, or the host said it reads on. */
export function harnessUsageReading(
  entry: HarnessUsageEntry | undefined,
  harness?: UsageHarness
): boolean {
  if (!entry?.view) return entry?.status !== 'error'
  const reading = entry.view.reading ?? []
  return harness ? reading.includes(harness) : reading.length > 0
}

/** The words a place shows while a figure is read. */
export const READING_WORDS = 'Reading…'

/** Read a machine's usage over a range unless it was read a moment ago
 *  (`force`: read it again whatever its age), never twice at once. */
export function ensureHarnessUsage(
  machineId: string,
  range: HarnessUsageRange = 'today',
  options: { force?: boolean } = {}
): Promise<void> {
  const k = key(machineId, range)
  const pending = inFlight.get(k)
  if (pending) return pending
  const entry = useHarnessUsageStore.getState().byKey[k]
  if (
    !options.force &&
    entry?.status === 'ready' &&
    entry.readAt !== null &&
    Date.now() - entry.readAt < HARNESS_USAGE_FRESH_MS
  )
    return Promise.resolve()
  const set = (next: Partial<HarnessUsageEntry>): void => {
    const state = useHarnessUsageStore.getState().byKey
    const current = state[k] ?? { view: null, status: 'idle', readAt: null }
    useHarnessUsageStore.setState({ byKey: { ...state, [k]: { ...current, ...next } } })
  }
  set({ status: 'loading' })
  const run = (async () => {
    try {
      const view = await Promise.resolve().then(() => reader(machineId, range))
      set({ view, status: 'ready', readAt: Date.now() })
      // The host is still reading a harness (OpenCode's first read): what it
      // had is drawn now, and the window asks again until it is done.
      if (view.reading && view.reading.length > 0) scheduleReread(machineId, range)
    } catch {
      set({ status: 'error', readAt: Date.now() })
    } finally {
      inFlight.delete(k)
    }
  })()
  inFlight.set(k, run)
  return run
}

/** Read again every machine and range a place has asked for (Refresh, a
 *  turn's end). */
export function refreshHarnessUsage(machineId?: string): Promise<void> {
  const keys = Object.keys(useHarnessUsageStore.getState().byKey)
  return Promise.all(
    keys
      .map((k) => k.split('\u0000') as [string, HarnessUsageRange])
      .filter(([machine]) => machineId === undefined || machine === machineId)
      .map(([machine, range]) => ensureHarnessUsage(machine, range, { force: true }))
  ).then(() => undefined)
}

/** A machine's entry over a range, or undefined before the first ask. */
export function harnessUsageFor(
  machineId: string,
  range: HarnessUsageRange = 'today'
): HarnessUsageEntry | undefined {
  return useHarnessUsageStore.getState().byKey[key(machineId, range)]
}

/** A machine's entry over a range, redrawn as reads land. */
export function useHarnessUsage(
  machineId: string,
  range: HarnessUsageRange = 'today'
): HarnessUsageEntry | undefined {
  return useHarnessUsageStore((s) => s.byKey[key(machineId, range)])
}

export interface ConnectionUsage {
  figures: HarnessUsageFigures
  billing: HarnessUsageBilling
  /** The one line (`harnessUsageText`). */
  line: string
}

/** A stored connection's usage over a range on its machine, with its line:
 *  its Pi and OpenCode tabs together. Undefined until read, or when the
 *  machine lists no row of it. */
export function connectionUsage(
  entry: HarnessUsageEntry | undefined,
  connectionId: string,
  range: HarnessUsageRange = 'today'
): ConnectionUsage | undefined {
  const used = connectionUsageOf(entry?.view, connectionId)
  return used && { ...used, line: harnessUsageText(used.figures, used.billing, range) }
}

/** A harness's own sign-in's usage over a range, with its line. */
export function signInUsage(
  entry: HarnessUsageEntry | undefined,
  harness: UsageHarness,
  range: HarnessUsageRange = 'today'
): ConnectionUsage | undefined {
  const row = signInUsageOf(entry?.view, harness)
  return (
    row && { figures: row, billing: row.billing, line: harnessUsageText(row, row.billing, range) }
  )
}

/** What the Connections card calls (PRDCT-4552): a connection's usage today
 *  on its machine, read when the card mounts, redrawn as reads land. */
export function useConnectionUsage(
  machineId: string,
  connectionId: string,
  range: HarnessUsageRange = 'today'
): ConnectionUsage | undefined {
  const entry = useHarnessUsage(machineId, range)
  useEffect(() => {
    void ensureHarnessUsage(machineId, range)
  }, [machineId, range])
  return connectionUsage(entry, connectionId, range)
}

/** The launcher's row (`launch-source.ts`): the line, or null until read. */
export function connectionUsageLineFor(machineId: string, connectionId: string): string | null {
  const entry = harnessUsageFor(machineId)
  const line = connectionUsage(entry, connectionId)?.line
  // Drawn at once with what there is: "Reading…" before the first answer,
  // the figure so far while OpenCode is still read; never a wait.
  if (!line) return entry && harnessUsageReading(entry) ? READING_WORDS : null
  return harnessUsageReading(entry) ? `${line} · ${READING_WORDS}` : line
}
