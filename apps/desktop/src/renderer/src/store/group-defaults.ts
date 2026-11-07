/**
 * What a live group's `+` inherits from the `.clave` group it was stamped from:
 * the brief a later session starts on, and WHERE that session starts.
 *
 * Pure by design — `pinned-store.ts` can't be imported by a unit test (it
 * subscribes to the session store at module load, which needs a window), and
 * this is exactly the logic that has to be decidable without one: a `+` that
 * opens in the wrong directory looks identical to a `+` that opens in the right
 * one until you read the shell prompt inside the new tab.
 */
import type { LaunchCwd } from '../lib/launch-session'
import type { PinnedGroup, PinnedGroupSession, SessionGroup } from './session-types'

/** The two things the `+` copies from the declaration. */
export interface GroupDefaults {
  /** RAW brief — @-tokens are substituted at press time, against the group's
   *  own cwd, so a group that moves keeps expanding them correctly. */
  prompt: string | null
  /** Start the session at the workspace root instead of the group's cwd. */
  rootSession: boolean
}

/** The declared session the `+` reproduces — the one carrying the group's
 *  brief. `.clave` lets a group declare `prompt` at group level, but every
 *  workspace file we actually author puts the project briefing on the group's
 *  first session instead (`sessions[0].prompt` — what the product is, which
 *  repos sit in the folder, wait for instructions), with `rootSession: true` so
 *  the agent opens at the workspace root with the whole tree in reach while
 *  `cwd` stays the small project dir the @-tokens resolve against.
 *
 *  Precedence: the root session carrying a brief, then the first session that
 *  carries one, then the first session declared at all — a group whose sessions
 *  open at the root but say nothing still wants its `+` to land there. */
function entrySession(sessions: PinnedGroupSession[]): PinnedGroupSession | null {
  return (
    sessions.find((s) => s.rootSession && s.prompt) ??
    sessions.find((s) => s.prompt) ??
    sessions[0] ??
    null
  )
}

/** Resolve both halves from a pin.
 *
 *  A tab opened from the `+` an hour later needs each of them exactly as much
 *  as the one stamped at launch: without the brief it was a bare agent knowing
 *  nothing about the project, and without `rootSession` it opened in the
 *  project dir while every tab the group itself launched sat at the workspace
 *  root — same group, same button, different directory.
 *
 *  A group-level `prompt` overrides the entry session's TEXT (it is the
 *  explicit answer), never where its sessions live. */
export function resolveGroupDefaults(pg: Pick<PinnedGroup, 'prompt' | 'sessions'>): GroupDefaults {
  const entry = entrySession(pg.sessions)
  return {
    prompt: pg.prompt ?? entry?.prompt ?? null,
    rootSession: entry?.rootSession === true
  }
}

/** The pin a live group was stamped from, for groups that predate `rootSession`
 *  being carried on the live group — every group already running when this
 *  shipped, since a stamped group is a snapshot and nothing re-stamps it.
 *
 *  `activeGroupId` is the link, but it is runtime state that dies with the
 *  window, so after a restart the group and its pin are strangers. The fallback
 *  identifies them by what the stamp copied: same workspace, same name, same
 *  directory, same brief. Requiring the brief to match is what keeps a group an
 *  agent created through `clave_create_group` from being claimed by an
 *  unrelated pin that happens to share a name. */
export function findBackingPin(
  group: Pick<SessionGroup, 'id' | 'name' | 'cwd' | 'prompt' | 'workspaceId'>,
  pins: PinnedGroup[]
): PinnedGroup | null {
  const linked = pins.find((p) => p.activeGroupId === group.id)
  if (linked) return linked
  return (
    pins.find(
      (p) =>
        (p.workspaceId ?? null) === (group.workspaceId ?? null) &&
        p.name === group.name &&
        (p.cwd ?? null) === (group.cwd ?? null) &&
        (resolveGroupDefaults(p).prompt ?? null) === (group.prompt ?? null)
    ) ?? null
  )
}

/** Where the group's `+` starts its session — the whole decision, so it can be
 *  read (and mutated, and caught) without a window.
 *
 *  A group stamped from a `.clave` carries the answer itself. `undefined` — not
 *  `false` — means it was stamped before the live group carried the anchor at
 *  all: every group already running when this shipped, and a stamped group is a
 *  SNAPSHOT that nothing re-stamps, so without the fallback to its pin the fix
 *  would never reach a single group in the fleet. Failing both, the group's own
 *  directory, and failing that the workspace root — a group with no cwd has
 *  nowhere else to be. */
export function resolveGroupLaunchCwd(
  group: Pick<SessionGroup, 'id' | 'name' | 'cwd' | 'prompt' | 'workspaceId' | 'rootSession'>,
  pins: PinnedGroup[]
): LaunchCwd {
  const backing = group.rootSession === undefined ? findBackingPin(group, pins) : null
  const atRoot = group.rootSession ?? (backing ? resolveGroupDefaults(backing).rootSession : false)
  if (atRoot || !group.cwd) return { kind: 'workspace-root' }
  return { kind: 'path', path: group.cwd }
}
