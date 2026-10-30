import { useEffect, useState, type ReactNode } from 'react'
import { View } from 'react-native'
import { useServices, useStoreApi } from '../state/context'
import { Button, ErrorText, Field, Muted } from '../ui/components'
import { space } from '../ui/theme'
import type { AuthStatus } from './sign-in'

export function AccountPanel(): ReactNode {
  const beta = useServices().beta
  const store = useStoreApi()
  const [status, setStatus] = useState<AuthStatus | null>(beta?.auth.status() ?? null)
  const [relay, setRelay] = useState('')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!beta) return
    void beta.relayUrl().then(setRelay)
    return beta.auth.onChange(setStatus)
  }, [beta])
  if (!beta || !status) return null
  const refresh = async (): Promise<void> => {
    try {
      setError(null)
      store.getState().disconnectAll()
      await beta.setRelayUrl(relay)
      await store.getState().loadMachines()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The relay address could not be saved.')
    }
  }
  return (
    <View style={{ padding: space.lg, gap: space.md }}>
      <Muted>
        {status.account
          ? `Signed in as ${status.account.name ?? status.account.email ?? 'your Antasphere account'}`
          : 'Sign in with your Antasphere account to see your machines.'}
      </Muted>
      {status.lastFailure ? (
        <ErrorText testID="account-error">
          Sign-in could not complete: {status.lastFailure}. Try again.
        </ErrorText>
      ) : null}
      <Button
        title={
          status.account
            ? 'Sign out'
            : status.phase === 'signing-in'
              ? 'Signing in…'
              : 'Sign in with Antasphere'
        }
        disabled={status.phase === 'signing-in'}
        testID="account-sign-in"
        onPress={() => {
          store.getState().disconnectAll()
          void (status.account ? beta.auth.signOut() : beta.auth.signIn())
        }}
      />
      {status.account ? (
        <>
          <Field
            label="Team relay address"
            value={relay}
            onChangeText={setRelay}
            placeholder="https://your-team-relay.example"
            testID="relay-address"
          />
          <Button
            title="Connect to team relay"
            kind="secondary"
            onPress={() => void refresh()}
            testID="relay-connect"
          />
        </>
      ) : null}
      {error ? <ErrorText>{error}</ErrorText> : null}
    </View>
  )
}
