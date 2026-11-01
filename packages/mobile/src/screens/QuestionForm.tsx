/**
 * The form of an agent's questions: each with its options (one pick, or any
 * with `multiSelect`) and a free answer; the replies shaped by
 * `requests/answers.ts` on submit. Shared by a request card and a chat's
 * permission card.
 */
import type { ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { AgentQuestion } from '../contract/types'
import { questionKey, type QuestionReply } from '../requests/answers'
import { Field } from '../ui/components'
import { colors, font, radius, space } from '../ui/theme'

export function QuestionForm({
  questions,
  replies,
  onChange,
  secretKeys = [],
  testID
}: {
  questions: readonly AgentQuestion[]
  replies: Readonly<Record<string, QuestionReply>>
  onChange: (key: string, reply: QuestionReply) => void
  /** The question keys whose free answer is a secret: masked as typed. */
  secretKeys?: readonly string[]
  testID?: string
}): ReactNode {
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
        return (
          <View key={key} style={styles.question}>
            {q.header ? <Text style={styles.header}>{q.header}</Text> : null}
            <Text style={styles.text}>{q.question}</Text>
            {q.multiSelect ? <Text style={styles.hint}>Choose any</Text> : null}
            {q.options.map((option) => {
              const on = reply.picked.includes(option.label)
              return (
                <Pressable
                  key={option.label}
                  onPress={() => pick(option.label)}
                  accessibilityRole={q.multiSelect ? 'checkbox' : 'radio'}
                  accessibilityState={{ checked: on }}
                  testID={`question-${index}-option-${option.label}`}
                  style={[styles.option, on && styles.optionOn]}
                >
                  <Text style={[styles.optionText, on && { color: colors.accent }]}>
                    {on ? '● ' : '○ '}
                    {option.label}
                  </Text>
                  {option.description ? (
                    <Text style={styles.description}>{option.description}</Text>
                  ) : null}
                </Pressable>
              )
            })}
            <Field
              placeholder="Something else"
              value={reply.other ?? ''}
              onChangeText={(other) => onChange(key, { ...reply, other })}
              secureTextEntry={secretKeys.includes(key)}
              testID={`question-${index}-other`}
            />
          </View>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  form: { gap: space.lg },
  question: { gap: space.sm },
  header: {
    color: colors.textSecondary,
    fontSize: font.xs,
    fontWeight: '600',
    textTransform: 'uppercase'
  },
  text: { color: colors.textPrimary, fontSize: font.md },
  hint: { color: colors.textTertiary, fontSize: font.xs },
  option: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    gap: 2
  },
  optionOn: { borderColor: colors.accent },
  optionText: { color: colors.textPrimary, fontSize: font.md },
  description: { color: colors.textSecondary, fontSize: font.sm }
})
