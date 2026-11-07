import { parseResourceKey, resourceKey, type ServerPairings } from '@clave/contract/fleet'
import { normalizeGitRemote } from '../../../shared/git-remote'
import type { Workspace } from '../../../shared/workspace-types'
import { useWorkspaceStore } from '../store/workspace-store'
import { useFleetStore } from '../store/fleet-store'
import { setPairingProposals, usePairingStore, type PairingProposal } from '../store/pairing-store'

/**
 * Which server workspace is the same tree as which Mac workspace (PRDCT-4151),
 * from the git remote of each root: a server workspace whose root's `origin`
 * reads the same as a local root's, on a server that is connected and whose
 * switch was not turned off, with no pairing recorded and no decline on it.
 * Pure: the remotes are handed in, read before by `refreshPairingProposals`.
 */
export function proposePairings(input: {
  serverWorkspaces: Readonly<Record<string, readonly Workspace[]>>
  localWorkspaces: readonly Workspace[]
  servers: ServerPairings['servers']
  connected: (serverId: string) => boolean
  /** The normalised remote of a root, by its key (`resourceKey('file',
   *  serverId, rootDir)` for a server's, the plain path for the Mac's). */
  remoteOf: (key: string) => string | null | undefined
}): PairingProposal[] {
  const locals = input.localWorkspaces
    .map((w) => ({ id: w.id, remote: input.remoteOf(w.rootDir) ?? null }))
    .filter((l): l is { id: string; remote: string } => !!l.remote)
  const proposals: PairingProposal[] = []
  for (const [serverId, list] of Object.entries(input.serverWorkspaces)) {
    const pairing = input.servers[serverId]
    if (pairing?.combine === false || !input.connected(serverId)) continue
    const takenLocals = new Set(Object.values(pairing?.pairs ?? {}))
    for (const ws of list) {
      const raw = parseResourceKey('workspace', ws.id).id
      if (pairing && (raw in pairing.pairs || pairing.declined.includes(raw))) continue
      const remote = input.remoteOf(resourceKey('file', serverId, ws.rootDir))
      if (!remote) continue
      const local = locals.find((l) => l.remote === remote && !takenLocals.has(l.id))
      if (!local) continue
      takenLocals.add(local.id)
      proposals.push({ serverId, serverWorkspaceId: ws.id, localWorkspaceId: local.id, remote })
    }
  }
  return proposals
}

// A pairing change (a confirmation, a decline, Ask again, Forget, the
// switch) recomputes the proposals in every window that hears it: what a
// decline took away, Ask again brings back without a reload (round 2).
usePairingStore.subscribe((state, previous) => {
  if (state.servers !== previous.servers) void refreshPairingProposals()
})

// The remotes read so far, by root key: a Mac root for the window's life, a
// server's roots until that server connects again (its disk may have changed).
// A root with no remote is not remembered: it may become a clone, and the
// read costs one config lookup.
const remotes = new Map<string, string | null>()
let running: Promise<void> | null = null
let queued = false

export function forgetServerRemotes(serverId: string): void {
  const prefix = resourceKey('file', serverId, '/').slice(0, -3)
  for (const key of [...remotes.keys()]) if (key.startsWith(prefix)) remotes.delete(key)
}

async function readRemote(key: string): Promise<void> {
  if (remotes.get(key)) return
  try {
    const url = await window.electronAPI?.gitRemoteUrl?.(key)
    remotes.set(key, normalizeGitRemote(url))
  } catch {
    remotes.set(key, null)
  }
}

/** Read every root's remote this window does not know yet, then compute the
 *  proposals. One run at a time; a call during a run queues one more. */
export function refreshPairingProposals(): Promise<void> {
  if (running) {
    queued = true
    return running
  }
  running = (async () => {
    const api = window.electronAPI
    if (!api?.gitRemoteUrl) return
    const { workspaces, serverWorkspaces } = useWorkspaceStore.getState()
    const statuses = useFleetStore.getState().statuses
    const connected = (id: string): boolean => statuses[id]?.state === 'connected'
    const keys: string[] = workspaces.map((w) => w.rootDir)
    for (const [serverId, list] of Object.entries(serverWorkspaces))
      if (connected(serverId))
        for (const ws of list) keys.push(resourceKey('file', serverId, ws.rootDir))
    await Promise.all(keys.map(readRemote))
    setPairingProposals(
      proposePairings({
        serverWorkspaces: useWorkspaceStore.getState().serverWorkspaces,
        localWorkspaces: useWorkspaceStore.getState().workspaces,
        servers: usePairingStore.getState().servers,
        connected,
        remoteOf: (key) => remotes.get(key)
      })
    )
  })()
    .catch(() => undefined)
    .finally(() => {
      running = null
      if (queued) {
        queued = false
        void refreshPairingProposals()
      }
    })
  return running
}
