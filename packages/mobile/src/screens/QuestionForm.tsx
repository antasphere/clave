/**
 * The form of an agent's questions: each with its options (one pick, or any
 * with `multiSelect`) and a free answer; the replies shaped by
 * `requests/answers.ts` on submit. Shared by a request card and a chat's
 * prompt. The rows are the desktop prompt dock's options: a full-width
 * choice, the box or the tick carrying the pick, and "Other" a card whose
 * body is the field.
 */
import type { ReactNode } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import type { AgentQuestion } from '../contract/types'
import { questionKey, type QuestionReply } from '../requests/answers'
import { BareInput, OptionRow } from '../ui/components'
import { space, text, type, useTheme } from '../ui/theme'

export function QuestionForm({
  questions,
  replies,
  onChange,
  secretKeys = [],
  disabled,
  testID
}: {
  questions: readonly AgentQuestion[]
  replies: Readonly<Record<string, QuestionReply>>
  onChange: (key: string, reply: QuestionReply) => void
  /** The question keys whose free answer is a secret: masked as typed. */
  secretKeys?: readonly string[]
  disabled?: boolean
  testID?: string
}): ReactNode {
  const t = useTheme()
  return (
    <View style={styles.form} testID={testID}>
      {questions.map((q, index) => {
        const key = questionKey(q)
        const reply = replies[key] ?? { picked: [] }
        const pick = (label: string): void => {
          const picked = q.multiSelect
            ? reply.picked.includes(label)
              ? reply.picked.filter((l) => l !== label)
              : [...reply.picked, label]
            : [label]
          onChange(key, { ...reply, picked })
        }
        const other = reply.other ?? ''
        return (
          <View key={key} style={styles.question}>
            <View style={styles.head}>
              {questions.length > 1 ? (
                <View style={[styles.step, { backgroundColor: t.colors.surface100 }]}>
                  <Text style={[type(text.xs), styles.tabular, { color: t.colors.textSecondary }]}>
                    {index + 1}/{questions.length}
                  </Text>
                </View>
              ) : null}
              <Text
                style={[
                  type(text.control, 500, 1.5),
                  styles.title,
                  { color: t.colors.textPrimary }
                ]}
              >
                {q.question}
                {q.header ? (
                  <Text
                    style={[type(text.xs), { color: t.colors.textTertiary }]}
                  >{`  ${q.header}`}</Text>
                ) : null}
                {q.multiSelect ? (
                  <Text style={[type(text.xs), { color: t.colors.textTertiary }]}>
                    {'  Choose any'}
                  </Text>
                ) : null}
              </Text>
            </View>
            <View style={styles.options}>
              {q.options.map((option) => (
                <OptionRow
                  key={option.label}
                  label={option.label}
                  hint={option.description}
                  selected={reply.picked.includes(option.label)}
                  multi={q.multiSelect}
                  disabled={disabled}
                  onPress={() => pick(option.label)}
                  testID={`question-${index}-option-${option.label}`}
                />
              ))}
              <OptionRow
                label="Other"
                selected={other.trim() !== ''}
                disabled={disabled}
                onPress={() => {}}
              >
                <BareInput
                  placeholder="Type your own answer"
                  value={other}
                  onChangeText={(value) => onChange(key, { ...reply, other: value })}
                  secureTextEntry={secretKeys.includes(key)}
                  multiline={!secretKeys.includes(key)}
                  editable={!disabled}
                  testID={`question-${index}-other`}
                  style={{ marginTop: 2 }}
                />
              </OptionRow>
            </View>
          </View>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  form: { gap: space(4) },
  question: { gap: space(2) },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: space(2) },
  step: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: 999, marginTop: 1 },
  title: { flex: 1, minWidth: 0 },
  tabular: { fontVariant: ['tabular-nums'] },
  options: { gap: 0 }
})
