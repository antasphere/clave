import { useFocusEffect } from '@react-navigation/native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useCallback, type ReactNode } from 'react'
import { FlatList, RefreshControl, View } from 'react-native'
import type { RootStackParamList } from '../navigation/RootNavigator'
import { conversationKey } from '../state/store'
import { useSel, useStoreApi } from '../state/context'
import {
  REACHABILITY_LABEL,
  SESSION_STATE_LABEL,
  phoneSessionState,
  sessionsOfWorkspace,
  type PhoneSessionState
} from '../state/session-state'
import { Button, ErrorText, Muted, Pill, Row, Screen, Spinner } from '../ui/components'
import { colors, space, type Tone } from '../ui/theme'

type Props = NativeStackScreenProps<RootStackParamList, 'Sessions'>

const tone: Record<PhoneSessionState, Tone> = {
  working: 'accent',
  waiting: 'warning',
  idle: 'neutral',
  finished: 'neutral',
  error: 'danger'
}

const basename = (path: string): string => path.split('/').filter(Boolean).pop() ?? path

export function SessionsScreen({ navigation, route }: Props): ReactNode {
  const { machineId, workspaceId } = route.params
  const store = useStoreApi()
  const workspaces = useSel((s) => s.workspaces[machineId] ?? [])
  const workspace = workspaces.find((w) => w.id === workspaceId)
  const sessions = useSel((s) => s.sessions[machineId])
  const stamps = useSel((s) => s.stamps[machineId] ?? {})
  const fatal = useSel((s) => s.fatal)
  const error = useSel((s) => s.sessionsError[machineId] ?? null)
  const reach = useSel((s) => s.reachability[machineId] ?? 'connecting')

  const load = useCallback(async (): Promise<void> => {
    const state = store.getState()
    if (!state.workspaces[machineId]) await state.loadWorkspaces(machineId)
    await state.loadSessions(machineId)
  }, [store, machineId])

  useFocusEffect(
    useCallback(() => {
      void load()
    }, [load])
  )

  const listed = sessionsOfWorkspace(
    sessions ?? [],
    new Map(Object.entries(stamps)),
    workspaces,
    workspaceId
  )

  return (
    <Screen>
      <View
        style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.lg }}
      >
        <Pill
          text={REACHABILITY_LABEL[reach]}
          tone={reach === 'reachable' ? 'success' : reach === 'connecting' ? 'neutral' : 'danger'}
          testID="machine-reachability"
        />
        <View style={{ flex: 1 }} />
        <Button
          title="New session"
          onPress={() => navigation.navigate('Launch', { machineId, workspaceId })}
          testID="new-session"
        />
      </View>
      <FlatList
        data={listed}
        keyExtractor={(s) => s.id}
        refreshControl={
          <RefreshControl
            refreshing={false}
            onRefresh={() => void load()}
            tintColor={colors.textSecondary}
          />
        }
        renderItem={({ item, index }) => {
          const state = phoneSessionState(item.state, fatal[conversationKey(machineId, item.id)])
          const chat = item.transport === 'events'
          return (
            <Row
              title={item.title || basename(item.cwd)}
              subtitle={
                chat
                  ? `${item.provider} · ${basename(item.cwd)}`
                  : `Terminal · ${basename(item.cwd)} · read-only on the phone`
              }
              onPress={
                chat
                  ? () =>
                      navigation.navigate('Chat', {
                        machineId,
                        sessionId: item.id,
                        title: item.title || basename(item.cwd)
                      })
                  : undefined
              }
              testID={`session-row-${index}`}
              right={
                <Pill
                  text={SESSION_STATE_LABEL[state]}
                  tone={tone[state]}
                  testID={`session-state-${index}`}
                />
              }
            />
          )
        }}
        ListHeaderComponent={error ? <ErrorText>{error}</ErrorText> : undefined}
        ListEmptyComponent={
          sessions === undefined && !error ? (
            <Spinner />
          ) : (
            <Muted testID="sessions-empty">
              No session in {workspace?.name ?? 'this workspace'} yet. Start one from a saved
              profile.
            </Muted>
          )
        }
      />
    </Screen>
  )
}
