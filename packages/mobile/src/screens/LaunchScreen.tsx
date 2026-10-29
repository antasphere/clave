/**
 * Starting work: a launch profile saved on the person's main machine (the
 * chat profiles first) and the workspace of the machine the session runs
 * on; nothing about directories, models, commands or accounts is typed on
 * the phone (decision 7 of the spec). The start carries the profile's full
 * definition; a target that refuses it shows the server's own message,
 * naming the profile and the program, and the list stays.
 */
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useEffect, useState, type ReactNode } from 'react'
import { FlatList, Text, View } from 'react-native'
import type { LaunchProfileView } from '../contract/types'
import type { RootStackParamList } from '../navigation/RootNavigator'
import { useSel, useStoreApi } from '../state/context'
import { orderProfiles } from '../state/store'
import { ErrorText, Heading, Muted, Pill, Row, Screen, Spinner } from '../ui/components'
import { colors, font, space } from '../ui/theme'

type Props = NativeStackScreenProps<RootStackParamList, 'Launch'>

const isChat = (p: LaunchProfileView): boolean =>
  p.id === 'claude-chat' ||
  p.id === 'codex-chat' ||
  p.id.startsWith('chat:') ||
  p.id === 'dev-echo-adapter'

export function LaunchScreen({ navigation, route }: Props): ReactNode {
  const { machineId, workspaceId } = route.params
  const store = useStoreApi()
  const machines = useSel((s) => s.machines)
  const mainMachineId = useSel((s) => s.mainMachineId) ?? machineId
  const profileSource = machines.some((m) => m.id === mainMachineId) ? mainMachineId : machineId
  const prefs = useSel((s) => s.profiles[profileSource])
  const prefsError = useSel((s) => s.profilesError[profileSource] ?? null)
  const workspace = useSel((s) => s.workspaces[machineId]?.find((w) => w.id === workspaceId))
  const [starting, setStarting] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)

  useEffect(() => {
    void store.getState().loadProfiles(profileSource)
    if (!store.getState().workspaces[machineId]) void store.getState().loadWorkspaces(machineId)
  }, [store, profileSource, machineId])

  const profiles = orderProfiles(prefs?.customProfiles ?? [])
  const target = machines.find((m) => m.id === machineId)
  const source = machines.find((m) => m.id === profileSource)

  const start = async (profile: LaunchProfileView): Promise<void> => {
    if (!workspace || starting) return
    setStarting(profile.id)
    setRefusal(null)
    try {
      const info = await store.getState().startSession(machineId, workspace, profile)
      navigation.replace('Chat', { machineId, sessionId: info.id, title: info.folderName })
    } catch (error) {
      setRefusal(error instanceof Error ? error.message : String(error))
    } finally {
      setStarting(null)
    }
  }

  return (
    <Screen>
      <View style={{ padding: space.lg, gap: space.xs }}>
        <Text style={{ color: colors.textPrimary, fontSize: font.lg }}>
          Start in {workspace?.name ?? 'this workspace'}
        </Text>
        <Text style={{ color: colors.textSecondary, fontSize: font.sm }}>
          {target ? `Runs on ${target.name}` : ''}
          {source && source.id !== machineId
            ? ` · profiles of ${source.name}`
            : ' · its own saved profiles'}
        </Text>
      </View>
      {refusal ? <ErrorText testID="launch-refusal">{refusal}</ErrorText> : null}
      <FlatList
        data={profiles}
        keyExtractor={(p) => p.id}
        renderItem={({ item }) => (
          <Row
            title={item.name}
            subtitle={`${item.family}${isChat(item) ? ' · chat' : ' · terminal'} · ${item.command.join(' ')}`}
            onPress={() => void start(item)}
            disabled={starting !== null}
            testID={`profile-row-${item.id}`}
            right={
              starting === item.id ? (
                <Spinner />
              ) : isChat(item) ? (
                <Pill text="Chat" tone="accent" />
              ) : null
            }
          />
        )}
        ListHeaderComponent={<Heading>Saved profiles</Heading>}
        ListEmptyComponent={
          prefsError ? (
            <ErrorText>{prefsError}</ErrorText>
          ) : prefs === undefined ? (
            <Spinner />
          ) : (
            <Muted>No saved profile on {source?.name ?? 'the main machine'}.</Muted>
          )
        }
      />
    </Screen>
  )
}
