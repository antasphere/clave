import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  REQUEST_INPUT_DESCRIPTION,
  inputResultPayload,
  pollResult,
  requestInputSchema,
  toHostedInput,
  type RequestInputArgs
} from './request-input'

/* The shape an agent hands clave_request_input, as both MCP servers take it
   (PRDCT-4157), and the one place a question's shape is judged beyond its
   types. */

const schema = z.object(requestInputSchema)
const parse = (args: unknown): RequestInputArgs => schema.parse(args) as RequestInputArgs

describe('clave_request_input arguments', () => {
  it('maps a form of typed questions onto the wire shape, form layout and text kind by default', () => {
    const args = parse({
      description: 'Before we start.',
      questions: [
        { id: 'email', label: 'Your team e-mail', kind: 'email', hint: 'The one on the hub' },
        { id: 'name', label: 'How should we call you?', placeholder: 'Luca', default: 'Luca' },
        {
          id: 'projects',
          label: 'Projects you join',
          kind: 'choice',
          multiSelect: true,
          optional: true,
          options: [{ label: 'reb' }, { label: 'wat', description: 'The coworking' }]
        },
        {
          id: 'sign',
          label: 'Sign in to GitHub',
          kind: 'link',
          url: 'https://github.com/login',
          confirm: "I'm signed in"
        },
        { id: 'budget', label: 'Seats', kind: 'number', min: 1, max: 10 }
      ]
    })
    expect(args.layout).toBe('form')
    expect(args.timeoutSeconds).toBe(0)
    expect(toHostedInput(args, 'tab-1')).toEqual({
      sessionId: 'tab-1',
      description: 'Before we start.',
      layout: 'form',
      questions: [
        {
          id: 'email',
          question: 'Your team e-mail',
          kind: 'email',
          options: [],
          hint: 'The one on the hub'
        },
        {
          id: 'name',
          question: 'How should we call you?',
          kind: 'text',
          options: [],
          placeholder: 'Luca',
          default: 'Luca'
        },
        {
          id: 'projects',
          question: 'Projects you join',
          kind: 'choice',
          multiSelect: true,
          optional: true,
          options: [{ label: 'reb' }, { label: 'wat', description: 'The coworking' }]
        },
        {
          id: 'sign',
          question: 'Sign in to GitHub',
          kind: 'link',
          options: [],
          url: 'https://github.com/login',
          confirm: "I'm signed in"
        },
        { id: 'budget', question: 'Seats', kind: 'number', options: [], min: 1, max: 10 }
      ]
    })
  })

  it('carries a choice closed to its options, and says every question goes through the form (PRDCT-4322)', () => {
    const args = parse({
      description: 'Where it runs.',
      questions: [
        {
          id: 'server',
          label: 'Which server?',
          kind: 'choice',
          optionsOnly: true,
          options: [{ label: 'studio' }, { label: 'mini' }]
        },
        {
          id: 'host',
          label: 'Which host?',
          kind: 'choice',
          options: [{ label: 'a' }, { label: 'b' }]
        }
      ]
    })
    const [closed, open] = toHostedInput(args, 'tab-1').questions
    expect(closed.optionsOnly).toBe(true)
    expect(open).not.toHaveProperty('optionsOnly')
    expect(() =>
      toHostedInput(
        parse({ description: 'D', questions: [{ id: 'a', label: 'A', optionsOnly: true }] }),
        'tab-1'
      )
    ).toThrow('optionsOnly belongs to a choice')
    expect(REQUEST_INPUT_DESCRIPTION).toContain('never through your own question tool')
    expect(REQUEST_INPUT_DESCRIPTION).not.toContain('can also go through your own question tool')
  })

  it.each([
    [{ id: 'a', label: 'A', kind: 'choice' }, 'two options or more'],
    [
      { id: 'a', label: 'A', options: [{ label: 'x' }, { label: 'y' }] },
      'options belong to a choice'
    ],
    [{ id: 'a', label: 'A', kind: 'link' }, 'a link needs its url'],
    [{ id: 'a', label: 'A', kind: 'link', url: 'ftp://x.y' }, 'opens an http(s) address'],
    [{ id: 'a', label: 'A', url: 'https://x.y' }, 'url and confirm belong to a link'],
    [{ id: 'a', label: 'A', min: 1 }, 'min and max belong to a number']
  ])('refuses a question whose shape does not fit its kind: %j', (question, words) => {
    const args = parse({ description: 'D', questions: [question] })
    expect(() => toHostedInput(args, 'tab-1')).toThrow(words)
  })

  it('refuses two questions under one id, and an id that is not a key', () => {
    const args = parse({
      description: 'D',
      questions: [
        { id: 'a', label: 'A' },
        { id: 'a', label: 'B' }
      ]
    })
    expect(() => toHostedInput(args, 'tab-1')).toThrow('share the id')
    expect(() => parse({ description: 'D', questions: [{ id: 'Not Ok', label: 'A' }] })).toThrow()
    expect(() => parse({ description: 'D', questions: [] })).toThrow()
    expect(() =>
      parse({ description: 'D', questions: [{ id: 'a', label: 'A', kind: 'secret' }] })
    ).toThrow()
  })

  it('the agent reads the status, and the answers once there are any', () => {
    expect(inputResultPayload({ requestId: 'r', status: 'pending' })).toEqual({
      requestId: 'r',
      status: 'pending'
    })
    expect(
      inputResultPayload({ requestId: 'r', status: 'completed', answers: { a: 'x', b: ['y'] } })
    ).toEqual({ requestId: 'r', status: 'completed', answers: { a: 'x', b: ['y'] } })
  })

  it('polls in bounded rounds until the request settles or the budget is spent', async () => {
    const waits: number[] = []
    let calls = 0
    const view = await pollResult(async (waitMs) => {
      waits.push(waitMs)
      calls += 1
      return { requestId: 'r', status: calls < 3 ? 'pending' : 'completed', answers: { a: 'x' } }
    }, 1000)
    expect(view.status).toBe('completed')
    expect(calls).toBe(3)
    expect(waits.every((w) => w <= 1000)).toBe(true)
    const spent = await pollResult(async () => ({ requestId: 'r', status: 'pending' }), 0)
    expect(spent.status).toBe('pending')
  })
})
