/**
 * The artefacts a pane keeps mounted (PRDCT-4474, Romain's amendment of 13
 * November 2026): `kept`, in the order each was first shown, is the order the
 * frames are drawn in, so a frame never moves in the page; `recent`, most
 * recent first, only chooses what falls past the bound. A frame drawn in the
 * order of recency moved each time another was shown, and Chromium loads a
 * moved iframe again: every change of tab after the first reloaded the page
 * being left (verifier round 4, finding 1).
 */
export interface KeptArtefacts {
  kept: string[]
  recent: string[]
}

export function nextKept(
  state: KeptArtefacts,
  activeId: string | null,
  valid: (id: string) => boolean,
  limit: number
): KeptArtefacts {
  const touched =
    activeId && state.recent[0] !== activeId
      ? [activeId, ...state.recent.filter((id) => id !== activeId)]
      : state.recent
  const recent = touched.filter(valid).slice(0, limit)
  const allowed = new Set(recent)
  const kept = [
    ...state.kept.filter((id) => allowed.has(id)),
    ...recent.filter((id) => !state.kept.includes(id)).reverse()
  ]
  return { kept, recent }
}

export const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id, i) => id === b[i])
