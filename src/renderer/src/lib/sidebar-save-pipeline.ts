/**
 * How a window's sidebar edits reach the server, one save at a time
 * (PRDCT-3241). Pure, so vitest pins the three rules that matter:
 *
 *   1. ONE save in flight. A second edit made while a save is out waits for
 *      the answer and goes on the revision that answer names; sent at once it
 *      would name the stale one, be refused, and the window would lose it to
 *      the conflict's snapshot (two quick moves into a group lost the second).
 *   2. A snapshot pushed while a save is in flight is held until the answer:
 *      most often it is this window's own write echoed back, and applied over
 *      a state that has already moved on it would undo the edit in progress.
 *      After the answer, a held snapshot newer than what the answer named is
 *      the work of somebody else and is applied; one at or below it is ours.
 *   3. A refused save applies the server's current snapshot and takes its
 *      revision; whatever this window still holds beyond it is saved again
 *      on that revision by the edit that follows, never merged here.
 */
export type SaveOutcome<S> =
  | { ok: true; revision: number }
  | { ok: false; reason: 'conflict'; current: S }
  | { ok: false; reason: string }

export interface SavePipelineDeps<D, S> {
  /** What the window holds now and wants saved, or null when nothing new. */
  current: () => D | null
  send: (item: D, baseRevision: number) => Promise<SaveOutcome<S>>
  /** The server's snapshot applied over the window's working copy. */
  apply: (snapshot: S) => void
  /** The item landed on the server at this revision. */
  accepted?: (item: D, revision: number) => void
}

export interface SavePipeline<S> {
  /** The window's state changed: save it now, or once the save in flight answers. */
  save: () => void
  /** A snapshot from the server: a push, whoever caused it. */
  incoming: (snapshot: S) => void
  revision: () => number
  /** The revision the boot read came back with. */
  setRevision: (revision: number) => void
  inFlight: () => boolean
}

export function createSavePipeline<D, S extends { revision: number }>(
  deps: SavePipelineDeps<D, S>
): SavePipeline<S> {
  let revision = 0
  let inFlight = false
  let queued = false
  let held: S | null = null

  const applyIfNewer = (snapshot: S): void => {
    if (snapshot.revision <= revision) return
    revision = snapshot.revision
    deps.apply(snapshot)
  }

  const flush = (): void => {
    const item = deps.current()
    if (item === null) return
    inFlight = true
    const base = revision
    deps
      .send(item, base)
      .then((outcome) => {
        if (outcome.ok) {
          if (outcome.revision > revision) revision = outcome.revision
          deps.accepted?.(item, outcome.revision)
        } else if (outcome.reason === 'conflict') {
          const current = (outcome as { current: S }).current
          revision = current.revision
          deps.apply(current)
        }
      })
      .catch(() => {
        // A save that could not be made is not fatal: the groups stay in
        // memory for this run, and the next edit tries again.
      })
      .finally(() => {
        inFlight = false
        const next = held
        held = null
        if (next) applyIfNewer(next)
        if (queued) {
          queued = false
          flush()
        }
      })
  }

  return {
    save: () => {
      if (inFlight) {
        queued = true
        return
      }
      flush()
    },
    incoming: (snapshot) => {
      if (snapshot.revision <= revision) return
      if (inFlight) {
        if (!held || snapshot.revision > held.revision) held = snapshot
        return
      }
      applyIfNewer(snapshot)
    },
    revision: () => revision,
    setRevision: (next) => {
      revision = next
    },
    inFlight: () => inFlight
  }
}
