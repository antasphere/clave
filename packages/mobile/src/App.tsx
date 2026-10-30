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
  useNavigationContainerRef,
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
import { createStore, type Services } from './state/store'
import { nativeAccount, nativeOwnerStores } from './platform/account'
import type { AuthStatus } from './auth/sign-in'
import * as Notifications from 'expo-notifications'
import {
  configureNativeNotifications,
  nativeNotificationResponse,
  PENDING_NOTIFICATION_KEY
} from './platform/notifications'
import { navigationStateOf } from './notifications/deeplink'
import { ErrorText, Screen } from './ui/components'
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
  const auth = useMemo(() => nativeAccount(), [])
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [owner, setOwner] = useState<{ key: string; services: Services } | null>(null)
  const key = status ? JSON.stringify([status.issuer, status.account?.subject ?? null]) : null
  useEffect(() => {
    const off = auth.onChange(setStatus)
    void auth.restore().then(setStatus)
    return off
  }, [auth])
  useEffect(() => {
    let cancelled = false
    if (key)
      void nativeOwnerStores(auth).then((stores) => {
        if (!cancelled) setOwner({ key, services: createServices(auth, stores) })
      })
    return () => {
      cancelled = true
    }
  }, [auth, key])
  return owner && owner.key === key ? (
    <OwnerApp key={key!} services={owner.services} />
  ) : (
    <Screen>{null}</Screen>
  )
}

function OwnerApp({ services }: { services: Services }): ReactNode {
  const navigation = useNavigationContainerRef<RootStackParamList>()
  const [notificationError, setNotificationError] = useState(false)
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
  useEffect(() => {
    if (__DEV__) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- test receipt excluded from release bundles
      void (require('./platform/provenance-dev') as typeof import('./platform/provenance-dev'))
        .reportBundleProvenance()
        .catch(() => {})
    }
    void configureNativeNotifications().catch(() => {
      setNotificationError(true)
    })
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      void nativeNotificationResponse(response).then(async (link) => {
        if (link && navigation.isReady()) {
          navigation.resetRoot(navigationStateOf(link) as unknown as NavigationState)
          await services.kv.removeItem(PENDING_NOTIFICATION_KEY)
        }
        await Notifications.clearLastNotificationResponseAsync()
      })
    })
    return () => subscription.remove()
  }, [navigation, services])

  return (
    <SafeAreaProvider>
      <StoreProvider store={store} services={services}>
        {notificationError ? (
          <ErrorText>Notifications could not be enabled on this build.</ErrorText>
        ) : null}
        {initial ? (
          <NavigationContainer
            ref={navigation}
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
