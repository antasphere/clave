/**
 * The pending requests of a machine (decision 8 of the spec): the server
 * owns them and their first-valid-answer rule; the phone lists them,
 * refreshes on `requests.changed`, renders each kind as a native form and
 * resolves it through the server's own route. A resolution the server
 * refuses (another client answered first) is shown and the request goes.
 * A secret is entered here and travels in the resolve body only.
 */
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useEffect, useState, type ReactNode } from 'react'
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native'
import type { PendingRequest, RequestResponse, Session } from '../contract/types'
import type { RootStackParamList } from '../navigation/RootNavigator'
import {
  answersAsPermission,
  dismissal,
  shapeClarification,
  shapePermission,
  shapeSecret,
  type QuestionReply
} from '../requests/answers'
import { useSel, useStoreApi } from '../state/context'
import { Button, ErrorText, Field, Muted, Screen, Spinner } from '../ui/components'
import { colors, font, radius, space } from '../ui/theme'
import { QuestionForm } from './QuestionForm'

type Props = NativeStackScreenProps<RootStackParamList, 'Requests'>

// A stable default: a selector must not answer a new array every render.
const NO_SESSIONS: readonly Session[] = []

export function RequestsScreen({ route }: Props): ReactNode {
  const { machineId, requestId } = route.params
  const store = useStoreApi()
  const requests = useSel((s) => s.requests[machineId])
  const sessions = useSel((s) => s.sessions[machineId]) ?? NO_SESSIONS
  const [notices, setNotices] = useState<Record<string, string>>({})

  useEffect(() => {
    void store.getState().loadRequests(machineId)
    if (!store.getState().sessions[machineId]) void store.getState().loadSessions(machineId)
  }, [store, machineId])

  const resolve = async (request: PendingRequest, response: RequestResponse): Promise<void> => {
    try {
      const outcome = await store.getState().resolveRequest(machineId, request.id, response)
      if (!outcome.accepted)
        setNotices((n) => ({
          ...n,
          [request.id]: 'Answered elsewhere first: this request is settled.'
        }))
    } catch (error) {
      setNotices((n) => ({
        ...n,
        [request.id]: error instanceof Error ? error.message : String(error)
      }))
    }
  }

  const pending = [...(requests?.snapshot?.pending ?? [])]
    .filter((request) => !requestId || request.id === requestId)
    .sort((a, b) => a.createdAt - b.createdAt)

  return (
    <Screen>
      <FlatList
        data={pending}
        keyExtractor={(r) => r.id}
        refreshControl={
          <RefreshControl
            refreshing={requests?.loading ?? false}
            onRefresh={() => void store.getState().loadRequests(machineId)}
            tintColor={colors.textSecondary}
          />
        }
        contentContainerStyle={{ padding: space.lg, gap: space.md }}
        renderItem={({ item }) => (
          <RequestCard
            request={item}
            sessionTitle={sessions.find((s) => s.id === item.sessionId)?.title}
            notice={notices[item.id]}
            onResolve={(response) => void resolve(item, response)}
          />
        )}
        ListHeaderComponent={
          <View>
            {Object.entries(notices).map(([id, text]) => (
              <Text key={id} style={styles.notice} testID="request-notice">
                {text}
              </Text>
            ))}
            {requests?.error ? (
              <ErrorText>{requests.error}</ErrorText>
            ) : requests?.unavailable ? (
              <Muted testID="requests-unavailable">
                This server keeps no request list. Answer the agent&apos;s questions in its chat.
              </Muted>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          !requests || (requests.loading && !requests.snapshot) ? (
            <Spinner />
          ) : requests.unavailable ? undefined : (
            <Muted testID="requests-empty">
              {requestId
                ? 'This request is already settled or no longer available.'
                : 'Nothing is waiting for you.'}
            </Muted>
          )
        }
      />
    </Screen>
  )
}

function RequestCard({
  request,
  sessionTitle,
  notice,
  onResolve
}: {
  request: PendingRequest
  sessionTitle: string | undefined
  notice: string | undefined
  onResolve: (response: RequestResponse) => void
}): ReactNode {
  const [replies, setReplies] = useState<Record<string, QuestionReply>>({})
  const [secret, setSecret] = useState('')
  /** The secret is masked as typed; a person may reveal it to check it. */
  const [secretShown, setSecretShown] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const kind =
    request.kind === 'secret' ? 'Secret' : request.kind === 'permission' ? 'Permission' : 'Question'

  const submit = (shaped: ReturnType<typeof shapePermission>): void => {
    if (!shaped.ok) return setProblem(shaped.problem)
    setProblem(null)
    onResolve(shaped.response)
    setSecret('')
  }

  return (
    <View style={styles.card} testID={`request-${request.kind}`}>
      <Text style={styles.kicker}>
        {kind}
        {sessionTitle ? ` · ${sessionTitle}` : ''}
        {request.toolName ? ` · ${request.toolName}` : ''}
      </Text>
      <Text style={styles.title}>{request.description}</Text>
      {request.detail ? <Text style={styles.detail}>{request.detail}</Text> : undefined}
      {notice ? (
        <Text style={styles.notice} testID="request-notice">
          {notice}
        </Text>
      ) : null}

      {request.kind === 'secret' ? (
        <View style={{ gap: space.sm }}>
          {request.action ? (
            <Text style={styles.detail}>
              {request.action.type === 'run'
                ? `Used as ${request.action.envVar} by: ${request.action.command}`
                : `Written to ${request.action.file} as ${request.action.key}`}
            </Text>
          ) : null}
          <Field
            label="The secret"
            value={secret}
            onChangeText={setSecret}
            secureTextEntry={!secretShown}
            autoComplete="off"
            textContentType="none"
            testID="secret-input"
            placeholder="Stays on the phone until you send it"
          />
          <View style={styles.options}>
            <Button
              title={secretShown ? 'Hide' : 'Show'}
              kind="secondary"
              onPress={() => setSecretShown(!secretShown)}
              testID="secret-toggle"
            />
          </View>
          <View style={styles.options}>
            <Button
              title="Send the secret"
              onPress={() => submit(shapeSecret(secret))}
              testID="secret-send"
            />
            <Button
              title="Dismiss"
              kind="secondary"
              onPress={() => onResolve(dismissal)}
              testID="request-dismiss"
            />
          </View>
        </View>
      ) : (
        <View style={{ gap: space.sm }}>
          {request.questions?.length ? (
            <QuestionForm
              questions={request.questions}
              replies={replies}
              onChange={(key, reply) => setReplies({ ...replies, [key]: reply })}
              secretKeys={request.secretQuestions ?? []}
              testID="request-questions"
            />
          ) : null}
          {problem ? <Text style={styles.problem}>{problem}</Text> : null}
          <View style={styles.options}>
            {answersAsPermission(request) ? (
              (request.options ?? []).map((option) => (
                <Button
                  key={option.id}
                  title={option.label}
                  kind={option.id === 'deny' ? 'secondary' : 'primary'}
                  onPress={() => submit(shapePermission(request, option.id, replies))}
                  testID={`request-option-${option.id}`}
                />
              ))
            ) : (
              <Button
                title="Answer"
                onPress={() => submit(shapeClarification(request, replies))}
                testID="request-answer"
              />
            )}
            <Button
              title="Dismiss"
              kind="secondary"
              onPress={() => onResolve(dismissal)}
              testID="request-dismiss"
            />
          </View>
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: space.md,
    gap: space.sm,
    backgroundColor: colors.surface50
  },
  kicker: {
    color: colors.warning,
    fontSize: font.xs,
    fontWeight: '600',
    textTransform: 'uppercase'
  },
  title: { color: colors.textPrimary, fontSize: font.md },
  detail: { color: colors.textSecondary, fontSize: font.sm },
  notice: { color: colors.warning, fontSize: font.sm },
  problem: { color: colors.destructive, fontSize: font.sm },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }
})
