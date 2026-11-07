/**
 * One conversation, in the desktop chat view's shapes (`ChatView.tsx` in
 * `plugins/chat-view`): the history paged newest first and the stream by
 * subscription, reduced by the ported reducer; the transcript a reading
 * column where the person's turns are the one boxed thing and the agent
 * writes straight on the ground; tool runs as muted rows; the approvals the
 * reader allowed folded into one; the prompt dock above the composer for
 * what the agent waits on; the composer one raised box with the round Send
 * that turns into Stop; a document the agent presented for review as a row
 * that opens to the file read from the server. The draft is kept per
 * session on the device.
 */
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Alert, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { Entry, Permission } from '../chat/reducer'
import { parseDelivery } from '../chat/delivery'
import { blockKey, groupEntries, visibleEntries, type Block, type ToolEntry } from '../chat/tools'
import type { Attachment } from '../contract/types'
import { attachmentDraftKey } from '../attachments/drafts'
import { discardUnknownSend } from '../reconnect/pass'
import { hasMore } from '../chat/history'
import type { RootStackParamList } from '../navigation/RootNavigator'
import { useSel, useServices, useStoreApi } from '../state/context'
import { conversationKey } from '../state/store'
import { REACHABILITY_LABEL, SESSION_STATE_LABEL, phoneSessionState } from '../state/session-state'
import { Icon } from '../ui/Icon'
import { PaneHeader } from '../ui/PaneHeader'
import {
  Callout,
  EmptyState,
  IconButton,
  Loading,
  Notice,
  PromptButton,
  Screen,
  Spinner,
  StatusText
} from '../ui/components'
import {
  chatGlyph,
  codeSize,
  control,
  controlSm,
  radius,
  space,
  text,
  type,
  useTheme,
  withAlpha
} from '../ui/theme'
import { dotOf, reachStatus, stateInk } from '../ui/status'
import { Attachments } from './chat/Attachments'
import { CodeBlock, Markdown } from './chat/Markdown'
import { ApprovalRun, PermissionRow, PromptDock } from './chat/PromptDock'
import { ProviderMark } from './chat/ProviderMark'
import { ToolGroup } from './chat/ToolRows'

type Props = NativeStackScreenProps<RootStackParamList, 'Chat'>

const SIDE_PANEL_TOOL = 'clave_open_side_panel'
const isDocumentTool = (name: string | undefined): boolean =>
  typeof name === 'string' && name.endsWith(SIDE_PANEL_TOOL)
const excerpt = (value: unknown, max = 6_000): string => {
  const text = typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? '')
  return text.length > max ? `${text.slice(0, max)}…` : text
}
const dirname = (path: string): string => path.replace(/\/[^/]*$/, '') || '/'
const AGENT_NAMES: Record<string, string> = { claude: 'Claude', codex: 'Codex', pi: 'Pi' }

/** A document the agent presented stands on its own row, out of the run of
 *  tools around it, so the desktop's grouping holds for everything else. */
type Row = { key: string; block: Block | { kind: 'document'; tool: ToolEntry } }
function rowsOf(entries: Entry[], first: number): Row[] {
  const ordinal = (entry: Entry): number | undefined => {
    const index = entries.indexOf(entry)
    return index < 0 ? undefined : first + index
  }
  const rows: Row[] = []
  for (const block of groupEntries(visibleEntries(entries))) {
    if (block.kind !== 'tool-group' || !block.tools.some((tool) => isDocumentTool(tool.name))) {
      rows.push({ key: blockKey(block, ordinal), block })
      continue
    }
    let run: ToolEntry[] = []
    const flush = (): void => {
      if (run.length)
        rows.push({
          key: `tools-${run[0]!.id}`,
          block: { kind: 'tool-group', id: run[0]!.id, tools: run }
        })
      run = []
    }
    for (const tool of block.tools) {
      if (isDocumentTool(tool.name)) {
        flush()
        rows.push({ key: `document-${tool.id}`, block: { kind: 'document', tool } })
      } else run.push(tool)
    }
    flush()
  }
  return rows
}

/** The requests the agent still waits on, oldest first. */
const openRequests = (entries: Entry[]): Permission[] =>
  entries.flatMap((entry) =>
    entry.kind === 'permission' && entry.answer === undefined && !entry.answeredElsewhere
      ? [entry.request]
      : []
  )

export function ChatScreen({ navigation, route }: Props): ReactNode {
  const { machineId, sessionId } = route.params
  const t = useTheme()
  const insets = useSafeAreaInsets()
  const store = useStoreApi()
  const services = useServices()
  const key = conversationKey(machineId, sessionId)
  const state = useSel((s) => s.conversations[key])
  const session = useSel((s) => s.sessions[machineId]?.find((x) => x.id === sessionId))
  const reach = useSel((s) => s.reachability[machineId] ?? 'connecting')
  const fatal = useSel((s) => s.fatal[key])
  const [draft, setDraft] = useState('')
  const [draftLoaded, setDraftLoaded] = useState(false)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [attaching, setAttaching] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  /** A send whose outcome nobody can tell: kept until the person decides. */
  const [delivery, setDelivery] = useState<{ clientMessageId: string; reason: string } | null>(null)
  const [sending, setSending] = useState(false)
  const [pendingAnswers, setPendingAnswers] = useState<string[]>([])
  const latestDraft = useRef('')

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
    let cancelled = false
    const load = async (): Promise<void> => {
      const before = latestDraft.current
      const [text, mark, files] = await Promise.all([
        services.drafts.get(machineId, sessionId),
        services.delivery?.marks.get(machineId, sessionId),
        services.kv.getItem(attachmentDraftKey(machineId, sessionId))
      ])
      if (cancelled) return
      if (latestDraft.current === before) {
        latestDraft.current = text
        setDraft(text)
      }
      setDraftLoaded(true)
      setDelivery(
        mark?.kind === 'unknown'
          ? { clientMessageId: mark.clientMessageId, reason: mark.reason }
          : null
      )
      if (mark?.kind === 'rejected') setSendError(mark.reason)
      try {
        if (files) setAttachments(JSON.parse(files) as Attachment[])
      } catch {
        setAttachments([])
      }
    }
    void load()
    const off = services.delivery?.marks.subscribe(() => {
      void load()
    })
    return () => {
      cancelled = true
      off?.()
    }
  }, [services, machineId, sessionId])

  const changeDraft = (text: string): void => {
    latestDraft.current = text
    setDraft(text)
    void services.drafts.set(machineId, sessionId, text)
  }

  const conversation = state?.conversation
  const phoneState = conversation
    ? phoneSessionState(conversation.state, fatal)
    : session
      ? phoneSessionState(session.state, fatal)
      : null
  const ended = conversation?.state === 'ended'
  const working = phoneState === 'working'

  const rows = useMemo(() => {
    const list = conversation?.entries ?? []
    const first = conversation?.first ?? 0
    return rowsOf(list, first).reverse()
  }, [conversation])
  const waitingOn = useMemo(() => openRequests(conversation?.entries ?? []), [conversation])

  const send = async (): Promise<void> => {
    if ((!draft.trim() && !attachments.length) || sending || attaching) return
    setSending(true)
    setSendError(null)
    if (delivery && services.delivery)
      await discardUnknownSend(
        { machineId, sessionId, clientMessageId: delivery.clientMessageId },
        services.delivery
      )
    const outcome = await store.getState().send(machineId, sessionId, draft, undefined, attachments)
    setSending(false)
    switch (outcome.kind) {
      case 'sent':
        setAttachments([])
        await services.kv.removeItem(attachmentDraftKey(machineId, sessionId))
        if (latestDraft.current === draft) {
          latestDraft.current = ''
          setDraft('')
        }
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
    if (delivery && services.delivery)
      await discardUnknownSend(
        { machineId, sessionId, clientMessageId: delivery.clientMessageId },
        services.delivery
      )
    setAttachments([])
    await services.kv.removeItem(attachmentDraftKey(machineId, sessionId))
    latestDraft.current = ''
    await services.drafts.clear(machineId, sessionId)
    setDraft('')
    setDelivery(null)
    setSendError(null)
  }

  const attach = async (kind: 'photos' | 'camera' | 'files'): Promise<void> => {
    if (!services.beta || attaching || sending) return
    setAttaching(true)
    setSendError(null)
    try {
      const { client } = await store.getState().connect(machineId)
      const capabilities = await client.sessions.capabilities(sessionId)
      const results = await services.beta.attach(
        kind,
        machineId,
        sessionId,
        attachments,
        capabilities.images
      )
      const added = results.flatMap((result) => (result.ok ? [result.record] : []))
      const notes = results.flatMap((result) =>
        result.ok ? (result.note ? [result.note] : []) : [result.reason]
      )
      const next = [...attachments, ...added]
      await services.kv.setItem(attachmentDraftKey(machineId, sessionId), JSON.stringify(next))
      setAttachments(next)
      if (notes.length) setSendError(notes.join(' '))
    } catch {
      setSendError('The file could not be attached. Try again.')
    } finally {
      setAttaching(false)
    }
  }
  const removeAttachment = (id: string): void => {
    const next = attachments.filter((item) => item.id !== id)
    setAttachments(next)
    void services.kv.setItem(attachmentDraftKey(machineId, sessionId), JSON.stringify(next))
  }
  /** The paper clip asks which source, the phone's way of the desktop's file picker. */
  const pickSource = (): void => {
    Alert.alert('Add to the message', undefined, [
      { text: 'Photos', onPress: () => void attach('photos') },
      { text: 'Camera', onPress: () => void attach('camera') },
      { text: 'File', onPress: () => void attach('files') },
      { text: 'Cancel', style: 'cancel' }
    ])
  }

  const answer = useCallback(
    async (
      requestId: string,
      optionId: string,
      answers?: Record<string, string>
    ): Promise<void> => {
      setPendingAnswers((ids) => [...ids, requestId])
      try {
        const outcome = await store
          .getState()
          .answerInChat(machineId, sessionId, requestId, optionId, answers)
        if (!outcome.ok) setSendError(outcome.error ?? 'The answer was not sent.')
      } finally {
        setPendingAnswers((ids) => ids.filter((id) => id !== requestId))
      }
    },
    [store, machineId, sessionId]
  )

  const loadingOlder = state?.cursor.loading ?? false
  const loaded = !!state && state.cursor.loaded
  const attachBlocked = sending || attaching || attachments.length >= 10 || !services.beta
  const hasDraft = draft.trim() !== '' || attachments.length > 0
  const sendDisabled = !hasDraft || sending || attaching || !!delivery || ended || !draftLoaded
  const title = session?.title || route.params.title || 'Chat'

  return (
    <Screen>
      <PaneHeader
        title={title}
        meta={session ? `${AGENT_NAMES[session.provider] ?? session.provider}` : undefined}
        status={phoneState ? dotOf[phoneState] : null}
        onBack={() => navigation.goBack()}
        actions={
          <View style={styles.headerStatus}>
            <StatusText status={reachStatus(reach)} testID="chat-reachability">
              {REACHABILITY_LABEL[reach]}
            </StatusText>
          </View>
        }
      />
      <View style={styles.fill}>
        {state?.error ? (
          <Notice tone="error" style={{ marginTop: space(2) }} testID="chat-error">
            {state.error}
          </Notice>
        ) : null}
        <FlatList
          inverted
          data={rows}
          keyExtractor={(row) => row.key}
          renderItem={({ item }) => (
            <TranscriptRow row={item} machineId={machineId} onAnswer={answer} />
          )}
          onEndReachedThreshold={0.6}
          onEndReached={() => {
            if (state && hasMore(state.cursor))
              void store.getState().loadOlder(machineId, sessionId)
          }}
          ListHeaderComponent={
            <View style={styles.foot}>
              {working ? <ProviderMark provider={session?.provider ?? 'agent'} /> : null}
              {ended ? (
                <Notice testID="chat-ended">
                  Session ended
                  {conversation?.exitCode !== undefined ? ` (exit ${conversation.exitCode})` : ''}
                </Notice>
              ) : null}
            </View>
          }
          ListFooterComponent={
            <View style={styles.head}>
              {state?.cursor.truncated ? (
                <Notice testID="history-retention">
                  Only recent history is retained on this server.
                </Notice>
              ) : null}
              {loadingOlder ? (
                <View
                  style={[
                    styles.earlier,
                    t.overlay,
                    { backgroundColor: t.colors.surfaceRaised, borderColor: t.colors.borderSubtle }
                  ]}
                >
                  <Spinner size={chatGlyph} color={t.colors.textSecondary} />
                  <Text style={[type(text.xs), { color: t.colors.textSecondary }]}>
                    Reading earlier messages…
                  </Text>
                </View>
              ) : null}
            </View>
          }
          ListEmptyComponent={
            !loaded ? (
              <View style={styles.emptyFlip}>
                <Loading />
              </View>
            ) : (
              <View style={styles.emptyFlip}>
                <EmptyState
                  icon="chat-bubble-left-right"
                  title="Start a conversation"
                  text="Ask a question or describe what you want to build."
                  testID="chat-empty"
                />
              </View>
            )
          }
          contentContainerStyle={styles.column}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          testID="chat-transcript"
        />
        <View style={[styles.composerWrap, { paddingBottom: Math.max(insets.bottom, space(2)) }]}>
          {sendError ? (
            <Notice
              tone="error"
              style={{ marginHorizontal: 0, marginBottom: space(2) }}
              testID="send-error"
            >
              {sendError}
            </Notice>
          ) : null}
          {delivery && !sending ? (
            <View style={{ marginBottom: space(2) }}>
              <Callout
                title="Delivery unknown"
                testID="delivery-unknown"
                actions={
                  <>
                    <PromptButton
                      title="Discard"
                      onPress={() => void discard()}
                      testID="delivery-discard"
                    />
                    <PromptButton
                      title="Send again (may duplicate)"
                      primary
                      onPress={() => void send()}
                      testID="delivery-send-again"
                    />
                  </>
                }
              >
                {delivery.reason}
              </Callout>
            </View>
          ) : null}
          {sending ? <Notice testID="sending">Sending…</Notice> : null}
          <PromptDock
            requests={waitingOn}
            agent={AGENT_NAMES[session?.provider ?? ''] ?? 'the agent'}
            busy={(id) => !loaded || ended || pendingAnswers.includes(id)}
            onAnswer={(id, optionId, answers) => void answer(id, optionId, answers)}
          />
          <View
            style={[
              styles.composer,
              t.raised,
              { backgroundColor: t.colors.surfaceRaised, borderColor: t.colors.borderSubtle }
            ]}
          >
            {attachments.length ? (
              <View style={styles.files}>
                <Attachments
                  files={attachments}
                  onRemove={sending || attaching ? undefined : removeAttachment}
                />
              </View>
            ) : null}
            <View style={styles.composerLine}>
              <TextInput
                style={[type(text.sm, 400, 1.5), styles.input, { color: t.colors.textPrimary }]}
                multiline
                value={draft}
                onChangeText={changeDraft}
                editable={draftLoaded && !sending && !ended}
                placeholder={ended ? 'This session has ended' : 'Write a message…'}
                placeholderTextColor={t.colors.textTertiary}
                testID="composer-input"
                accessibilityLabel="Message"
              />
              {working ? (
                <Pressable
                  onPress={() => void store.getState().interrupt(machineId, sessionId)}
                  style={({ pressed }) => [
                    styles.send,
                    { backgroundColor: pressed ? t.colors.actionHover : t.colors.action },
                    pressed ? { transform: [{ scale: 0.97 }] } : null
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel="Interrupt"
                  testID="chat-stop"
                >
                  <Icon name="stop" size={chatGlyph} color={t.colors.actionForeground} />
                </Pressable>
              ) : (
                <Pressable
                  onPress={() => void send()}
                  disabled={sendDisabled}
                  style={({ pressed }) => [
                    styles.send,
                    sendDisabled
                      ? { backgroundColor: t.colors.surface200 }
                      : { backgroundColor: pressed ? t.colors.actionHover : t.colors.action },
                    pressed && !sendDisabled ? { transform: [{ scale: 0.97 }] } : null
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel="Send message"
                  accessibilityState={{ disabled: sendDisabled }}
                  testID="composer-send"
                >
                  <Icon
                    name="arrow-up"
                    size={chatGlyph}
                    color={sendDisabled ? t.colors.textTertiary : t.colors.actionForeground}
                  />
                </Pressable>
              )}
            </View>
          </View>
          <View style={styles.footer}>
            <View style={styles.footerLead}>
              <IconButton
                name="paper-clip"
                size="sm"
                label="Add files"
                onPress={pickSource}
                disabled={attachBlocked}
                testID="attach-file"
              />
              {phoneState && phoneState !== 'idle' && phoneState !== 'finished' ? (
                <Text
                  style={[type(text.xs), { color: stateInk(t, phoneState) }]}
                  testID="chat-state"
                >
                  {SESSION_STATE_LABEL[phoneState]}
                </Text>
              ) : null}
            </View>
            {conversation?.model ? (
              <Text style={[type(text.xs), { color: t.colors.textTertiary }]} numberOfLines={1}>
                {conversation.model}
              </Text>
            ) : null}
          </View>
        </View>
      </View>
    </Screen>
  )
}

/** One block of the transcript as the desktop's `TranscriptRow` draws it,
 *  with the column's air above it. */
const TranscriptRow = memo(function TranscriptRow({
  row,
  machineId,
  onAnswer
}: {
  row: Row
  machineId: string
  onAnswer: (requestId: string, optionId: string, answers?: Record<string, string>) => Promise<void>
}): ReactNode {
  const { block } = row
  return (
    <View style={styles.row}>
      {block.kind === 'tool-group' ? (
        <ToolGroup group={block} />
      ) : block.kind === 'approval-group' ? (
        <ApprovalRun group={block} />
      ) : block.kind === 'delivery-group' ? (
        <View style={{ gap: space(5) }}>
          {block.messages.map((entry, i) => (
            <EntryRow key={i} entry={entry} />
          ))}
        </View>
      ) : block.kind === 'document' ? (
        <DocumentRow tool={block.tool} machineId={machineId} />
      ) : (
        <EntryRow entry={block} onAnswer={onAnswer} />
      )}
    </View>
  )
})

function EntryRow({
  entry
}: {
  entry: Entry
  onAnswer?: (
    requestId: string,
    optionId: string,
    answers?: Record<string, string>
  ) => Promise<void>
}): ReactNode {
  const t = useTheme()
  switch (entry.kind) {
    case 'user': {
      const delivery = parseDelivery(entry.text)
      const body = (delivery ? delivery.body : entry.text).replace(/\s+$/, '')
      return (
        <View style={styles.turnEnd} testID="entry-user">
          <Attachments files={entry.attachments ?? []} align="end" />
          {body ? (
            <View
              style={[
                styles.userTurn,
                entry.interrupted
                  ? {
                      backgroundColor: 'transparent',
                      borderWidth: 1,
                      borderColor: t.colors.borderSubtle
                    }
                  : {
                      backgroundColor: delivery
                        ? withAlpha(t.colors.termModel, 0.12)
                        : t.colors.surface100
                    }
              ]}
            >
              {delivery ? (
                <View
                  style={[styles.from, { backgroundColor: withAlpha(t.colors.termModel, 0.16) }]}
                >
                  <Icon name="arrow-turn-down-right" size={12} color={t.colors.termModel} />
                  <Text style={[type(text.xs), { color: t.colors.termModel }]} numberOfLines={1}>
                    {delivery.sender?.name ?? 'Another agent'}
                  </Text>
                </View>
              ) : null}
              <Text
                style={[
                  type(text.sm, 400, 1.6),
                  { color: entry.interrupted ? t.colors.textTertiary : t.colors.textPrimary }
                ]}
                selectable
              >
                {body}
              </Text>
            </View>
          ) : null}
          {entry.interrupted ? (
            <Text
              style={[
                type(text.xs),
                { color: t.colors.textTertiary, paddingTop: space(1), paddingHorizontal: space(1) }
              ]}
            >
              Interrupted
            </Text>
          ) : null}
        </View>
      )
    }
    case 'assistant':
      return entry.text.trim() ? (
        <View style={styles.assistantTurn} testID="entry-assistant">
          <Markdown text={entry.text} />
        </View>
      ) : null
    case 'permission':
      return <PermissionRow entry={entry} />
    case 'error':
      return (
        <Notice tone="error" style={{ marginHorizontal: 0 }} testID="entry-error">
          {entry.message}
        </Notice>
      )
    case 'tool':
      return null
  }
}

/** The agent presented a document for review (`clave_open_side_panel`): a
 *  row like a tool's that opens to the file read from the server; editing
 *  is done on the Mac. */
function DocumentRow({ tool, machineId }: { tool: ToolEntry; machineId: string }): ReactNode {
  const t = useTheme()
  const store = useStoreApi()
  const input = (tool.input ?? {}) as {
    path?: unknown
    title?: unknown
    email?: { subject?: unknown }
  }
  const path = typeof input.path === 'string' ? input.path : null
  const title =
    typeof input.title === 'string'
      ? input.title
      : path
        ? (path.split('/').pop() ?? path)
        : 'A document'
  const [body, setBody] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open || body !== null || !path) return
    store
      .getState()
      .readFile(machineId, dirname(path), path)
      .then((file) =>
        setBody(file.binary ? 'This file is binary.' : file.content + (file.truncated ? '\n…' : ''))
      )
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [open, body, path, machineId, store])
  const email = input.email
  return (
    <View testID="entry-document">
      <Pressable
        onPress={() => setOpen(!open)}
        style={styles.documentRow}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
      >
        <Icon name="document-text" size={chatGlyph} color={t.colors.textTertiary} />
        <Text
          style={[type(codeSize), { color: t.colors.textTertiary, flexShrink: 1 }]}
          numberOfLines={1}
        >
          Document for review
          <Text>{`  ${title}`}</Text>
        </Text>
        <Icon
          name="chevron-right"
          size={chatGlyph}
          color={t.colors.textTertiary}
          style={{ transform: [{ rotate: open ? '90deg' : '0deg' }], opacity: open ? 1 : 0.6 }}
        />
      </Pressable>
      {open ? (
        <View
          style={[
            styles.panel,
            { borderColor: t.colors.borderSubtle, backgroundColor: t.colors.surface50 }
          ]}
        >
          <Text style={[type(text.xs), { color: t.colors.textTertiary }]}>
            {email
              ? `Email${typeof email.subject === 'string' ? `: ${email.subject}` : ''}`
              : 'Document'}
            {path ? `  ${path}` : ''}
          </Text>
          <Text style={[type(text.xs), { color: t.colors.textTertiary }]}>
            Editing is done on the Mac.
          </Text>
          {path ? (
            error ? (
              <Text style={[type(text.xs), { color: t.colors.destructive }]}>{error}</Text>
            ) : body === null ? (
              <Spinner />
            ) : (
              <View testID="document-text">
                <CodeBlock code={excerpt(body)} style="panel" />
              </View>
            )
          ) : null}
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  headerStatus: { paddingHorizontal: controlSm.px },
  column: {
    paddingHorizontal: space(4),
    paddingTop: space(6),
    paddingBottom: space(4),
    flexGrow: 1
  },
  row: { paddingTop: space(5) },
  head: { gap: space(2), paddingBottom: space(2) },
  foot: { gap: space(3) },
  earlier: {
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(1.5),
    height: control.h,
    paddingHorizontal: space(3),
    borderRadius: radius.full,
    borderWidth: 1
  },
  emptyFlip: { transform: [{ scaleY: -1 }], flex: 1, justifyContent: 'center' },
  turnEnd: { alignItems: 'flex-end', gap: space(1.5) },
  userTurn: {
    maxWidth: '85%',
    paddingVertical: space(2),
    paddingHorizontal: space(3.5),
    borderRadius: radius.xxl,
    gap: space(1)
  },
  from: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(1),
    paddingHorizontal: space(1.5),
    paddingVertical: 1,
    borderRadius: space(1.5)
  },
  assistantTurn: { paddingHorizontal: space(1) },
  documentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(2),
    paddingVertical: 3,
    minHeight: 28
  },
  panel: {
    gap: space(1.5),
    marginTop: 2,
    padding: space(2),
    paddingHorizontal: space(2.5),
    paddingBottom: space(2.5),
    borderWidth: 1,
    borderRadius: radius.lg
  },
  composerWrap: { paddingHorizontal: space(3), paddingTop: space(1) },
  composer: {
    borderWidth: 1,
    borderRadius: radius.xxl,
    paddingVertical: space(1.5),
    paddingLeft: space(3.5),
    paddingRight: space(1.5)
  },
  files: { paddingTop: space(1), paddingBottom: space(1.5) },
  composerLine: { flexDirection: 'row', alignItems: 'flex-end', gap: space(2) },
  input: {
    flex: 1,
    minWidth: 0,
    minHeight: control.h - space(1.5),
    maxHeight: 192,
    paddingVertical: 5,
    paddingHorizontal: 0
  },
  send: {
    width: controlSm.h,
    height: controlSm.h,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
    flexShrink: 0
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space(2),
    minHeight: space(5),
    marginTop: space(1),
    paddingHorizontal: space(1)
  },
  footerLead: { flexDirection: 'row', alignItems: 'center', gap: space(1.5), minWidth: 0 }
})
