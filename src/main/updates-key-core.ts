import { chordToAccelerator, type ResolvedKeymapConfig } from '../shared/keymaps'

/* The update key's logic (PRDCT-4832), with no Electron in it: what each
   window reported, which accelerators are held system-wide, which window a
   press goes to, and which windows hear that another one is speaking. The
   wiring (`updates-key.ts`) gives it the OS's shortcuts, the windows and the
   IPC; the unit tests give it fakes.

   - The key is held while some window is active (an update waits or a
     reading is in progress) and the preference is on, under the single-chord
     bindings of `playUpdate`; it follows a keymap change at once, and is
     released by name, never all at once.
   - One voice at a time across windows: each window is told whether ANOTHER
     window is speaking (a reading in progress, or a line being said), sent
     only when that changes for it; a window whose status turns `playing`
     (the person started a reading) makes every other playing window yield. */

export interface UpdatesStatus {
  /** An update waits or a reading is in progress. */
  active: boolean
  /** A reading is in progress (the routing). */
  playing: boolean
  /** A reading is in progress or a line is being said (one voice). */
  speaking: boolean
  oldestAt: number | null
}

export type WindowMessage =
  | { channel: 'updates:toggle' }
  | { channel: 'updates:elsewhere'; value: boolean }
  | { channel: 'updates:yield' }

export interface UpdatesKeyPorts {
  /** Hold an accelerator system-wide, `press` its callback; false when the
   *  OS refuses it. */
  register: (accelerator: string, press: () => void) => boolean
  unregister: (accelerator: string) => void
  /** Send a window a message; false when the window is gone. */
  send: (windowId: number, message: WindowMessage) => boolean
  bindings: () => ResolvedKeymapConfig
  everywhere: () => boolean
  platform: NodeJS.Platform
  /** Said once per accelerator the OS refuses. */
  warn?: (message: string) => void
}

export interface UpdatesKey {
  report: (windowId: number, status: UpdatesStatus) => void
  closed: (windowId: number) => void
  bindingsChanged: () => void
  everywhereChanged: () => void
  /** The key pressed: routed to the window it concerns; whether one was. */
  press: () => boolean
  /** The accelerators held now. */
  held: () => string[]
  /** Let go of everything (quit). */
  release: () => void
}

/** The window the key goes to: a window that is playing wins; else the one
 *  with the oldest waiting update; else none. Pure. */
export function pickWindow(statuses: ReadonlyMap<number, UpdatesStatus>): number | null {
  let oldest: { id: number; at: number } | null = null
  for (const [id, status] of statuses) {
    if (status.playing) return id
    if (status.active && status.oldestAt !== null && (!oldest || status.oldestAt < oldest.at))
      oldest = { id, at: status.oldestAt }
  }
  return oldest?.id ?? null
}

/** The accelerators the key is held under, from the bindings. Pure. */
export function updateAccelerators(
  config: ResolvedKeymapConfig,
  platform: NodeJS.Platform
): string[] {
  const out: string[] = []
  for (const binding of config.bindings.playUpdate ?? []) {
    const accelerator = chordToAccelerator(binding, platform)
    if (accelerator && !out.includes(accelerator)) out.push(accelerator)
  }
  return out
}

/** A window's report, read defensively (a renderer's word is data). Pure. */
export function readStatus(raw: unknown): UpdatesStatus | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  if (typeof value.active !== 'boolean' || typeof value.playing !== 'boolean') return null
  const oldestAt = typeof value.oldestAt === 'number' ? value.oldestAt : null
  const speaking = typeof value.speaking === 'boolean' ? value.speaking : value.playing
  return { active: value.active, playing: value.playing, speaking, oldestAt }
}

export function createUpdatesKey(ports: UpdatesKeyPorts): UpdatesKey {
  const statuses = new Map<number, UpdatesStatus>()
  const told = new Map<number, boolean>()
  let held: string[] = []
  const refused = new Set<string>()

  const release = (): void => {
    for (const accelerator of held) {
      try {
        ports.unregister(accelerator)
      } catch {
        /* already gone */
      }
    }
    held = []
  }

  const press = (): boolean => {
    const id = pickWindow(statuses)
    if (id === null) return false
    if (ports.send(id, { channel: 'updates:toggle' })) return true
    closed(id)
    return false
  }

  const hold = (): void => {
    const wanted = ports.everywhere() && [...statuses.values()].some((s) => s.active)
    const next = wanted ? updateAccelerators(ports.bindings(), ports.platform) : []
    if (next.length === held.length && next.every((a, i) => a === held[i])) return
    release()
    for (const accelerator of next) {
      let ok = false
      try {
        ok = ports.register(accelerator, () => void press())
      } catch {
        ok = false
      }
      if (ok) held.push(accelerator)
      else if (!refused.has(accelerator)) {
        refused.add(accelerator)
        ports.warn?.(`the system refused ${accelerator}; the key works inside Clave`)
      }
    }
  }

  const tell = (): void => {
    for (const id of statuses.keys()) {
      const elsewhere = [...statuses].some(([other, s]) => other !== id && s.speaking)
      if (told.get(id) === elsewhere) continue
      told.set(id, elsewhere)
      ports.send(id, { channel: 'updates:elsewhere', value: elsewhere })
    }
  }

  function closed(id: number): void {
    statuses.delete(id)
    told.delete(id)
    hold()
    tell()
  }

  return {
    report: (id, status) => {
      const before = statuses.get(id)
      statuses.set(id, status)
      // A reading the person starts wins: every other playing window yields.
      if (status.playing && !before?.playing)
        for (const [other, s] of statuses)
          if (other !== id && s.playing) ports.send(other, { channel: 'updates:yield' })
      hold()
      tell()
    },
    closed,
    bindingsChanged: () => {
      release()
      hold()
    },
    everywhereChanged: () => hold(),
    press,
    held: () => [...held],
    release
  }
}
