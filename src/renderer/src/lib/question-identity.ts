interface QuestionIdentity {
  id?: string
  question: string
}

/** Provider IDs are request-local identities; labels remain presentation. */
export const questionKey = (question: QuestionIdentity): string => question.id ?? question.question

export function questionIsPrivate(question: QuestionIdentity, input: unknown): boolean {
  if (
    !input ||
    typeof input !== 'object' ||
    !('questions' in input) ||
    !Array.isArray(input.questions)
  )
    return false
  return input.questions.some((raw: unknown) => {
    if (!raw || typeof raw !== 'object') return false
    const q = raw as Record<string, unknown>
    return (
      (question.id ? q.id === question.id : q.question === question.question) && q.isSecret === true
    )
  })
}

/** A local transcript may show public answers, never a private input's value. */
export function publicQuestionAnswers(
  questions: readonly QuestionIdentity[] | undefined,
  input: unknown,
  answers: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!answers) return undefined
  const privateKeys = new Set(
    questions?.filter((q) => questionIsPrivate(q, input)).map(questionKey) ?? []
  )
  const visible = Object.fromEntries(
    Object.entries(answers).filter(([key]) => !privateKeys.has(key))
  )
  return Object.keys(visible).length ? visible : undefined
}
