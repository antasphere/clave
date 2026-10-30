import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useEffect, type ReactNode } from 'react'
import { Alert, FlatList, RefreshControl, View } from 'react-native'
import type { RootStackParamList } from '../navigation/RootNavigator'
import type { Machine } from '../machines/types'
import { AccountPanel } from '../auth/AccountPanel'
import { useServices, useSel, useStoreApi } from '../state/context'
import { REACHABILITY_LABEL } from '../state/session-state'
import { Button, ErrorText, Muted, Pill, Row, Screen, Spinner } from '../ui/components'
import { colors, space } from '../ui/theme'

type Props = NativeStackScreenProps<RootStackParamList, 'Machines'>

const when = (lastSeen: number | null): string => {
  if (lastSeen === null) return 'never seen'
  const minutes = Math.round((Date.now() - lastSeen) / 60_000)
  if (minutes < 1) return 'seen just now'
  if (minutes < 60) return `seen ${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `seen ${hours} h ago`
  return `seen ${new Date(lastSeen).toLocaleDateString()}`
}

const describe = (m: Machine): string => {
  const platform =
    m.platform === 'macos' ? 'macOS' : m.platform === 'linux' ? 'Linux' : 'Clave server'
  const version = m.version ? ` · Clave ${m.version}` : ''
  const presence = m.online ? 'online' : when(m.lastSeen)
  return `${platform}${version} · ${presence}`
}

export function MachinesScreen({ navigation }: Props): ReactNode {
  const store = useStoreApi()
  const services = useServices()
  const machines = useSel((s) => s.machines)
  const loading = useSel((s) => s.machinesLoading)
  const error = useSel((s) => s.machinesError)
  const mainMachineId = useSel((s) => s.mainMachineId)
  const reachability = useSel((s) => s.reachability)

  useEffect(() => {
    void store.getState().loadMachines()
  }, [store])

  const open = (machine: Machine): void => {
    void services.credentials
      .get(machine.id)
      .then((credential) =>
        credential
          ? navigation.navigate('Workspaces', { machineId: machine.id })
          : navigation.navigate('Pairing', { machineId: machine.id })
      )
  }
  const actions = (machine: Machine): void => {
    Alert.alert(machine.name, machine.baseUrl, [
      {
        text:
          mainMachineId === machine.id ? 'Already the main machine' : 'Make it the main machine',
        onPress: () => void store.getState().setMainMachine(machine.id)
      },
      ...(machine.id.startsWith('dev:')
        ? [
            {
              text: 'Forget this machine',
              style: 'destructive' as const,
              onPress: () => void store.getState().removeDeveloperMachine(machine.id)
            }
          ]
        : []),
      { text: 'Cancel', style: 'cancel' as const }
    ])
  }

  return (
    <Screen>
      <FlatList
        data={machines}
        keyExtractor={(m) => m.id}
        refreshControl={
          <RefreshControl
            refreshing={loading}
            onRefresh={() => void store.getState().loadMachines()}
            tintColor={colors.textSecondary}
          />
        }
        renderItem={({ item }) => {
          const reach = reachability[item.id]
          return (
            <Row
              title={item.name}
              subtitle={describe(item)}
              onPress={() => open(item)}
              testID={`machine-row-${item.id}`}
              right={
                <View style={{ alignItems: 'flex-end', gap: space.xs }}>
                  {mainMachineId === item.id ? <Pill text="Main" tone="accent" /> : null}
                  {reach ? (
                    <Pill
                      text={REACHABILITY_LABEL[reach]}
                      tone={
                        reach === 'reachable'
                          ? 'success'
                          : reach === 'connecting'
                            ? 'neutral'
                            : 'danger'
                      }
                    />
                  ) : (
                    <Pill
                      text={item.online ? 'Online' : 'Offline'}
                      tone={item.online ? 'success' : 'neutral'}
                    />
                  )}
                  <Button
                    title="…"
                    kind="secondary"
                    onPress={() => actions(item)}
                    testID={`machine-actions-${item.id}`}
                  />
                </View>
              }
            />
          )
        }}
        ListEmptyComponent={
          loading ? (
            <Spinner />
          ) : (
            <Muted testID="machines-empty">
              No machine yet. Sign in to see your own machines; in a development build, add a server
              below.
            </Muted>
          )
        }
        ListHeaderComponent={
          <>
            <AccountPanel />
            {error ? <ErrorText>{error}</ErrorText> : null}
          </>
        }
        ListFooterComponent={
          __DEV__ ? (
            <View style={{ padding: space.lg }}>
              <Button
                title="Developer connection"
                kind="secondary"
                onPress={() => navigation.navigate('Developer')}
                testID="developer-connection"
              />
            </View>
          ) : undefined
        }
      />
    </Screen>
  )
}
