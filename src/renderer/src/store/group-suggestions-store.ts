/**
 * The two nearest projects of a group whose tabs Jev hesitated on
 * (PRDCT-5179), by group id: what the group's row offers beside its name
 * while it waits for one. Transient on purpose: never persisted, never on a
 * record, gone with the window. Written by `lib/group-projects.ts` alone.
 */
import { create } from 'zustand'
import type { GroupProject } from '@clave/contract/tab-projects-rules'

export const useGroupSuggestionsStore = create<{ byGroup: Record<string, GroupProject[]> }>(() => ({
  byGroup: {}
}))

export function setGroupSuggestion(groupId: string, nearest: GroupProject[]): void {
  useGroupSuggestionsStore.setState((state) => ({
    byGroup: { ...state.byGroup, [groupId]: nearest.map((project) => ({ ...project })) }
  }))
}

export function clearGroupSuggestion(groupId: string): void {
  if (!(groupId in useGroupSuggestionsStore.getState().byGroup)) return
  useGroupSuggestionsStore.setState((state) => {
    const byGroup = { ...state.byGroup }
    delete byGroup[groupId]
    return { byGroup }
  })
}
