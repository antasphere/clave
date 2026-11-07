import { useEffect, useState, type ReactNode } from 'react'
import { Alert, View } from 'react-native'
import { useServices, useStoreApi } from '../state/context'
import { Icon } from '../ui/Icon'
import { Button, Callout, Card, Field, Notice, Row, SectionTitle } from '../ui/components'
import { control, space, useTheme } from '../ui/theme'
import type { AuthStatus } from './sign-in'

/** Settings → Accounts on the desktop: who is signed in and how, as a row of
 *  a card; under it the team relay the beta reaches its machines through. */
export function AccountPanel(): ReactNode {
  const t = useTheme()
  const beta = useServices().beta
  const store = useStoreApi()
  const [status, setStatus] = useState<AuthStatus | null>(beta?.auth.status() ?? null)
  const [relay, setRelay] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [signingOut, setSigningOut] = useState(false)
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
      const cleanup = await beta.setRelayUrl(relay)
      if (cleanup.pending !== 0)
        Alert.alert(
          'Relay changed',
          'Some previous machines have not confirmed notification removal and may still send updates. Removal will retry when you reopen this account. You can revoke this phone in Settings → Mobile on those machines.'
        )
      await store.getState().loadMachines()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The relay address could not be saved.')
    }
  }
  const account = status.account
  const name = account?.name ?? account?.email ?? 'your Antasphere account'
  return (
    <View>
      <SectionTitle
        title="Account"
        description="The Antasphere account the phone's machines belong to."
      />
      <Card>
        <Row
          title={account ? name : 'Not signed in'}
          description={
            account
              ? 'Signed in with Antasphere'
              : 'Sign in with your Antasphere account to see your machines.'
          }
          leading={<Icon name="user-circle" size={control.icon} color={t.colors.textTertiary} />}
          controls={
            <Button
              title={
                account ? 'Sign out' : status.phase === 'signing-in' ? 'Signing in…' : 'Sign in'
              }
              kind={account ? 'secondary' : 'primary'}
              compact
              disabled={status.phase === 'signing-in' || signingOut}
              testID="account-sign-in"
              onPress={() => {
                store.getState().disconnectAll()
                if (!account) {
                  void beta.auth.signIn()
                  return
                }
                setSigningOut(true)
                void beta
                  .signOut()
                  .then((result) => {
                    if (result.pending !== 0)
                      Alert.alert(
                        'Signed out',
                        result.retryRecorded
                          ? 'Some machines could not confirm notification removal and may still send updates. Removal will retry when you sign back in to this account. You can also revoke this phone in Settings → Mobile on the Mac.'
                          : 'Some machines could not confirm notification removal and may still send updates. Try signing in and signing out again, or revoke this phone in Settings → Mobile on the Mac.'
                      )
                  })
                  .catch(() => setError('Sign-out could not complete. Try again.'))
                  .finally(() => setSigningOut(false))
              }}
            />
          }
        />
        {account ? (
          <View style={{ padding: 14, paddingHorizontal: 16, gap: space(3) }}>
            <Field
              label="Team relay address"
              value={relay}
              onChangeText={setRelay}
              placeholder="https://your-team-relay.example"
              keyboardType="url"
              testID="relay-address"
            />
            <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
              <Button
                title="Connect to team relay"
                kind="secondary"
                compact
                disabled={signingOut}
                onPress={() => void refresh()}
                testID="relay-connect"
              />
            </View>
          </View>
        ) : null}
      </Card>
      {status.lastFailure ? (
        <View style={{ marginTop: space(2) }}>
          <Callout tone="danger" title="Sign-in could not complete" testID="account-error">
            {`${status.lastFailure}. Try again.`}
          </Callout>
        </View>
      ) : null}
      {error ? (
        <Notice tone="error" style={{ marginTop: space(2) }}>
          {error}
        </Notice>
      ) : null}
    </View>
  )
}
