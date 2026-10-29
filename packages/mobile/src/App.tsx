/**
 * Clave on the phone. The store and the services are built once per process.
 * A warm resume from the background keeps the navigator in memory; a cold
 * launch (this component mounting in a new process) opens Machines then the
 * Workspaces of the current machine; a deep link `clave://chat/<machine>/
 * <session>` opens that conversation on either path. No screen is saved and
 * restored by elapsed time (`navigation/persistence.ts` says why).
 */
import {
  DarkTheme,
  NavigationContainer,
  type LinkingOptions,
  type NavigationState
} from '@react-navigation/native'
import { StatusBar } from 'expo-status-bar'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Linking } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { RootNavigator, type RootStackParamList } from './navigation/RootNavigator'
import {
  LAST_MACHINE_KEY,
  initialLaunchState,
  machineIdOf,
  stateForPath
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

type LinkState = ReturnType<NonNullable<LinkingOptions<RootStackParamList>['getStateFromPath']>>

/** The one deep link the app answers: a conversation, for a notification tap. */
const linking: LinkingOptions<RootStackParamList> = {
  prefixes: ['clave://'],
  getStateFromPath: (path) => stateForPath(path) as LinkState,
  config: { screens: { Chat: 'chat/:machineId/:sessionId' } }
}

export function App(): ReactNode {
  const services = useMemo(() => createServices(), [])
  const store = useMemo(() => createStore(services), [services])
  const [initial, setInitial] = useState<{ state: NavigationState } | null>(null)

  // A cold launch: the current machine, read once, decides the first screen.
  useEffect(() => {
    let cancelled = false
    void Promise.all([
      services.kv.getItem(LAST_MACHINE_KEY),
      Linking.getInitialURL(),
      store.getState().loadMachines()
    ]).then(([lastMachine, url]) => {
      if (!cancelled)
        setInitial({
          state: initialLaunchState(lastMachine, url ?? null) as unknown as NavigationState
        })
    })
    return () => {
      cancelled = true
    }
  }, [services, store])

  useEffect(() => () => store.getState().disconnectAll(), [store])

  return (
    <SafeAreaProvider>
      <StoreProvider store={store} services={services}>
        {initial ? (
          <NavigationContainer
            theme={theme}
            linking={linking}
            initialState={initial.state}
            onStateChange={(state) => {
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
