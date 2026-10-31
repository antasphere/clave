/**
 * The developer's connection to a local standalone server, by address and
 * token (decision 13 of the spec): present in a development build only.
 * The navigator requires this module under `__DEV__`, and
 * `scripts/check-release-bundle.mjs` greps the exported release bundle for
 * DEVELOPER_CONNECTION_MARKER and fails when it is there.
 */
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useState, type ReactNode } from 'react'
import { ScrollView, Text, View } from 'react-native'
import type { RootStackParamList } from '../navigation/RootNavigator'
import { useStoreApi } from '../state/context'
import { Button, ErrorText, Field, Screen } from '../ui/components'
import { colors, font, space } from '../ui/theme'

export const DEVELOPER_CONNECTION_MARKER = 'clave-mobile:developer-connection'

type Props = NativeStackScreenProps<RootStackParamList, 'Developer'>

export function DeveloperScreen({ navigation }: Props): ReactNode {
  const store = useStoreApi()
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [name, setName] = useState('Developer machine')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const connect = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await store
        .getState()
        .addDeveloperMachine(url, token.trim(), name.trim() || 'Developer machine')
      navigation.goBack()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{ padding: space.lg, gap: space.lg }}
        keyboardShouldPersistTaps="handled"
        testID={DEVELOPER_CONNECTION_MARKER}
      >
        <Text style={{ color: colors.textSecondary, fontSize: font.sm }}>
          A standalone Clave server on this network, by its address and token: what `npm run
          dev:server` prints. Development builds only; the beta signs in instead.
        </Text>
        <Field
          label="Server address"
          value={url}
          onChangeText={setUrl}
          placeholder="http://127.0.0.1:43201"
          keyboardType="url"
          testID="developer-url"
        />
        {/* A plain field, not a secure one: the token is the developer's own
            local server's, and a secure field on iOS 26 drops the focus the
            automated check types into. This screen exists in development
            builds only. */}
        <Field
          label="Server token"
          value={token}
          onChangeText={setToken}
          spellCheck={false}
          textContentType="none"
          testID="developer-token"
        />
        <Field label="Name" value={name} onChangeText={setName} testID="developer-name" />
        {error ? <ErrorText testID="developer-error">{error}</ErrorText> : null}
        <View>
          <Button
            title={busy ? 'Connecting…' : 'Connect'}
            onPress={() => void connect()}
            disabled={busy || !token.trim() || !url.trim()}
            testID="developer-connect"
          />
        </View>
      </ScrollView>
    </Screen>
  )
}
