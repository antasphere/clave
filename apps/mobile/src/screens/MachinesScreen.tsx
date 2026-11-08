import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useEffect, type ReactNode } from 'react'
import { Alert, ScrollView, RefreshControl, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { RootStackParamList } from '../navigation/RootNavigator'
import type { Machine } from '../machines/types'
import { AccountPanel } from '../auth/AccountPanel'
import { useServices, useSel, useStoreApi } from '../state/context'
import { REACHABILITY_LABEL } from '../state/session-state'
import { reachStatus } from '../ui/status'
import { Icon } from '../ui/Icon'
import { PaneHeader } from '../ui/PaneHeader'
import {
  Badge,
  Card,
  EmptyState,
  IconButton,
  Loading,
  Notice,
  Row,
  Screen,
  SectionTitle,
  StatusText
} from '../ui/components'
import { control, space, useTheme } from '../ui/theme'

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
  const t = useTheme()
  const insets = useSafeAreaInsets()
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
      <PaneHeader
        title="Machines"
        meta="Your Macs and Clave servers"
        actions={
          <IconButton
            name="paint-brush"
            label="Appearance"
            onPress={() => navigation.navigate('Appearance')}
            testID="open-appearance"
          />
        }
      />
      <ScrollView
        contentContainerStyle={{
          paddingTop: space(4),
          paddingBottom: insets.bottom + space(6),
          gap: space(9)
        }}
        refreshControl={
          <RefreshControl
            refreshing={loading}
            onRefresh={() => void store.getState().loadMachines()}
            tintColor={t.colors.textSecondary}
            colors={[t.colors.textSecondary]}
            progressBackgroundColor={t.colors.surface100}
          />
        }
        keyboardShouldPersistTaps="handled"
      >
        <AccountPanel />
        <View>
          <SectionTitle
            title="Machines"
            description="A Mac running Clave, or a Clave server, paired with this phone."
          />
          {error ? (
            <Notice tone="error" style={{ marginBottom: space(2) }}>
              {error}
            </Notice>
          ) : null}
          {machines.length ? (
            <Card>
              {machines.map((item) => {
                const reach = reachability[item.id]
                return (
                  <Row
                    key={item.id}
                    title={item.name}
                    description={describe(item)}
                    leading={
                      <Icon
                        name={item.platform === 'macos' ? 'computer-desktop' : 'server-stack'}
                        size={control.icon}
                        color={t.colors.textTertiary}
                      />
                    }
                    onPress={() => open(item)}
                    onLongPress={() => actions(item)}
                    testID={`machine-row-${item.id}`}
                    controls={
                      <>
                        {mainMachineId === item.id ? <Badge>Main</Badge> : null}
                        {reach ? (
                          <StatusText status={reachStatus(reach)}>
                            {REACHABILITY_LABEL[reach]}
                          </StatusText>
                        ) : (
                          <StatusText status={item.online ? 'connected' : 'neutral'}>
                            {item.online ? 'Online' : 'Offline'}
                          </StatusText>
                        )}
                        <IconButton
                          name="ellipsis-horizontal"
                          size="sm"
                          label={`More about ${item.name}`}
                          onPress={() => actions(item)}
                          testID={`machine-actions-${item.id}`}
                        />
                      </>
                    }
                  />
                )
              })}
            </Card>
          ) : loading ? (
            <Loading />
          ) : (
            <EmptyState
              icon="computer-desktop"
              title="No machine yet"
              text="Sign in to see your own machines; in a development build, add a server below."
              testID="machines-empty"
            />
          )}
        </View>
        {__DEV__ ? (
          <View>
            <SectionTitle title="Development" description="This build only." />
            <Card>
              <Row
                title="Developer connection"
                description="A standalone server on this network, by address and token."
                leading={
                  <Icon name="command-line" size={control.icon} color={t.colors.textTertiary} />
                }
                onPress={() => navigation.navigate('Developer')}
                chevron
                testID="developer-connection"
              />
            </Card>
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  )
}
