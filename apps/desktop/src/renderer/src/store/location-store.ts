import { create } from 'zustand'
import type { Location, LocationStatus } from '../../../../../../packages/shared/src/remote-types'

interface LocationState {
  locations: Location[]
  loaded: boolean
  loadLocations: () => Promise<void>
  addLocation: (loc: Omit<Location, 'id' | 'status'>, password?: string) => Promise<Location>
  updateLocation: (id: string, updates: Partial<Location>) => Promise<void>
  removeLocation: (id: string) => Promise<void>
  setLocationStatus: (id: string, status: LocationStatus) => void
}

export const useLocationStore = create<LocationState>((set) => ({
  locations: [],
  loaded: false,

  loadLocations: async () => {
    if (!window.electronAPI?.locationList) return
    const locations = await window.electronAPI.locationList()
    set({ locations, loaded: true })
  },

  addLocation: async (loc, password) => {
    const newLoc = await window.electronAPI.locationAdd(loc, password)
    set((s) => ({ locations: [...s.locations, newLoc] }))
    return newLoc
  },

  updateLocation: async (id, updates) => {
    await window.electronAPI.locationUpdate(id, updates)
    set((s) => ({
      locations: s.locations.map((l) => (l.id === id ? { ...l, ...updates } : l))
    }))
  },

  removeLocation: async (id) => {
    await window.electronAPI.locationRemove(id)
    set((s) => ({ locations: s.locations.filter((l) => l.id !== id) }))
  },

  setLocationStatus: (id, status) => {
    set((s) => ({
      locations: s.locations.map((l) => (l.id === id ? { ...l, status } : l))
    }))
  }
}))
