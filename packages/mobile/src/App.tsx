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
  DefaultTheme,
  NavigationContainer,
  useNavigationContainerRef,
  type LinkingOptions,
  type NavigationState
} from '@react-navigation/native'
import { useFonts } from 'expo-font'
import { StatusBar } from 'expo-status-bar'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Linking } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { RootNavigator, type RootStackParamList } from './navigation/RootNavigator'
import { LAST_MACHINE_KEY, machineIdOf, stateForPath } from './navigation/persistence'
import { createServices } from './services'
import { StoreProvider } from './state/StoreProvider'
import { createStore, type Services } from './state/store'
import { nativeAccount, nativeOwnerStores, rawKeyValueStore } from './platform/account'
import type { AuthStatus } from './auth/sign-in'
import * as Notifications from 'expo-notifications'
import { configureNativeNotifications, ownerNotificationResponse } from './platform/notifications'
import { navigationStateOf, type DeepLink } from './notifications/deeplink'
import { NotificationInbox } from './notifications/inbox'
import { EnrollmentRecords } from './enroll/records'
import { Screen } from './ui/components'
import { AppearanceProvider } from './ui/appearance'
import { useAppearance } from './ui/appearance-context'
import { ScreenNoticeContext } from './ui/screen-notice-context'
import { ThemeProvider, family, useResolvedTheme, useTheme, type Theme } from './ui/theme'
import type { DevicePushToken } from './notifications/port'

/** The navigator's own colours, from the Clave theme: the ground, the card
 *  and the hairline it draws between screens while one slides in. */
const navigationTheme = (t: Theme): typeof DarkTheme => ({
  ...(t.dark ? DarkTheme : DefaultTheme),
  colors: {
    ...(t.dark ? DarkTheme : DefaultTheme).colors,
    primary: t.colors.accent,
    background: t.colors.surface0,
    card: t.colors.surface0,
    text: t.colors.textPrimary,
    border: t.colors.borderSubtle,
    notification: t.colors.accent
  }
})

/** Geist Sans at the three weights the desktop loads (`family` in theme.ts),
 *  derived from the same files (`scripts/build-fonts.mjs`). */
const FONTS = {
  /* eslint-disable @typescript-eslint/no-require-imports -- the bundler reads the asset paths at build time */
  [family[400]]: require('../assets/fonts/Geist-Regular.otf'),
  [family[500]]: require('../assets/fonts/Geist-Medium.otf'),
  [family[600]]: require('../assets/fonts/Geist-SemiBold.otf')
  /* eslint-enable @typescript-eslint/no-require-imports */
}

type LinkState = ReturnType<NonNullable<LinkingOptions<RootStackParamList>['getStateFromPath']>>

/** The one deep link the app answers: a conversation, for a notification tap. */
const linking: LinkingOptions<RootStackParamList> = {
  prefixes: ['clave://'],
  getStateFromPath: (path) => stateForPath(path) as LinkState,
  config: { screens: { Chat: 'chat/:machineId/:sessionId' } }
}

export function App(): ReactNode {
  return (
    <AppearanceProvider kv={rawKeyValueStore}>
      <Themed>
        <Account />
      </Themed>
    </AppearanceProvider>
  )
}

/** The theme the appearance resolves to, over every screen; the fonts loaded
 *  before anything is drawn in them (a failure draws the system face). */
function Themed({ children }: { children: ReactNode }): ReactNode {
  const { appearance } = useAppearance()
  const theme = useResolvedTheme(appearance)
  const [fontsLoaded, fontsError] = useFonts(FONTS)
  return (
    <ThemeProvider value={theme}>
      <SafeAreaProvider style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
        {fontsLoaded || fontsError ? children : <Screen>{null}</Screen>}
        <StatusBar style={theme.dark ? 'light' : 'dark'} />
      </SafeAreaProvider>
    </ThemeProvider>
  )
}

function Account(): ReactNode {
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
  const t = useTheme()
  const theme = useMemo(() => navigationTheme(t), [t])
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
    let cancelled = false
    const syncPush = async (token?: DevicePushToken): Promise<void> => {
      const results = await services.beta?.syncPushTokens(token)
      if (!cancelled && results?.some((result) => result.kind === 'failed'))
        setNotificationError(true)
    }
    void configureNativeNotifications()
      .then(() => syncPush())
      .catch(() => {
        setNotificationError(true)
      })
    const tokenSubscription = Notifications.addPushTokenListener((token) => {
      void syncPush(token).catch(() => {
        if (!cancelled) setNotificationError(true)
      })
    })
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      void inbox.receive(response).catch(() => setNotificationError(true))
    })
    return () => {
      cancelled = true
      inbox.close()
      subscription.remove()
      tokenSubscription.remove()
    }
  }, [inbox, services])

  return (
    <ScreenNoticeContext.Provider
      value={notificationError ? 'Notifications could not be enabled on this build.' : null}
    >
      <StoreProvider store={store} services={services}>
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
    </ScreenNoticeContext.Provider>
  )
}
