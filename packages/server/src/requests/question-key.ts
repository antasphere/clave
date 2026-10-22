/** The installed answer-record codec drops __proto__ and caps keys at 16,384
 * characters. Admission must reject these keys before publishing a prompt. */
export const isQuestionAnswerKey = (key: string): boolean =>
  key.length > 0 && key.length <= 16_384 && key !== '__proto__'
