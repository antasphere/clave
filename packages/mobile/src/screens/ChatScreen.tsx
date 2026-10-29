/**
 * One conversation: the history paged newest first and the stream by
 * subscription, reduced by the ported reducer; the tool activity as
 * collapsed rows; the agent's permission cards answered through the write
 * route; a document the agent presented for review shown as a card with
 * the file read from the server; a composer whose draft is kept per
 * session on the device.
 */
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { Entry } from '../chat/reducer'
import { hasMore } from '../chat/history'
import type { RootStackParamList } from '../navigation/RootNavigator'
import { shapeAnswers, type QuestionReply } from '../requests/answers'
import { useSel, useServices, useStoreApi } from '../state/context'
import { conversationKey } from '../state/store'
import { REACHABILITY_LABEL, SESSION_STATE_LABEL, phoneSessionState } from '../state/session-state'
import { Button, ErrorText, Muted, Pill, Screen, Spinner } from '../ui/components'
import { colors, font, radius, space } from '../ui/theme'
import { QuestionForm } from './QuestionForm'

type Props = NativeStackScreenProps<RootStackParamList, 'Chat'>

const SIDE_PANEL_TOOL = 'clave_open_side_panel'
const isDocumentTool = (name: string | undefined): boolean =>
  typeof name === 'string' && name.endsWith(SIDE_PANEL_TOOL)
const shortName = (name: string | undefined): string =>
  (name ?? 'tool').replace(/^mcp__[^_]+__/, '').replace(/^mcp__/, '')
const excerpt = (value: unknown, max = 1_500): string => {
  const text = typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? '')
  return text.length > max ? `${text.slice(0, max)}…` : text
}
const dirname = (path: string): string => path.replace(/\/[^/]*$/, '') || '/'

export function ChatScreen({ navigation, route }: Props): ReactNode {
  const { machineId, sessionId } = route.params
  const store = useStoreApi()
  const services = useServices()
  const key = conversationKey(machineId, sessionId)
  const state = useSel((s) => s.conversations[key])
  const session = useSel((s) => s.sessions[machineId]?.find((x) => x.id === sessionId))
  const reach = useSel((s) => s.reachability[machineId] ?? 'connecting')
  const fatal = useSel((s) => s.fatal[key])
  const [draft, setDraft] = useState('')
  const [draftLoaded, setDraftLoaded] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  /** A send whose outcome nobody can tell: kept until the person decides. */
  const [delivery, setDelivery] = useState<{ clientMessageId: string; reason: string } | null>(null)
  const [sending, setSending] = useState(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let release: (() => void) | null = null
    let gone = false
    void store
      .getState()
      .openChat(machineId, sessionId)
      .then((off) => {
        if (gone) off()
        else release = off
      })
    if (!store.getState().sessions[machineId]) void store.getState().loadSessions(machineId)
    return () => {
      gone = true
      release?.()
    }
  }, [store, machineId, sessionId])

  useEffect(() => {
    void services.drafts.get(machineId, sessionId).then((text) => {
      setDraft(text)
      setDraftLoaded(true)
    })
  }, [services, machineId, sessionId])

  const changeDraft = (text: string): void => {
    setDraft(text)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => void services.drafts.set(machineId, sessionId, text), 300)
  }

  useEffect(() => {
    if (session?.title) navigation.setOptions({ title: session.title })
  }, [navigation, session?.title])

  const conversation = state?.conversation
  const phoneState = conversation
    ? phoneSessionState(conversation.state, fatal)
    : session
      ? phoneSessionState(session.state, fatal)
      : null

  const entries = useMemo(() => {
    const list = conversation?.entries ?? []
    const first = conversation?.first ?? 0
    return list
      .map((entry, index) => ({ entry, id: first + index }))
      .filter(({ entry }) => !(entry.kind === 'user' && entry.withdrawn))
      .reverse()
  }, [conversation])

  const send = async (): Promise<void> => {
    if (!draft.trim() || sending) return
    setSending(true)
    setSendError(null)
    const outcome = await store.getState().send(machineId, sessionId, draft)
    setSending(false)
    switch (outcome.kind) {
      case 'sent':
        if (saveTimer.current) clearTimeout(saveTimer.current)
        setDraft('')
        setDelivery(null)
        return
      case 'rejected':
      case 'failed':
        // The draft stays; a new attempt mints a new id.
        setDelivery(null)
        setSendError(outcome.reason)
        return
      case 'unknown':
        // Nothing goes out by itself: the person chooses.
        setDelivery({ clientMessageId: outcome.clientMessageId, reason: outcome.reason })
        return
    }
  }

  const discard = async (): Promise<void> => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    await services.drafts.clear(machineId, sessionId)
    setDraft('')
    setDelivery(null)
    setSendError(null)
  }

  const answer = useCallback(
    async (
      requestId: string,
      optionId: string,
      answers?: Record<string, string>
    ): Promise<void> => {
      const outcome = await store
        .getState()
        .answerInChat(machineId, sessionId, requestId, optionId, answers)
      if (!outcome.ok) setSendError(outcome.error ?? 'The answer was not sent.')
    },
    [store, machineId, sessionId]
  )

  const insets = useSafeAreaInsets()
  const loadingOlder = state?.cursor.loading ?? false

  return (
    <Screen>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top + 44 : 0}
      >
        <View style={styles.status}>
          {phoneState ? (
            <Pill
              text={SESSION_STATE_LABEL[phoneState]}
              tone={
                phoneState === 'working'
                  ? 'accent'
                  : phoneState === 'waiting'
                    ? 'warning'
                    : phoneState === 'error'
                      ? 'danger'
                      : 'neutral'
              }
              testID="chat-state"
            />
          ) : null}
          <Pill
            text={REACHABILITY_LABEL[reach]}
            tone={reach === 'reachable' ? 'success' : reach === 'connecting' ? 'neutral' : 'danger'}
            testID="chat-reachability"
          />
          <View style={{ flex: 1 }} />
          {phoneState === 'working' ? (
            <Button
              title="Stop"
              kind="secondary"
              onPress={() => void store.getState().interrupt(machineId, sessionId)}
              testID="chat-stop"
            />
          ) : null}
        </View>
        {state?.error ? <ErrorText testID="chat-error">{state.error}</ErrorText> : null}
        <FlatList
          inverted
          data={entries}
          keyExtractor={(item) => String(item.id)}
          renderItem={({ item }) => (
            <EntryRow entry={item.entry} machineId={machineId} onAnswer={answer} />
          )}
          onEndReachedThreshold={0.6}
          onEndReached={() => {
            if (state && hasMore(state.cursor))
              void store.getState().loadOlder(machineId, sessionId)
          }}
          ListFooterComponent={loadingOlder ? <Spinner /> : undefined}
          ListEmptyComponent={
            !state || !state.cursor.loaded ? (
              <Spinner />
            ) : (
              <Muted testID="chat-empty">Nothing in this conversation yet.</Muted>
            )
          }
          contentContainerStyle={styles.list}
          testID="chat-transcript"
        />
        {sendError ? <ErrorText testID="send-error">{sendError}</ErrorText> : undefined}
        {delivery ? (
          <View style={styles.delivery} testID="delivery-unknown">
            <Text style={styles.deliveryText}>Delivery unknown. {delivery.reason}</Text>
            <View style={styles.options}>
              <Button
                title="Send again (may duplicate)"
                kind="secondary"
                onPress={() => void send()}
                testID="delivery-send-again"
              />
              <Button
                title="Discard"
                kind="secondary"
                onPress={() => void discard()}
                testID="delivery-discard"
              />
            </View>
          </View>
        ) : undefined}
        {sending ? <Muted testID="sending">Sending…</Muted> : undefined}
        <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, space.sm) }]}>
          <TextInput
            style={styles.input}
            multiline
            value={draft}
            onChangeText={changeDraft}
            editable={draftLoaded}
            placeholder="Message the agent"
            placeholderTextColor={colors.textTertiary}
            testID="composer-input"
            accessibilityLabel="Message"
          />
          <Button
            title="Send"
            onPress={() => void send()}
            disabled={!draft.trim() || sending}
            testID="composer-send"
          />
        </View>
      </KeyboardAvoidingView>
    </Screen>
  )
}

function EntryRow({
  entry,
  machineId,
  onAnswer
}: {
  entry: Entry
  machineId: string
  onAnswer: (requestId: string, optionId: string, answers?: Record<string, string>) => Promise<void>
}): ReactNode {
  switch (entry.kind) {
    case 'user':
      return (
        <View
          style={[styles.bubble, styles.user, entry.interrupted && styles.dim]}
          testID="entry-user"
        >
          <Text style={styles.userText}>{entry.text}</Text>
          {entry.attachments?.length ? (
            <Text style={styles.meta}>{entry.attachments.map((a) => a.name).join(', ')}</Text>
          ) : null}
          {entry.interrupted ? <Text style={styles.meta}>Stopped</Text> : null}
        </View>
      )
    case 'assistant':
      return entry.text.trim() ? (
        <View style={[styles.bubble, styles.assistant]} testID="entry-assistant">
          <Text style={styles.assistantText}>{entry.text}</Text>
        </View>
      ) : null
    case 'tool':
      return isDocumentTool(entry.name) ? (
        <DocumentCard entry={entry} machineId={machineId} />
      ) : (
        <ToolRow entry={entry} />
      )
    case 'permission':
      return <PermissionCard entry={entry} onAnswer={onAnswer} />
    case 'error':
      return (
        <View style={[styles.bubble, styles.errorBubble]} testID="entry-error">
          <Text style={{ color: colors.destructive, fontSize: font.sm }}>{entry.message}</Text>
        </View>
      )
  }
}

function ToolRow({ entry }: { entry: Extract<Entry, { kind: 'tool' }> }): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <Pressable onPress={() => setOpen(!open)} style={styles.tool} testID="entry-tool">
      <Text style={[styles.toolTitle, entry.failed && { color: colors.destructive }]}>
        {open ? '▾' : '▸'} {shortName(entry.name)}
        {!entry.complete ? ' · running' : entry.failed ? ' · failed' : ''}
      </Text>
      {open ? (
        <View style={{ gap: space.xs }}>
          {entry.input !== undefined ? (
            <Text style={styles.code}>{excerpt(entry.input)}</Text>
          ) : null}
          {entry.output !== undefined ? (
            <Text style={styles.code}>{excerpt(entry.output)}</Text>
          ) : null}
        </View>
      ) : null}
    </Pressable>
  )
}

/** The agent presented a document for review (`clave_open_side_panel`):
 *  the file is read from the server; editing is done on the Mac. */
function DocumentCard({
  entry,
  machineId
}: {
  entry: Extract<Entry, { kind: 'tool' }>
  machineId: string
}): ReactNode {
  const store = useStoreApi()
  const input = (entry.input ?? {}) as {
    path?: unknown
    title?: unknown
    email?: { subject?: unknown; to?: unknown }
  }
  const path = typeof input.path === 'string' ? input.path : null
  const title =
    typeof input.title === 'string'
      ? input.title
      : path
        ? (path.split('/').pop() ?? path)
        : 'A document'
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open || text !== null || !path) return
    store
      .getState()
      .readFile(machineId, dirname(path), path)
      .then((file) =>
        setText(file.binary ? 'This file is binary.' : file.content + (file.truncated ? '\n…' : ''))
      )
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [open, text, path, machineId, store])
  const email = input.email
  return (
    <Pressable onPress={() => setOpen(!open)} style={styles.document} testID="entry-document">
      <Text style={styles.documentKicker}>Document for review</Text>
      <Text style={styles.documentTitle}>{title}</Text>
      {email ? (
        <Text style={styles.meta}>
          Email{typeof email.subject === 'string' ? `: ${email.subject}` : ''}
        </Text>
      ) : null}
      {path ? <Text style={styles.meta}>{path}</Text> : null}
      <Text style={styles.meta}>Editing is done on the Mac.</Text>
      {open && path ? (
        error ? (
          <Text style={{ color: colors.destructive, fontSize: font.sm }}>{error}</Text>
        ) : text === null ? (
          <Spinner />
        ) : (
          <Text style={styles.code} testID="document-text">
            {excerpt(text, 6_000)}
          </Text>
        )
      ) : null}
    </Pressable>
  )
}

function PermissionCard({
  entry,
  onAnswer
}: {
  entry: Extract<Entry, { kind: 'permission' }>
  onAnswer: (requestId: string, optionId: string, answers?: Record<string, string>) => Promise<void>
}): ReactNode {
  const { request } = entry
  const [replies, setReplies] = useState<Record<string, QuestionReply>>({})
  const [problem, setProblem] = useState<string | null>(null)
  const settled = entry.answer !== undefined || entry.answeredElsewhere
  const choose = (optionId: string): void => {
    setProblem(null)
    if (request.questions?.length && optionId === 'answer') {
      const shaped = shapeAnswers(request.questions, replies)
      if (!shaped.ok) return setProblem(shaped.problem)
      void onAnswer(request.id, optionId, shaped.answers)
      return
    }
    void onAnswer(request.id, optionId)
  }
  return (
    <View style={styles.card} testID="entry-permission">
      <Text style={styles.cardKicker}>
        {request.toolName ? `${request.toolName} asks` : 'The agent asks'}
      </Text>
      <Text style={styles.cardTitle}>{request.description}</Text>
      {request.detail ? <Text style={styles.code}>{excerpt(request.detail, 600)}</Text> : null}
      {settled ? (
        <Text style={styles.meta} testID="permission-settled">
          {entry.answer
            ? `Answered: ${request.options.find((o) => o.id === entry.answer)?.label ?? entry.answer}`
            : 'Answered elsewhere'}
        </Text>
      ) : (
        <View style={{ gap: space.sm }}>
          {request.questions?.length ? (
            <QuestionForm
              questions={request.questions}
              replies={replies}
              onChange={(k, reply) => setReplies({ ...replies, [k]: reply })}
            />
          ) : null}
          {problem ? (
            <Text style={{ color: colors.destructive, fontSize: font.sm }}>{problem}</Text>
          ) : null}
          <View style={styles.options}>
            {request.options.map((option) => (
              <Button
                key={option.id}
                title={option.label}
                kind={option.id === 'deny' ? 'secondary' : 'primary'}
                onPress={() => choose(option.id)}
                testID={`permission-option-${option.id}`}
              />
            ))}
          </View>
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  status: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm
  },
  list: { paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.sm },
  bubble: {
    borderRadius: radius.lg,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    maxWidth: '92%'
  },
  user: { alignSelf: 'flex-end', backgroundColor: colors.surface300 },
  assistant: { alignSelf: 'flex-start', backgroundColor: colors.surface100 },
  errorBubble: {
    alignSelf: 'stretch',
    backgroundColor: colors.surface100,
    borderWidth: 1,
    borderColor: colors.destructive
  },
  userText: { color: colors.textPrimary, fontSize: font.md },
  assistantText: { color: colors.textPrimary, fontSize: font.md, lineHeight: 22 },
  meta: { color: colors.textTertiary, fontSize: font.xs, marginTop: 2 },
  dim: { opacity: 0.6 },
  tool: { paddingHorizontal: space.sm, paddingVertical: space.xs, gap: space.xs },
  toolTitle: { color: colors.textSecondary, fontSize: font.sm },
  code: {
    color: colors.textSecondary,
    fontSize: font.xs,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    backgroundColor: colors.surface50,
    borderRadius: radius.sm,
    padding: space.sm
  },
  card: {
    borderWidth: 1,
    borderColor: colors.warning,
    borderRadius: radius.lg,
    padding: space.md,
    gap: space.sm,
    backgroundColor: colors.surface50
  },
  cardKicker: {
    color: colors.warning,
    fontSize: font.xs,
    fontWeight: '600',
    textTransform: 'uppercase'
  },
  cardTitle: { color: colors.textPrimary, fontSize: font.md },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  document: {
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: radius.lg,
    padding: space.md,
    gap: space.xs,
    backgroundColor: colors.surface50
  },
  documentKicker: {
    color: colors.accent,
    fontSize: font.xs,
    fontWeight: '600',
    textTransform: 'uppercase'
  },
  documentTitle: { color: colors.textPrimary, fontSize: font.md },
  delivery: {
    marginHorizontal: space.lg,
    marginBottom: space.sm,
    padding: space.md,
    gap: space.sm,
    borderWidth: 1,
    borderColor: colors.warning,
    borderRadius: radius.md,
    backgroundColor: colors.surface50
  },
  deliveryText: { color: colors.textPrimary, fontSize: font.sm },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.surface50
  },
  input: {
    flex: 1,
    color: colors.textPrimary,
    backgroundColor: colors.surface100,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    fontSize: font.md,
    maxHeight: 140
  }
})
