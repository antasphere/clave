/**
 * What the agent waits on, docked above the composer so it is always in the
 * same place: a tool to allow, or questions to answer (`PromptDock.tsx` on
 * the desktop). The card wears the composer's raised surface and keeps
 * colour for what means something: the code, the pick, the primary action.
 * The transcript keeps one muted row per request (`PermissionRow`) as the
 * record of what was asked and what the reader said, and folds the
 * approvals the reader allowed into one run (`ApprovalRun`).
 */
import { useState, type ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { Entry, Permission } from '../../chat/reducer'
import {
  approvalRunSummary,
  decisionWord,
  describeApproval,
  isQuestion
} from '../../chat/approvals'
import { safeJson, type ApprovalGroup } from '../../chat/tools'
import { describeRequest } from './describe-request'
import { shapeAnswers, type QuestionReply } from '../../requests/answers'
import { Icon } from '../../ui/Icon'
import { PromptButton } from '../../ui/components'
import { chatGlyph, codeSize, radius, space, text, type, useTheme } from '../../ui/theme'
import { QuestionForm } from '../QuestionForm'
import { CodeBlock } from './Markdown'

type PermissionEntry = Extract<Entry, { kind: 'permission' }>
export type Answer = (id: string, optionId: string, answers?: Record<string, string>) => void

const stringify = (value: unknown): string => (typeof value === 'string' ? value : safeJson(value))
const isDeny = (id: string): boolean => /deny|decline|cancel|reject|abort/i.test(id)

/** `.chat-prompt`: the raised card the dock and a pending request share. */
export function PromptCard({
  children,
  testID
}: {
  children: ReactNode
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
      {children}
    </View>
  )
}

function PermissionPrompt({
  request,
  agent,
  busy,
  onAnswer
}: {
  request: Permission
  agent: string
  busy: boolean
  onAnswer: Answer
}): ReactNode {
  const t = useTheme()
  const [inputShown, setInputShown] = useState(false)
  const { title, target, code } = describeRequest(request, agent)
  // Deny sits on the left, everything that allows on the right with the first
  // option, the provider's own default, last, where the eye ends.
  const denies = request.options.filter((o) => isDeny(o.id))
  const allows = request.options.filter((o) => !isDeny(o.id))
  const primary = allows[0]
  return (
    <View style={styles.body}>
      <Text style={[type(text.control, 500, 1.5), { color: t.colors.textPrimary }]}>{title}</Text>
      {target ? (
        <Text style={[type(text.xs, 400, 1.5), { color: t.colors.textTertiary }]}>{target}</Text>
      ) : null}
      {request.detail ? (
        <Text style={[type(codeSize, 400, 1.5), { color: t.colors.textSecondary }]}>
          {request.detail}
        </Text>
      ) : null}
      {code ? <CodeBlock code={code.text} prompt={code.language === 'bash'} /> : null}
      {!code && request.input !== undefined ? (
        <View style={{ gap: space(1) }}>
          <Pressable
            onPress={() => setInputShown(!inputShown)}
            style={styles.disclosure}
            accessibilityRole="button"
          >
            <Icon
              name="chevron-right"
              size={chatGlyph}
              color={t.colors.textTertiary}
              style={{ transform: [{ rotate: inputShown ? '90deg' : '0deg' }] }}
            />
            <Text style={[type(text.xs), { color: t.colors.textTertiary }]}>Input</Text>
          </Pressable>
          {inputShown ? <CodeBlock code={stringify(request.input)} style="panel" /> : null}
        </View>
      ) : null}
      <View style={styles.actions}>
        {denies.map((option) => (
          <PromptButton
            key={option.id}
            title={option.label}
            disabled={busy}
            onPress={() => onAnswer(request.id, option.id)}
            testID={`permission-option-${option.id}`}
          />
        ))}
        <View style={{ flex: 1 }} />
        {[...allows.slice(1).reverse(), ...allows.slice(0, 1)].map((option) => (
          <PromptButton
            key={option.id}
            title={option.label}
            primary={option === primary}
            disabled={busy}
            onPress={() => onAnswer(request.id, option.id)}
            testID={`permission-option-${option.id}`}
          />
        ))}
      </View>
    </View>
  )
}

/** A request answered with words: its questions, all on one card, the
 *  replies shaped by `requests/answers.ts` on Send. A plugin's question
 *  (no `questions`, options as the choices) answers with the chosen option. */
function QuestionPrompt({
  request,
  busy,
  onAnswer
}: {
  request: Permission
  busy: boolean
  onAnswer: Answer
}): ReactNode {
  const t = useTheme()
  const [replies, setReplies] = useState<Record<string, QuestionReply>>({})
  const [problem, setProblem] = useState<string | null>(null)
  const structured = request.questions
  const skip = request.options.find((o) => isDeny(o.id))
  const submit = (): void => {
    setProblem(null)
    if (structured?.length) {
      const shaped = shapeAnswers(structured, replies)
      if (!shaped.ok) return setProblem(shaped.problem)
      onAnswer(request.id, 'answer', shaped.answers)
      return
    }
  }
  return (
    <View style={styles.body}>
      {structured?.length ? (
        <QuestionForm
          questions={structured}
          replies={replies}
          onChange={(key, reply) => setReplies({ ...replies, [key]: reply })}
          disabled={busy}
        />
      ) : (
        <>
          <Text style={[type(text.control, 500, 1.5), { color: t.colors.textPrimary }]}>
            {request.description}
          </Text>
          {request.detail ? (
            <Text style={[type(codeSize, 400, 1.5), { color: t.colors.textSecondary }]}>
              {request.detail}
            </Text>
          ) : null}
        </>
      )}
      {problem ? (
        <Text style={[type(text.xs, 400, 1.5), { color: t.colors.destructive }]}>{problem}</Text>
      ) : null}
      <View style={styles.actions}>
        {skip ? (
          <PromptButton
            title="Skip"
            disabled={busy}
            onPress={() => onAnswer(request.id, skip.id)}
            testID={`permission-option-${skip.id}`}
          />
        ) : null}
        <View style={{ flex: 1 }} />
        {structured?.length ? (
          <PromptButton
            title="Send"
            primary
            disabled={busy}
            onPress={submit}
            testID="permission-option-answer"
          />
        ) : (
          request.options
            .filter((o) => !isDeny(o.id))
            .map((option, i, all) => (
              <PromptButton
                key={option.id}
                title={option.label}
                primary={i === all.length - 1}
                disabled={busy}
                onPress={() => onAnswer(request.id, option.id)}
                testID={`permission-option-${option.id}`}
              />
            ))
        )}
      </View>
    </View>
  )
}

/** The first request the agent still waits on; the rest queue behind it. */
export function PromptDock({
  requests,
  agent,
  busy,
  onAnswer
}: {
  requests: readonly Permission[]
  agent: string
  busy: (id: string) => boolean
  onAnswer: Answer
}): ReactNode {
  const t = useTheme()
  const request = requests[0]
  if (!request) return null
  const question = isQuestion(request)
  return (
    <PromptCard testID="prompt-dock">
      {requests.length > 1 ? (
        <Text style={[type(text.xs), { color: t.colors.textTertiary }]}>
          1 of {requests.length} waiting
        </Text>
      ) : null}
      {question ? (
        <QuestionPrompt
          key={request.id}
          request={request}
          busy={busy(request.id)}
          onAnswer={onAnswer}
        />
      ) : (
        <PermissionPrompt
          key={request.id}
          request={request}
          agent={agent}
          busy={busy(request.id)}
          onAnswer={onAnswer}
        />
      )}
    </PromptCard>
  )
}

/** `.chat-permission-row`: the transcript's record of a request, one muted
 *  row like a tool call: what was asked and what the reader said. */
export function PermissionRow({ entry }: { entry: PermissionEntry }): ReactNode {
  const t = useTheme()
  const { request } = entry
  const question = isQuestion(request)
  const chosen = entry.answer ? decisionWord(request, entry.answer) : null
  const approval = question
    ? undefined
    : (describeApproval(request) ?? {
        label: request.toolName ?? request.description,
        target: describeRequest(request, '').target
      })
  const subject = approval
    ? [approval.label, approval.target].filter(Boolean).join(' ')
    : request.description
  const answers = entry.answers ? Object.values(entry.answers).join('; ') : null
  const waiting = !entry.answer && !entry.answeredElsewhere
  const status =
    entry.answeredElsewhere && !entry.answer
      ? 'No longer awaiting an answer'
      : !entry.answer
        ? question
          ? 'Waiting for your answer'
          : 'Waiting for your approval'
        : question
          ? isDeny(entry.answer)
            ? 'Skipped'
            : 'Answered'
          : chosen
  const ink = waiting ? t.colors.textSecondary : t.colors.textTertiary
  return (
    <View style={styles.permissionRow} testID="entry-permission" accessibilityRole="text">
      <Icon
        name={question ? 'question-mark-circle' : 'shield-check'}
        size={chatGlyph}
        color={ink}
        style={{ marginTop: 2 }}
      />
      <Text style={[type(codeSize, 400, 1.5), { color: ink, flex: 1, minWidth: 0 }]}>
        {status}
        {subject ? <Text>{`  ${subject}`}</Text> : null}
        {answers && question ? (
          <Text style={{ color: t.colors.textSecondary }}>{`  → ${answers}`}</Text>
        ) : null}
      </Text>
    </View>
  )
}

/** `.chat-approval-run`: the approvals the reader allowed, one row led by
 *  the shield that opens to one receipt per request. */
export function ApprovalRun({ group }: { group: ApprovalGroup }): ReactNode {
  const t = useTheme()
  const [open, setOpen] = useState(false)
  const { head, detail } = approvalRunSummary(group.approvals)
  return (
    <View testID="entry-approvals">
      <Pressable
        onPress={() => setOpen(!open)}
        style={styles.runRow}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
      >
        <Icon name="shield-check" size={chatGlyph} color={t.colors.textTertiary} />
        <Text
          style={[type(codeSize), { color: t.colors.textTertiary, flexShrink: 1 }]}
          numberOfLines={1}
        >
          {head}
          {detail ? `  ${detail}` : ''}
        </Text>
        <Icon
          name="chevron-right"
          size={chatGlyph}
          color={t.colors.textTertiary}
          style={{ transform: [{ rotate: open ? '90deg' : '0deg' }], opacity: open ? 1 : 0.6 }}
        />
      </Pressable>
      {open ? (
        <View style={{ paddingLeft: chatGlyph + space(2) }}>
          {group.approvals.map((entry) => (
            <PermissionRow key={entry.request.id} entry={entry} />
          ))}
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    gap: space(1),
    padding: space(3),
    paddingHorizontal: space(3.5),
    borderWidth: 1,
    borderRadius: radius.xxl
  },
  body: { gap: space(2) },
  disclosure: { flexDirection: 'row', alignItems: 'center', gap: space(1) },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
    marginTop: space(1)
  },
  permissionRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space(2),
    paddingVertical: 3
  },
  runRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(2),
    paddingVertical: 3,
    minHeight: 28
  }
})
