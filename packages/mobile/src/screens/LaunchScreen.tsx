/**
 * Starting work: a launch profile saved on the person's main machine (the
 * chat profiles first) and the workspace of the machine the session runs
 * on; nothing about directories, models, commands or accounts is typed on
 * the phone (decision 7 of the spec). The start carries the profile's full
 * definition; a target that refuses it shows the server's own message,
 * naming the profile and the program, and the list stays. The rows wear
 * the desktop launcher's family marks (cli-logos.tsx) before each name.
 */
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useEffect, useState, type ReactNode } from 'react'
import { ScrollView } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { LaunchProfileView } from '../contract/types'
import type { RootStackParamList } from '../navigation/RootNavigator'
import { useSel, useStoreApi } from '../state/context'
import { orderProfiles } from '../state/store'
import { Icon } from '../ui/Icon'
import { familyIcon } from './launch-family'
import { PaneHeader } from '../ui/PaneHeader'
import {
  Badge,
  Card,
  EmptyState,
  Loading,
  Notice,
  Row,
  Screen,
  SectionTitle,
  Spinner
} from '../ui/components'
import { control, space, useTheme } from '../ui/theme'

type Props = NativeStackScreenProps<RootStackParamList, 'Launch'>

const isChat = (p: LaunchProfileView): boolean =>
  p.id === 'claude-chat' ||
  p.id === 'codex-chat' ||
  p.id.startsWith('chat:') ||
  p.id === 'dev-echo-adapter'

export function LaunchScreen({ navigation, route }: Props): ReactNode {
  const { machineId, workspaceId } = route.params
  const t = useTheme()
  const insets = useSafeAreaInsets()
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
      <PaneHeader
        title="Start a session"
        meta={workspace ? `in ${workspace.name}` : undefined}
        onBack={() => navigation.goBack()}
      />
      <ScrollView
        contentContainerStyle={{ paddingTop: space(4), paddingBottom: insets.bottom + space(6) }}
      >
        {refusal ? (
          <Notice tone="error" style={{ marginBottom: space(3) }} testID="launch-refusal">
            {refusal}
          </Notice>
        ) : null}
        <SectionTitle
          title="Saved profiles"
          description={`${target ? `Runs on ${target.name}` : ''}${
            source && source.id !== machineId
              ? ` · profiles of ${source.name}`
              : ' · its own saved profiles'
          }`}
        />
        {profiles.length ? (
          <Card>
            {profiles.map((item) => {
              const mark = familyIcon(item.family)
              return (
                <Row
                  key={item.id}
                  title={item.name}
                  description={`${item.family}${isChat(item) ? ' · chat' : ' · terminal'} · ${item.command.join(' ')}`}
                  leading={
                    <Icon
                      name={mark.name}
                      size={control.icon}
                      color={
                        mark.brand === 'claude' ? t.colors.brandClaude : t.colors.textSecondary
                      }
                    />
                  }
                  onPress={() => void start(item)}
                  disabled={starting !== null}
                  testID={`profile-row-${item.id}`}
                  controls={
                    starting === item.id ? <Spinner /> : isChat(item) ? <Badge>Chat</Badge> : null
                  }
                />
              )
            })}
          </Card>
        ) : prefsError ? (
          <Notice tone="error">{prefsError}</Notice>
        ) : prefs === undefined ? (
          <Loading />
        ) : (
          <EmptyState
            icon="book-open"
            title="No saved profile"
            text={`Save one on ${source?.name ?? 'the main machine'}, in Settings → Agents.`}
          />
        )}
      </ScrollView>
    </Screen>
  )
}
