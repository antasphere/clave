import { createContext, useContext } from 'react'
import { useStore } from 'zustand'
import type { Services, Store, StoreState } from './store'

export interface StoreContextValue {
  readonly store: Store
  readonly services: Services
}

export const StoreContext = createContext<StoreContextValue | null>(null)

const useContextValue = (): StoreContextValue => {
  const value = useContext(StoreContext)
  if (!value) throw new Error('StoreProvider is missing above this screen')
  return value
}

/** The store's API: actions and `getState()`, stable for the app's life. */
export const useStoreApi = (): Store => useContextValue().store

/** A slice of the state, re-rendering on its change. */
export function useSel<T>(selector: (state: StoreState) => T): T {
  return useStore(useContextValue().store, selector)
}

export const useServices = (): Services => useContextValue().services
