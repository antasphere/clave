/**
 * The pending requests of a machine (decision 8 of the spec): the server
 * owns them and their first-valid-answer rule; the phone lists them,
 * refreshes on `requests.changed`, renders each kind as the desktop's prompt
 * dock card and resolves it through the server's own route. A resolution
 * the server refuses (another client answered first) is shown and the
 * request goes. A secret is entered here and travels in the resolve body
 * only.
 */
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useEffect, useState, type ReactNode } from 'react'
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
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
import { PaneHeader } from '../ui/PaneHeader'
import {
  EmptyState,
  Field,
  IconButton,
  Loading,
  Notice,
  PromptButton,
  Screen
} from '../ui/components'
import { codeSize, gutter, radius, space, text, type, useTheme } from '../ui/theme'
import { QuestionForm } from './QuestionForm'
import { isRefusalOption } from '../chat/approvals'

type Props = NativeStackScreenProps<RootStackParamList, 'Requests'>

// A stable default: a selector must not answer a new array every render.
const NO_SESSIONS: readonly Session[] = []

export function RequestsScreen({ route, navigation }: Props): ReactNode {
  const { machineId, requestId } = route.params
  const t = useTheme()
  const insets = useSafeAreaInsets()
  const store = useStoreApi()
  const machine = useSel((s) => s.machines.find((m) => m.id === machineId))
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
      <PaneHeader title="Requests" meta={machine?.name} onBack={() => navigation.goBack()} />
      <ScrollView
        contentContainerStyle={{
          paddingTop: space(4),
          paddingBottom: insets.bottom + space(6),
          gap: space(3)
        }}
        refreshControl={
          <RefreshControl
            refreshing={requests?.loading ?? false}
            onRefresh={() => void store.getState().loadRequests(machineId)}
            tintColor={t.colors.textSecondary}
            colors={[t.colors.textSecondary]}
            progressBackgroundColor={t.colors.surface100}
          />
        }
        keyboardShouldPersistTaps="handled"
      >
        {Object.entries(notices)
          .filter(([id]) => !pending.some((r) => r.id === id))
          .map(([id, body]) => (
            <Notice key={id} testID="request-notice">
              {body}
            </Notice>
          ))}
        {requests?.error ? (
          <Notice tone="error">{requests.error}</Notice>
        ) : requests?.unavailable ? (
          <Notice testID="requests-unavailable">
            This server keeps no request list. Answer the agent&apos;s questions in its chat.
          </Notice>
        ) : null}
        {pending.map((item) => (
          <RequestCard
            key={item.id}
            request={item}
            sessionTitle={sessions.find((s) => s.id === item.sessionId)?.title}
            notice={notices[item.id]}
            onResolve={(response) => void resolve(item, response)}
          />
        ))}
        {!pending.length ? (
          !requests || (requests.loading && !requests.snapshot) ? (
            <Loading />
          ) : requests.unavailable ? null : (
            <EmptyState
              icon="inbox-stack"
              title={requestId ? 'Already settled' : 'Nothing is waiting for you'}
              text={
                requestId
                  ? 'This request is already settled or no longer available.'
                  : 'A tool to allow or a question to answer lands here.'
              }
              testID="requests-empty"
            />
          )
        ) : null}
      </ScrollView>
    </Screen>
  )
}

/** `.chat-prompt`: the raised card of the desktop's prompt dock. */
export function PromptCard({
  children,
  kicker,
  testID
}: {
  children: ReactNode
  kicker?: string
  testID?: string
}): ReactNode {
  const t = useTheme()
  return (
    <View
      style={[
        styles.card,
        t.raised,
        { borderColor: t.colors.borderSubtle, backgroundColor: t.colors.surfaceRaised }
      ]}
      testID={testID}
    >
      {kicker ? (
        <Text style={[type(text.xs), { color: t.colors.textTertiary }]}>{kicker}</Text>
      ) : null}
      {children}
    </View>
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
  const t = useTheme()
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
  const options = request.options ?? []
  const denies = options.filter(isRefusalOption)
  const allows = options.filter((o) => !isRefusalOption(o))

  return (
    <PromptCard
      kicker={[kind, sessionTitle, request.toolName].filter(Boolean).join(' · ')}
      testID={`request-${request.kind}`}
    >
      <Text style={[type(text.control, 500, 1.5), { color: t.colors.textPrimary }]}>
        {request.description}
      </Text>
      {request.detail ? (
        <Text style={[type(text.control, 400, 1.5), { color: t.colors.textSecondary }]}>
          {request.detail}
        </Text>
      ) : null}
      {notice ? (
        <Text
          style={[type(text.xs, 400, 1.5), { color: t.colors.warning }]}
          testID="request-notice"
        >
          {notice}
        </Text>
      ) : null}

      {request.kind === 'secret' ? (
        <View style={{ gap: space(3) }}>
          {request.action ? (
            <View
              style={[
                styles.code,
                { backgroundColor: t.colors.surface50, borderColor: t.colors.borderSubtle }
              ]}
            >
              <Text style={[type(codeSize, 400, 1.5), { color: t.colors.textSecondary }]}>
                {request.action.type === 'run'
                  ? `Used as ${request.action.envVar} by: ${request.action.command}`
                  : `Written to ${request.action.file} as ${request.action.key}`}
              </Text>
            </View>
          ) : null}
          <View style={styles.secretRow}>
            <View style={{ flex: 1 }}>
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
            </View>
            <IconButton
              name={secretShown ? 'eye-slash' : 'eye'}
              label={secretShown ? 'Hide the secret' : 'Show the secret'}
              onPress={() => setSecretShown(!secretShown)}
              testID="secret-toggle"
            />
          </View>
          <View style={styles.actions}>
            <PromptButton
              title="Dismiss"
              onPress={() => onResolve(dismissal)}
              testID="request-dismiss"
            />
            <View style={{ flex: 1 }} />
            <PromptButton
              title="Send the secret"
              primary
              onPress={() => submit(shapeSecret(secret))}
              testID="secret-send"
            />
          </View>
        </View>
      ) : (
        <View style={{ gap: space(3) }}>
          {request.questions?.length ? (
            <QuestionForm
              questions={request.questions}
              replies={replies}
              onChange={(key, reply) => setReplies({ ...replies, [key]: reply })}
              secretKeys={request.secretQuestions ?? []}
              testID="request-questions"
            />
          ) : null}
          {problem ? (
            <Text style={[type(text.xs, 400, 1.5), { color: t.colors.destructive }]}>
              {problem}
            </Text>
          ) : null}
          <View style={styles.actions}>
            {answersAsPermission(request)
              ? denies.map((option) => (
                  <PromptButton
                    key={option.id}
                    title={option.label}
                    onPress={() => submit(shapePermission(request, option.id, replies))}
                    testID={`request-option-${option.id}`}
                  />
                ))
              : null}
            <PromptButton
              title="Dismiss"
              onPress={() => onResolve(dismissal)}
              testID="request-dismiss"
            />
            <View style={{ flex: 1 }} />
            {answersAsPermission(request) ? (
              [...allows.slice(1).reverse(), ...allows.slice(0, 1)].map((option) => (
                <PromptButton
                  key={option.id}
                  title={option.label}
                  primary={option === allows[0]}
                  onPress={() => submit(shapePermission(request, option.id, replies))}
                  testID={`request-option-${option.id}`}
                />
              ))
            ) : (
              <PromptButton
                title="Answer"
                primary
                onPress={() => submit(shapeClarification(request, replies))}
                testID="request-answer"
              />
            )}
          </View>
        </View>
      )}
    </PromptCard>
  )
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: gutter,
    padding: 12,
    paddingHorizontal: 14,
    gap: space(2),
    borderWidth: 1,
    borderRadius: radius.xxl
  },
  code: { padding: 8, paddingHorizontal: 10, borderRadius: radius.md, borderWidth: 1 },
  secretRow: { flexDirection: 'row', alignItems: 'flex-end', gap: space(2) },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 }
})
