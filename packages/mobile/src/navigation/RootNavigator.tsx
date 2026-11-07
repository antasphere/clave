/**
 * The screens, one native stack: Machines, the Workspaces of a machine, the
 * Sessions of a workspace, a Chat, the Launch form, the Requests of a
 * machine, Appearance, and, in a development build only, the Developer
 * connection. The developer screen's module is required under `__DEV__`, so
 * a release bundle has no route to it (`scripts/check-release-bundle.mjs`).
 * Every screen draws its own pane header (`ui/PaneHeader.tsx`, the desktop's
 * shape), so the stack shows none of the platform's.
 */
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import type { ReactNode } from 'react'
import { AppearanceScreen } from '../screens/AppearanceScreen'
import { ChatScreen } from '../screens/ChatScreen'
import { LaunchScreen } from '../screens/LaunchScreen'
import { MachinesScreen } from '../screens/MachinesScreen'
import { RequestsScreen } from '../screens/RequestsScreen'
import { SessionsScreen } from '../screens/SessionsScreen'
import { WorkspacesScreen } from '../screens/WorkspacesScreen'
import { useTheme } from '../ui/theme'
import { PairingScreen } from '../enroll/PairingScreen'

export type RootStackParamList = {
  Machines: undefined
  Pairing: { machineId: string }
  Workspaces: { machineId: string }
  Sessions: { machineId: string; workspaceId: string }
  Chat: { machineId: string; sessionId: string; title?: string }
  Launch: { machineId: string; workspaceId: string }
  Requests: { machineId: string; requestId?: string }
  Appearance: undefined
  Developer: undefined
}

const Stack = createNativeStackNavigator<RootStackParamList>()

const developer = __DEV__
  ? // eslint-disable-next-line @typescript-eslint/no-require-imports -- a static import would put the screen in every build
    (require('../screens/DeveloperScreen') as typeof import('../screens/DeveloperScreen'))
  : null

export function RootNavigator(): ReactNode {
  const t = useTheme()
  return (
    <Stack.Navigator
      initialRouteName="Machines"
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: t.colors.surface0 }
      }}
    >
      <Stack.Screen name="Pairing" component={PairingScreen} />
      <Stack.Screen name="Machines" component={MachinesScreen} />
      <Stack.Screen name="Workspaces" component={WorkspacesScreen} />
      <Stack.Screen name="Sessions" component={SessionsScreen} />
      <Stack.Screen name="Chat" component={ChatScreen} />
      <Stack.Screen name="Launch" component={LaunchScreen} />
      <Stack.Screen name="Requests" component={RequestsScreen} />
      <Stack.Screen name="Appearance" component={AppearanceScreen} />
      {developer ? <Stack.Screen name="Developer" component={developer.DeveloperScreen} /> : null}
    </Stack.Navigator>
  )
}
