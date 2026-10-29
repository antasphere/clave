/**
 * Clave on the phone. The store and the services are built once; the
 * navigation state is saved when the app leaves the foreground and
 * restored on the next launch when that save is recent, so coming back
 * finds the screen the person was on and a fresh launch opens Machines
 * then the Workspaces of the machine last used.
 */
import { DarkTheme, NavigationContainer, type NavigationState } from '@react-navigation/native'
import { StatusBar } from 'expo-status-bar'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AppState } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { RootNavigator } from './navigation/RootNavigator'
import {
  LAST_MACHINE_KEY,
  NAVIGATION_KEY,
  decideInitialNavigation,
  machineIdOf,
  parseSaved
} from './navigation/persistence'
import { createServices } from './services'
import { StoreProvider } from './state/StoreProvider'
import { createStore } from './state/store'
import { Screen } from './ui/components'
import { colors } from './ui/theme'

const theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    primary: colors.accent,
    background: colors.surface0,
    card: colors.surface50,
    text: colors.textPrimary,
    border: colors.border
  }
}

export function App(): ReactNode {
  const services = useMemo(() => createServices(), [])
  const store = useMemo(() => createStore(services), [services])
  const [initial, setInitial] = useState<{ state: unknown } | null>(null)
  const current = useRef<NavigationState | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [saved, lastMachine] = await Promise.all([
        services.kv.getItem(NAVIGATION_KEY),
        services.kv.getItem(LAST_MACHINE_KEY)
      ])
      const decision = decideInitialNavigation(parseSaved(saved), Date.now(), lastMachine)
      if (!cancelled) setInitial({ state: decision.state })
    })()
    return () => {
      cancelled = true
    }
  }, [services])

  useEffect(() => {
    const save = (): void => {
      const state = current.current
      if (!state) return
      void services.kv.setItem(
        NAVIGATION_KEY,
        JSON.stringify({ state, savedAt: Date.now(), machineId: machineIdOf(state) })
      )
    }
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'background' || next === 'inactive') save()
    })
    return () => subscription.remove()
  }, [services])

  useEffect(() => () => store.getState().disconnectAll(), [store])

  return (
    <SafeAreaProvider>
      <StoreProvider store={store} services={services}>
        {initial ? (
          <NavigationContainer
            theme={theme}
            initialState={initial.state as NavigationState}
            onStateChange={(state) => {
              current.current = state
              const machineId = machineIdOf(state)
              if (machineId) void services.kv.setItem(LAST_MACHINE_KEY, machineId)
            }}
          >
            <RootNavigator />
          </NavigationContainer>
        ) : (
          <Screen>{null}</Screen>
        )}
      </StoreProvider>
      <StatusBar style="light" />
    </SafeAreaProvider>
  )
}
