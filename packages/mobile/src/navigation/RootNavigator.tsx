/**
 * The screens, one native stack: Machines, the Workspaces of a machine, the
 * Sessions of a workspace, a Chat, the Launch form, the Requests of a
 * machine, and, in a development build only, the Developer connection. The
 * developer screen's module is required under `__DEV__`, so a release
 * bundle has no route to it (`scripts/check-release-bundle.mjs`).
 */
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import type { ReactNode } from 'react'
import { ChatScreen } from '../screens/ChatScreen'
import { LaunchScreen } from '../screens/LaunchScreen'
import { MachinesScreen } from '../screens/MachinesScreen'
import { RequestsScreen } from '../screens/RequestsScreen'
import { SessionsScreen } from '../screens/SessionsScreen'
import { WorkspacesScreen } from '../screens/WorkspacesScreen'
import { colors } from '../ui/theme'

export type RootStackParamList = {
  Machines: undefined
  Workspaces: { machineId: string }
  Sessions: { machineId: string; workspaceId: string }
  Chat: { machineId: string; sessionId: string; title?: string }
  Launch: { machineId: string; workspaceId: string }
  Requests: { machineId: string }
  Developer: undefined
}

const Stack = createNativeStackNavigator<RootStackParamList>()

const developer = __DEV__
  ? // eslint-disable-next-line @typescript-eslint/no-require-imports -- a static import would put the screen in every build
    (require('../screens/DeveloperScreen') as typeof import('../screens/DeveloperScreen'))
  : null

export function RootNavigator(): ReactNode {
  return (
    <Stack.Navigator
      initialRouteName="Machines"
      screenOptions={{
        headerStyle: { backgroundColor: colors.surface50 },
        headerTintColor: colors.textPrimary,
        headerTitleStyle: { color: colors.textPrimary },
        contentStyle: { backgroundColor: colors.surface0 }
      }}
    >
      <Stack.Screen name="Machines" component={MachinesScreen} options={{ title: 'Machines' }} />
      <Stack.Screen
        name="Workspaces"
        component={WorkspacesScreen}
        options={{ title: 'Workspaces' }}
      />
      <Stack.Screen name="Sessions" component={SessionsScreen} options={{ title: 'Sessions' }} />
      <Stack.Screen
        name="Chat"
        component={ChatScreen}
        options={({ route }) => ({ title: route.params.title ?? 'Chat' })}
      />
      <Stack.Screen name="Launch" component={LaunchScreen} options={{ title: 'Start a session' }} />
      <Stack.Screen name="Requests" component={RequestsScreen} options={{ title: 'Requests' }} />
      {developer ? (
        <Stack.Screen
          name="Developer"
          component={developer.DeveloperScreen}
          options={{ title: 'Developer connection' }}
        />
      ) : null}
    </Stack.Navigator>
  )
}
