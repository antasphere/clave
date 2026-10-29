import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useCallback, useEffect, type ReactNode } from 'react'
import { FlatList, Pressable, RefreshControl, Text, View } from 'react-native'
import type { RootStackParamList } from '../navigation/RootNavigator'
import { useSel, useStoreApi } from '../state/context'
import { REACHABILITY_LABEL } from '../state/session-state'
import { ErrorText, Muted, Pill, Row, Screen, Spinner } from '../ui/components'
import { colors, font, space } from '../ui/theme'

type Props = NativeStackScreenProps<RootStackParamList, 'Workspaces'>

export function WorkspacesScreen({ navigation, route }: Props): ReactNode {
  const { machineId } = route.params
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

  useEffect(() => {
    navigation.setOptions({
      title: machine ? machine.name : 'Workspaces',
      headerRight: () => (
        <Pressable
          onPress={() => navigation.navigate('Requests', { machineId })}
          testID="open-requests"
          accessibilityRole="button"
          accessibilityLabel={`Requests, ${pending} pending`}
          style={{ paddingHorizontal: space.sm, paddingVertical: space.xs }}
        >
          <Text style={{ color: colors.accent, fontSize: font.md }}>
            Requests{pending ? ` (${pending})` : ''}
          </Text>
        </Pressable>
      )
    })
  }, [navigation, machine, machineId, pending])

  if (!machine) {
    return (
      <Screen>
        {machinesLoading ? <Spinner /> : <Muted>That machine is not in the list any more.</Muted>}
      </Screen>
    )
  }

  return (
    <Screen>
      <View
        style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.lg }}
      >
        <Text style={{ color: colors.textSecondary, fontSize: font.sm }}>Machine</Text>
        <Pill
          text={REACHABILITY_LABEL[reach]}
          tone={reach === 'reachable' ? 'success' : reach === 'connecting' ? 'neutral' : 'danger'}
          testID="machine-reachability"
        />
      </View>
      <FlatList
        data={workspaces ?? []}
        keyExtractor={(w) => w.id}
        refreshControl={
          <RefreshControl
            refreshing={false}
            onRefresh={() => void load()}
            tintColor={colors.textSecondary}
          />
        }
        renderItem={({ item }) => (
          <Row
            title={item.name}
            subtitle={item.rootDir}
            onPress={() => navigation.navigate('Sessions', { machineId, workspaceId: item.id })}
            testID={`workspace-row-${item.id}`}
          />
        )}
        ListHeaderComponent={error ? <ErrorText>{error}</ErrorText> : undefined}
        ListEmptyComponent={
          workspaces === undefined && !error ? (
            <Spinner />
          ) : (
            <Muted>
              This machine has no workspace yet. Add one on the Mac, in Settings → General →
              Workspaces.
            </Muted>
          )
        }
      />
    </Screen>
  )
}
