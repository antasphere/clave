import { useFocusEffect } from '@react-navigation/native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useCallback, type ReactNode } from 'react'
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { WorkspaceView } from '../contract/types'
import type { RootStackParamList } from '../navigation/RootNavigator'
import { conversationKey } from '../state/store'
import { useSel, useStoreApi } from '../state/context'
import {
  REACHABILITY_LABEL,
  SESSION_STATE_LABEL,
  phoneSessionState,
  sessionsOfWorkspace
} from '../state/session-state'
import { PaneHeader } from '../ui/PaneHeader'
import {
  Button,
  Card,
  EmptyState,
  IconButton,
  Loading,
  Notice,
  Row,
  Screen,
  SectionTitle,
  StatusDot,
  StatusText
} from '../ui/components'
import { gutter, space, text, type, useTheme } from '../ui/theme'
import { dotOf, reachStatus, stateInk } from '../ui/status'

type Props = NativeStackScreenProps<RootStackParamList, 'Sessions'>

// Selectors answer stable references: a default made inside one would be a
// new object every render, which React's store subscription refuses.
const NO_WORKSPACES: readonly WorkspaceView[] = []
const NO_STAMPS: Readonly<Record<string, string | undefined>> = {}

const basename = (path: string): string => path.split('/').filter(Boolean).pop() ?? path

export function SessionsScreen({ navigation, route }: Props): ReactNode {
  const { machineId, workspaceId } = route.params
  const t = useTheme()
  const insets = useSafeAreaInsets()
  const store = useStoreApi()
  const workspaces = useSel((s) => s.workspaces[machineId]) ?? NO_WORKSPACES
  const workspace = workspaces.find((w) => w.id === workspaceId)
  const machine = useSel((s) => s.machines.find((m) => m.id === machineId))
  const sessions = useSel((s) => s.sessions[machineId])
  const stamps = useSel((s) => s.stamps[machineId]) ?? NO_STAMPS
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
  const start = (): void => navigation.navigate('Launch', { machineId, workspaceId })

  return (
    <Screen>
      <PaneHeader
        title={workspace?.name ?? 'Sessions'}
        meta={machine?.name}
        onBack={() => navigation.goBack()}
        actions={
          <IconButton name="plus" label="New session" onPress={start} testID="new-session" />
        }
      />
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
        <SectionTitle
          title="Sessions"
          description="Chats open on the phone; terminals are read on the Mac."
        />
        {listed.length ? (
          <Card>
            {listed.map((item, index) => {
              const state = phoneSessionState(
                item.state,
                fatal[conversationKey(machineId, item.id)]
              )
              const chat = item.transport === 'events'
              return (
                <Row
                  key={item.id}
                  title={item.title || basename(item.cwd)}
                  description={
                    chat
                      ? `${item.provider} · ${basename(item.cwd)}`
                      : `Terminal · ${basename(item.cwd)} · read-only on the phone`
                  }
                  leading={<StatusDot status={dotOf[state]} />}
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
                  chevron={chat}
                  testID={`session-row-${index}`}
                  controls={
                    <Text
                      style={[type(text.xs), { color: stateInk(t, state) }]}
                      testID={`session-state-${index}`}
                    >
                      {SESSION_STATE_LABEL[state]}
                    </Text>
                  }
                />
              )
            })}
          </Card>
        ) : sessions === undefined && !error ? (
          <Loading />
        ) : (
          <EmptyState
            icon="chat-bubble-left-right"
            title={`No session in ${workspace?.name ?? 'this workspace'} yet`}
            text="Start one from a saved profile."
            action={<Button title="New session" onPress={start} compact />}
            testID="sessions-empty"
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
  }
})
