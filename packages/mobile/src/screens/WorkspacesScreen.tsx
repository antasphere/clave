import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useCallback, useEffect, type ReactNode } from 'react'
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { RootStackParamList } from '../navigation/RootNavigator'
import { useSel, useStoreApi } from '../state/context'
import { REACHABILITY_LABEL } from '../state/session-state'
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
import { control, gutter, space, text, type, useTheme } from '../ui/theme'
import { reachStatus } from '../ui/status'

type Props = NativeStackScreenProps<RootStackParamList, 'Workspaces'>

export function WorkspacesScreen({ navigation, route }: Props): ReactNode {
  const { machineId } = route.params
  const t = useTheme()
  const insets = useSafeAreaInsets()
  const store = useStoreApi()
  const machine = useSel((s) => s.machines.find((m) => m.id === machineId))
  const machinesLoading = useSel((s) => s.machinesLoading)
  const workspaces = useSel((s) => s.workspaces[machineId])
  const error = useSel((s) => s.workspacesError[machineId] ?? null)
  const reach = useSel((s) => s.reachability[machineId] ?? 'connecting')
  const pending = useSel((s) => s.requests[machineId]?.snapshot?.pending.length ?? 0)

  const load = useCallback(async (): Promise<void> => {
    const state = store.getState()
    if (!state.machines.length) await state.loadMachines()
    if (!store.getState().machines.some((m) => m.id === machineId)) return
    await Promise.all([state.loadWorkspaces(machineId), state.loadRequests(machineId)])
  }, [store, machineId])

  useEffect(() => {
    void load()
  }, [load])

  const header = (
    <PaneHeader
      title={machine ? machine.name : 'Workspaces'}
      meta="Workspaces"
      onBack={() => navigation.goBack()}
      actions={
        <View style={styles.requests}>
          {pending ? <Badge testID="requests-pending">{pending}</Badge> : null}
          <IconButton
            name="inbox-stack"
            label={`Requests, ${pending} pending`}
            onPress={() => navigation.navigate('Requests', { machineId })}
            testID="open-requests"
          />
        </View>
      }
    />
  )

  if (!machine) {
    return (
      <Screen>
        {header}
        {machinesLoading ? <Loading /> : <Notice>That machine is not in the list any more.</Notice>}
      </Screen>
    )
  }

  return (
    <Screen>
      {header}
      <ScrollView
        contentContainerStyle={{ paddingTop: space(3), paddingBottom: insets.bottom + space(6) }}
        refreshControl={
          <RefreshControl
            refreshing={false}
            onRefresh={() => void load()}
            tintColor={t.colors.textSecondary}
            colors={[t.colors.textSecondary]}
            progressBackgroundColor={t.colors.surface100}
          />
        }
      >
        <View style={styles.state}>
          <Text style={[type(text.xs), { color: t.colors.textTertiary }]}>Machine</Text>
          <StatusText status={reachStatus(reach)} testID="machine-reachability">
            {REACHABILITY_LABEL[reach]}
          </StatusText>
        </View>
        {error ? (
          <Notice tone="error" style={{ marginBottom: space(3) }}>
            {error}
          </Notice>
        ) : null}
        <SectionTitle title="Workspaces" description="The folders registered on this machine." />
        {workspaces?.length ? (
          <Card>
            {workspaces.map((item) => (
              <Row
                key={item.id}
                title={item.name}
                description={item.rootDir}
                leading={<Icon name="folder" size={control.icon} color={t.colors.textTertiary} />}
                onPress={() => navigation.navigate('Sessions', { machineId, workspaceId: item.id })}
                chevron
                testID={`workspace-row-${item.id}`}
              />
            ))}
          </Card>
        ) : workspaces === undefined && !error ? (
          <Loading />
        ) : (
          <EmptyState
            icon="folder"
            title="No workspace yet"
            text="Add one on the Mac, in Settings → General → Workspaces."
          />
        )}
      </ScrollView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  state: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(2),
    paddingHorizontal: gutter,
    paddingBottom: space(4)
  },
  requests: { flexDirection: 'row', alignItems: 'center', gap: space(1) }
})
