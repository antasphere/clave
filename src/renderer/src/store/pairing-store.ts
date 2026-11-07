import { create } from 'zustand'
import {
  parseResourceKey,
  resourceKey,
  type ServerPairingChange,
  type ServerPairings
} from '@clave/contract/fleet'
import { setCombinedWorkspaces } from './session-store'
import { ownerOf } from '../lib/fleet-identity'

/** A pairing Clave proposes and the person confirms once: a server workspace
 *  (its remote key) and the Mac workspace that is the same tree, both clones
 *  of `remote`. */
export interface PairingProposal {
  serverId: string
  serverWorkspaceId: string
  localWorkspaceId: string
  remote: string
}

interface PairingState {
  /** Each saved server's pairings, as main keeps them (`server-pairings.json`). */
  servers: ServerPairings['servers']
  proposals: PairingProposal[]
  loaded: boolean
}

/**
 * The paired workspaces of this Mac (PRDCT-4151): a LEAF store over main's
 * document, plus the proposals this window computed. It feeds the one
 * visibility rule (`setCombinedWorkspaces`) and nothing else decides what a
 * combined workspace shows. Detection lives in `lib/workspace-pairing.ts`.
 */
export const usePairingStore = create<PairingState>(() => ({
  servers: {},
  proposals: [],
  loaded: false
}))

/** For every local workspace, the server workspaces (remote keys) it shows
 *  beside its own: the pairs of every server whose switch is on. */
export function combinedWorkspacesOf(servers: ServerPairings['servers']): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>()
  for (const [serverId, pairing] of Object.entries(servers)) {
    if (pairing.combine !== true) continue
    for (const [serverWorkspaceId, localWorkspaceId] of Object.entries(pairing.pairs)) {
      const set = map.get(localWorkspaceId) ?? new Set<string>()
      set.add(resourceKey('workspace', serverId, serverWorkspaceId))
      map.set(localWorkspaceId, set)
    }
  }
  return map
}

export function applyServerPairings(state: ServerPairings): void {
  usePairingStore.setState((s) => ({
    servers: state.servers,
    loaded: true,
    // A proposal answered, or made moot by a switch turned off, leaves the list.
    proposals: s.proposals.filter((p) => stillOpen(p, state.servers))
  }))
  setCombinedWorkspaces(combinedWorkspacesOf(state.servers))
}

/** A proposal stands while the pairing is neither recorded nor declined and
 *  the server's switch was not turned off. */
export function stillOpen(p: PairingProposal, servers: ServerPairings['servers']): boolean {
  const pairing = servers[p.serverId]
  if (!pairing) return true
  if (pairing.combine === false) return false
  const raw = parseResourceKey('workspace', p.serverWorkspaceId).id
  return !(raw in pairing.pairs) && !pairing.declined.includes(raw)
}

export function setPairingProposals(proposals: PairingProposal[]): void {
  const current = usePairingStore.getState().proposals
  const same =
    current.length === proposals.length &&
    current.every(
      (p, i) =>
        p.serverWorkspaceId === proposals[i].serverWorkspaceId &&
        p.localWorkspaceId === proposals[i].localWorkspaceId
    )
  if (!same) usePairingStore.setState({ proposals })
}

/** The badge colour a server wears on this Mac, once it has a pairing entry. */
export function serverColor(serverId: string | null | undefined): string | undefined {
  return serverId ? usePairingStore.getState().servers[serverId]?.color : undefined
}

/** The server workspaces (remote keys) a local workspace shows beside its
 *  own, with their server: the launcher's "Run on" rows. */
export function pairedServerWorkspaces(
  localWorkspaceId: string | null
): Array<{ serverId: string; workspaceId: string }> {
  if (!localWorkspaceId || ownerOf(localWorkspaceId) !== 'local') return []
  const out: Array<{ serverId: string; workspaceId: string }> = []
  for (const [serverId, pairing] of Object.entries(usePairingStore.getState().servers)) {
    if (pairing.combine !== true) continue
    for (const [raw, local] of Object.entries(pairing.pairs))
      if (local === localWorkspaceId)
        out.push({ serverId, workspaceId: resourceKey('workspace', serverId, raw) })
  }
  return out
}

/** One change to main's document; every window hears the result. */
export async function changePairing(change: ServerPairingChange): Promise<void> {
  const api = window.electronAPI
  if (!api?.serverPairingsChange) return
  applyServerPairings(await api.serverPairingsChange(change))
}

export function confirmProposal(p: PairingProposal): Promise<void> {
  return changePairing({
    kind: 'confirm',
    serverId: p.serverId,
    serverWorkspaceId: parseResourceKey('workspace', p.serverWorkspaceId).id,
    localWorkspaceId: p.localWorkspaceId
  })
}

export function declineProposal(p: PairingProposal): Promise<void> {
  return changePairing({
    kind: 'decline',
    serverId: p.serverId,
    serverWorkspaceId: parseResourceKey('workspace', p.serverWorkspaceId).id
  })
}

/** Boot: main's document, then the live changes from every window. */
export async function bootPairings(): Promise<void> {
  const api = window.electronAPI
  if (!api?.serverPairingsLoad) return
  api.onServerPairingsChanged?.((state) => applyServerPairings(state))
  try {
    applyServerPairings(await api.serverPairingsLoad())
  } catch {
    /* no pairings until main answers */
  }
}
