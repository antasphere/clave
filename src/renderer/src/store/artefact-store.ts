import { create } from 'zustand'
import { parseSessionKey } from '@clave/contract/fleet'
import type { Artefact, SlidelessState } from '@clave/contract/artefacts/model'

/**
 * The sessions' artefacts as the window shows them (PRDCT-4474). The servers
 * own the artefacts: each session's link, its preview and its versions live
 * on the server the session runs on, and this store only mirrors what they
 * list and push (`window.electronAPI.artefacts`). What is the window's own is
 * how it shows them: an artefact hidden by the person (until the agent opens
 * one again) and the split of the pane, both kept in `localStorage`.
 *
 * The Slideless copy is read per machine, `'local'` for this Mac's own
 * server, else the server's id: the owner of a session id is its fleet key's
 * server (`parseSessionKey`).
 */

/** The `localStorage` key of what the window keeps of its own. */
export const VIEW_KEY = 'clave-artefact-view'
export const SPLIT_MIN = 0.25
export const SPLIT_MAX = 0.75
export const SPLIT_DEFAULT = 0.5

export interface ArtefactView {
  /** A session id → the `openedAt` of the artefact the person hid. */
  hidden: Record<string, string>
  /** A session id → the share of the pane the session keeps (the artefact the rest). */
  split: Record<string, number>
}

/** The machine a session runs on: `'local'` for this Mac's own server, else the server's id. */
export const ownerOfSession = (sessionId: string): string => parseSessionKey(sessionId).serverId

/** An artefact shows unless the person hid THIS open of it; a new open by the agent shows again. */
export const isShown = (artefact: Artefact, hidden: Record<string, string>): boolean =>
  hidden[artefact.sessionId] !== artefact.openedAt

export const clampSplit = (value: number): number =>
  Number.isFinite(value) ? Math.max(SPLIT_MIN, Math.min(SPLIT_MAX, value)) : SPLIT_DEFAULT

/**
 * What the window keeps, for the sessions it still lists only. Only the
 * entries of the machines named in `owners` are judged: a server that has
 * not answered yet must not lose what the window keeps for its sessions.
 */
export function pruneView(
  view: ArtefactView,
  listed: ReadonlySet<string>,
  owners: ReadonlySet<string>
): ArtefactView {
  const keep = <T>(record: Record<string, T>): Record<string, T> =>
    Object.fromEntries(
      Object.entries(record).filter(([id]) => listed.has(id) || !owners.has(ownerOfSession(id)))
    )
  return { hidden: keep(view.hidden), split: keep(view.split) }
}

export function readView(): ArtefactView {
  try {
    const raw = JSON.parse(localStorage.getItem(VIEW_KEY) ?? '{}') as Partial<ArtefactView>
    const strings = Object.entries(raw.hidden ?? {}).filter(([, v]) => typeof v === 'string')
    const numbers = Object.entries(raw.split ?? {}).filter(([, v]) => typeof v === 'number')
    return {
      hidden: Object.fromEntries(strings) as Record<string, string>,
      split: Object.fromEntries(numbers.map(([k, v]) => [k, clampSplit(v as number)]))
    }
  } catch {
    return { hidden: {}, split: {} }
  }
}

function writeView(view: ArtefactView): void {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(view))
  } catch {
    // A full or refused storage loses the window's preference, nothing else.
  }
}

interface ArtefactState extends ArtefactView {
  artefacts: Record<string, Artefact>
  slideless: Record<string, SlidelessState>
  /** Hide the artefact the session shows now (its `openedAt`), or show it again (null). */
  setHidden: (sessionId: string, openedAt: string | null) => void
  setSplit: (sessionId: string, value: number) => void
  /** What each session's panel shows, by session: `live`, `latest` or a version's number
   *  (PRDCT-4494). Kept in memory: a new start shows the live folder. */
  version: Record<string, string>
  setVersion: (sessionId: string, shown: string) => void
  /** The preview address each mounted panel frames, by session: what Open in browser opens
   *  for an artefact of this Mac (PRDCT-4494). Set by the frame, cleared when it unmounts. */
  previewUrl: Record<string, string>
  setPreviewUrl: (sessionId: string, url: string | null) => void
  /** Bumped when a version is saved from the bar, so its chip reads the list again. */
  versionsSaved: Record<string, number>
  noteSaved: (sessionId: string) => void
  /** Read a machine's Slideless once; later changes arrive pushed. */
  readSlideless: (owner: string) => void
  install: (owner: string) => Promise<void>
}

const serverIdOf = (owner: string): string | undefined => (owner === 'local' ? undefined : owner)

export const useArtefactStore = create<ArtefactState>((set, get) => {
  const view = readView()
  const keep = (next: Partial<ArtefactView>): void => {
    set(next)
    const { hidden, split } = get()
    writeView({ hidden, split })
  }
  const asked = new Set<string>()
  return {
    artefacts: {},
    slideless: {},
    hidden: view.hidden,
    split: view.split,
    setHidden: (sessionId, openedAt) => {
      const hidden = { ...get().hidden }
      if (openedAt === null) delete hidden[sessionId]
      else hidden[sessionId] = openedAt
      keep({ hidden })
    },
    setSplit: (sessionId, value) =>
      keep({ split: { ...get().split, [sessionId]: clampSplit(value) } }),
    version: {},
    setVersion: (sessionId, shown) =>
      set((s) => ({ version: { ...s.version, [sessionId]: shown } })),
    previewUrl: {},
    setPreviewUrl: (sessionId, url) =>
      set((s) => {
        if ((s.previewUrl[sessionId] ?? null) === url) return s
        const next = { ...s.previewUrl }
        if (url) next[sessionId] = url
        else delete next[sessionId]
        return { previewUrl: next }
      }),
    versionsSaved: {},
    noteSaved: (sessionId) =>
      set((s) => ({
        versionsSaved: { ...s.versionsSaved, [sessionId]: (s.versionsSaved[sessionId] ?? 0) + 1 }
      })),
    readSlideless: (owner) => {
      if (asked.has(owner)) return
      asked.add(owner)
      window.electronAPI.artefacts
        .slidelessState(serverIdOf(owner))
        .then((state) => set((s) => ({ slideless: { ...s.slideless, [owner]: state } })))
        .catch(() => asked.delete(owner))
    },
    install: async (owner) => {
      const state = await window.electronAPI.artefacts.installSlideless(serverIdOf(owner))
      set((s) => ({ slideless: { ...s.slideless, [owner]: state } }))
    }
  }
})

let started = false
/** The machines whose entries were pruned already: once each, at its first answer. */
const pruned = new Set<string>()
let reads = 0

/**
 * List again: at start, at each connection of the window's server, at each
 * fleet change. The first list prunes what the window keeps for sessions no
 * longer listed: this Mac's at once, a server's once it lists something.
 */
export async function refreshArtefacts(): Promise<void> {
  const read = ++reads
  const listed = await window.electronAPI.artefacts.list()
  if (read !== reads) return
  const artefacts = Object.fromEntries(listed.map((a) => [a.sessionId, a]))
  useArtefactStore.setState({ artefacts })
  const owners = new Set(['local', ...listed.map((a) => ownerOfSession(a.sessionId))])
  for (const owner of pruned) owners.delete(owner)
  if (owners.size === 0) return
  for (const owner of owners) pruned.add(owner)
  const { hidden, split } = useArtefactStore.getState()
  const next = pruneView({ hidden, split }, new Set(Object.keys(artefacts)), owners)
  useArtefactStore.setState(next)
  writeView(next)
}

/** Start following the servers; idempotent, so every view may call it. */
export function initArtefacts(): void {
  if (started) return
  started = true
  const api = window.electronAPI
  const refresh = (): void => {
    void refreshArtefacts().catch(() => undefined)
  }
  api.artefacts.onChanged(({ sessionId, artefact }) =>
    useArtefactStore.setState((s) => {
      const artefacts = { ...s.artefacts }
      if (artefact) artefacts[sessionId] = artefact
      else delete artefacts[sessionId]
      return { artefacts }
    })
  )
  api.artefacts.onSlidelessState(({ serverId, state }) =>
    useArtefactStore.setState((s) => ({
      slideless: { ...s.slideless, [serverId ?? 'local']: state }
    }))
  )
  api.onServerConnected(refresh)
  api.onFleetStatus?.((status) => {
    if (status.state === 'connected') refresh()
  })
  api.onFleetConnectionsChanged?.(refresh)
  refresh()
}
