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
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Linking } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { RootNavigator, type RootStackParamList } from './navigation/RootNavigator'
import { LAST_MACHINE_KEY, machineIdOf, stateForPath } from './navigation/persistence'
import { createServices } from './services'
import { StoreProvider } from './state/StoreProvider'
import { createStore, type Services } from './state/store'
import { nativeAccount, nativeOwnerStores } from './platform/account'
import type { AuthStatus } from './auth/sign-in'
import * as Notifications from 'expo-notifications'
import { configureNativeNotifications, ownerNotificationResponse } from './platform/notifications'
import { navigationStateOf, type DeepLink } from './notifications/deeplink'
import { NotificationInbox } from './notifications/inbox'
import { EnrollmentRecords } from './enroll/records'
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
  const navigateNotification = useCallback(
    (link: DeepLink) => {
      navigation.resetRoot(navigationStateOf(link) as unknown as NavigationState)
    },
    [navigation]
  )
  const inbox = useMemo(
    () =>
      new NotificationInbox({
        kv: services.kv,
        lastResponse: Notifications.getLastNotificationResponseAsync,
        clearLastResponse: Notifications.clearLastNotificationResponseAsync,
        respond: (response) =>
          ownerNotificationResponse(response, {
            kv: services.kv,
            credentials: services.credentials,
            machines: new EnrollmentRecords(services.kv),
            build: services.build ?? 'release'
          })
      }),
    [services]
  )
  const [initial, setInitial] = useState<{ state: NavigationState } | null>(null)

  // A cold launch: the current machine, read once, decides the first screen.
  useEffect(() => {
    let cancelled = false
    void Promise.all([
      services.kv.getItem(LAST_MACHINE_KEY),
      Linking.getInitialURL(),
      store.getState().loadMachines()
    ])
      .then(async ([lastMachine, url]) => {
        const state = await inbox.initialState(lastMachine, url ?? null)
        if (!cancelled)
          setInitial({
            state: state as unknown as NavigationState
          })
      })
      .catch(() => {
        setNotificationError(true)
        if (!cancelled)
          setInitial({
            state: { index: 0, routes: [{ name: 'Machines' }] } as unknown as NavigationState
          })
      })
    return () => {
      cancelled = true
    }
  }, [inbox, services, store])

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
      void inbox.receive(response).catch(() => setNotificationError(true))
    })
    return () => {
      inbox.close()
      subscription.remove()
    }
  }, [inbox])

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
            onReady={() => {
              void inbox.ready(navigateNotification).catch(() => setNotificationError(true))
            }}
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
