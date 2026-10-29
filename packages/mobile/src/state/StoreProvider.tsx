import type { ReactNode } from 'react'
import { StoreContext } from './context'
import type { Services, Store } from './store'

export function StoreProvider({
  store,
  services,
  children
}: {
  store: Store
  services: Services
  children: ReactNode
}): ReactNode {
  return <StoreContext.Provider value={{ store, services }}>{children}</StoreContext.Provider>
}
