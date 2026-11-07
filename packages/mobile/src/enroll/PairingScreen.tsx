import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useEffect, useState, type ReactNode } from 'react'
import { View } from 'react-native'
import type { RootStackParamList } from '../navigation/RootNavigator'
import { useServices, useStoreApi } from '../state/context'
import { PaneHeader } from '../ui/PaneHeader'
import { Button, EmptyState, Notice, Screen, Spinner } from '../ui/components'
import { space } from '../ui/theme'
import type { PairingState } from './pairing'

type Props = NativeStackScreenProps<RootStackParamList, 'Pairing'>
export function PairingScreen({ route, navigation }: Props): ReactNode {
  const { machineId } = route.params
  const beta = useServices().beta
  const store = useStoreApi()
  const machine = store.getState().machines.find((candidate) => candidate.id === machineId)
  const [state, setState] = useState<PairingState>({ kind: 'requesting' })
  const [attempt, setAttempt] = useState(0)
  const [pushNote, setPushNote] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    const machine = store.getState().machines.find((candidate) => candidate.id === machineId)
    if (!beta || !machine) {
      void Promise.resolve().then(() => {
        if (!cancelled)
          setState({
            kind: 'failed',
            failure: 'protocol',
            message: 'The machine is not available. Return to Machines and refresh.'
          })
      })
      return
    }
    void beta
      .pair(
        machine,
        (next) => {
          if (!cancelled) setState(next)
        },
        () => cancelled
      )
      .then(async (result) => {
        if (cancelled || result.kind !== 'approved') return
        const token = await beta.registerPush(machineId)
        if (!cancelled && (token.kind === 'unsupported' || token.kind === 'failed'))
          setPushNote(token.reason)
      })
      .catch(() => {
        if (!cancelled)
          setState({
            kind: 'failed',
            failure: 'network',
            message: 'Pairing could not complete. Try again.'
          })
      })
    return () => {
      cancelled = true
    }
  }, [beta, store, machineId, attempt])
  return (
    <Screen>
      <PaneHeader title="Pair this phone" meta={machine?.name} onBack={() => navigation.goBack()} />
      <View style={{ paddingTop: space(6), gap: space(4) }}>
        {state.kind === 'requesting' || state.kind === 'waiting' ? (
          <>
            <View style={{ alignItems: 'center' }}>
              <Spinner size={18} />
            </View>
            <Notice testID="pairing-waiting">
              Approve this phone on your Mac in Settings → Mobile. Clave checks every two seconds.
            </Notice>
          </>
        ) : state.kind === 'approved' ? (
          <EmptyState
            icon="shield-check"
            title={`This phone is paired with ${state.record.serverName}.`}
            text={pushNote ?? undefined}
            action={
              <Button
                title="Open workspaces"
                testID="pairing-open"
                onPress={() => navigation.replace('Workspaces', { machineId })}
              />
            }
            testID="pairing-approved"
          />
        ) : (
          <>
            <Notice tone="error" testID="pairing-failed">
              {state.kind === 'refused'
                ? 'The owner refused this pairing.'
                : state.kind === 'expired'
                  ? 'The pairing expired. Ask again when your Mac is available.'
                  : state.kind === 'failed'
                    ? state.message
                    : 'Pairing was cancelled.'}
            </Notice>
            <View style={{ alignItems: 'center' }}>
              <Button
                title="Pair again"
                kind="secondary"
                onPress={() => setAttempt((n) => n + 1)}
              />
            </View>
          </>
        )}
      </View>
    </Screen>
  )
}
