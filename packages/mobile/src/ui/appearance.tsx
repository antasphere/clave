/** The appearance preference over the app (`appearance-context.ts`). */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { KeyValueStore } from '../chat/drafts'
import { APPEARANCE_KEY, type Appearance } from './theme'
import { AppearanceContext, readAppearance } from './appearance-context'

export function AppearanceProvider({
  kv,
  children
}: {
  kv: KeyValueStore
  children: ReactNode
}): ReactNode {
  const [appearance, set] = useState<Appearance>('system')
  useEffect(() => {
    let cancelled = false
    void readAppearance(kv).then((value) => {
      if (!cancelled) set(value)
    })
    return () => {
      cancelled = true
    }
  }, [kv])
  const setAppearance = useCallback(
    (next: Appearance) => {
      set(next)
      void kv.setItem(APPEARANCE_KEY, next).catch(() => {})
    },
    [kv]
  )
  const value = useMemo(() => ({ appearance, setAppearance }), [appearance, setAppearance])
  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>
}
