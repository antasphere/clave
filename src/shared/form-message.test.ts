import { describe, expect, it } from 'vitest'
import { formMessage, formMessageMarker } from './form-message'

const outcome = {
  id: '4af3c00d-508f-4caf-8957-104f3732718c',
  form: 'clave:35e6218e-85f6-4dc0-9b19-366bf927d351',
  description: 'Four things before this machine is set up.',
  questions: [
    { id: 'login', question: 'Your GitHub login' },
    { id: 'projects', question: 'The client projects you join' },
    { id: 'name', question: 'The machine name' }
  ]
}

describe('the message a form becomes for the agent', () => {
  it('reads the answers one per line, an array joined, an unanswered question left out, and names itself', () => {
    const text = formMessage({ ...outcome, answers: { login: 'luca-a', projects: ['reb', 'wat'] } })
    expect(text).toBe(
      [
        '[The form "Four things before this machine is set up." was approved by the person]',
        'Your GitHub login: luca-a',
        'The client projects you join: reb, wat',
        `(form ${outcome.form} · request ${outcome.id}: clave_input_result reads it, clave_input_set revises a field)`
      ].join('\n')
    )
    expect(formMessageMarker(text)).toBe(outcome.form)
  })
  it('says a skip in one line, and still names itself', () => {
    const text = formMessage(outcome)
    expect(text).toBe(
      `[The form "Four things before this machine is set up." was skipped by the person]\n(form ${outcome.form} · request ${outcome.id})`
    )
    expect(formMessageMarker(text)).toBe(outcome.form)
  })
  it("reads a description that spans lines, and a question's own line break", () => {
    const text = formMessage({
      ...outcome,
      description: 'Two things before we start.\nFirst your login.',
      answers: { login: 'luca-a' }
    })
    expect(
      text.startsWith('[The form "Two things before we start.\nFirst your login." was approved')
    ).toBe(true)
    expect(formMessageMarker(text)).toBe(outcome.form)
    expect(formMessageMarker(formMessage({ ...outcome, description: 'A\nB\nC' }))).toBe(
      outcome.form
    )
  })
  it('is not read into a message that only looks like one', () => {
    expect(formMessageMarker('[The form "x" was approved by the person]')).toBeUndefined()
    expect(
      formMessageMarker('hello\n(form clave:35e6218e-85f6-4dc0-9b19-366bf927d351)')
    ).toBeUndefined()
    expect(
      formMessageMarker(`${formMessage(outcome)}\nand then some words of the person`)
    ).toBeUndefined()
    expect(formMessageMarker('(form clave:not-an-id)')).toBeUndefined()
  })
})
