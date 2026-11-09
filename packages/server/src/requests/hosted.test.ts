import { describe, expect, it, vi } from 'vitest'
import { HOSTED_REQUEST_PREFIX, PendingRequests, RESULT_WAIT_MAX_MS } from './service'
import { INPUT_REQUEST_TOOL } from '../../../contract/src/input-kinds'

/* A request an agent tool puts to the person (`clave_request_input`,
   PRDCT-4157) lives in the same store as a provider's native question and
   rides the same road: a provider id the server minted, the question card's
   two options, the answers kept for the tool that polls. */

const onboarding = {
  sessionId: 's1',
  description: 'Three things before we set up your machine.',
  questions: [
    { id: 'email', question: 'Your team e-mail', kind: 'email' as const, options: [] },
    { id: 'login', question: 'Your GitHub login', kind: 'github-login' as const, options: [] },
    {
      id: 'projects',
      question: 'The client projects you join',
      kind: 'choice' as const,
      multiSelect: true,
      optional: true,
      options: [{ label: 'syndicable' }, { label: 'reb' }, { label: 'wat' }]
    }
  ]
}

describe('hosted requests', () => {
  it('is created as a clarification with a server-minted provider id and the card’s two options', () => {
    const requests = new PendingRequests()
    const request = requests.createHosted(onboarding)
    expect(request.kind).toBe('clarification')
    expect(request.providerRequestId?.startsWith(HOSTED_REQUEST_PREFIX)).toBe(true)
    expect(request.toolName).toBe(INPUT_REQUEST_TOOL)
    expect(request.input).toEqual({ tool: INPUT_REQUEST_TOOL, layout: 'form' })
    expect(request.options).toEqual([
      { id: 'answer', label: 'Approve' },
      { id: 'deny', label: 'Skip' }
    ])
    expect(requests.isHosted(request.id)).toBe(true)
    expect(requests.native('s1', request.providerRequestId!)?.id).toBe(request.id)
    expect(requests.hostedPending('s1').map((r) => r.id)).toEqual([request.id])
    requests.close()
  })

  it('answers come back to the tool, arrays for a multi-select, an optional question left out', async () => {
    const requests = new PendingRequests()
    const request = requests.createHosted(onboarding)
    const settled = vi.fn()
    requests.onSettled(settled)
    const outcome = await requests.resolve({
      requestId: request.id,
      response: {
        type: 'permission',
        optionId: 'answer',
        answers: { email: 'luca@antasphere.com', login: 'luca-a', projects: ['reb', 'wat'] }
      }
    })
    expect(outcome).toEqual({ accepted: true })
    const view = await requests.resultAfter(request.id, 's1')
    expect(view).toEqual({
      requestId: request.id,
      status: 'completed',
      answers: { email: 'luca@antasphere.com', login: 'luca-a', projects: ['reb', 'wat'] }
    })
    expect(settled).toHaveBeenCalledTimes(1)
    expect(settled.mock.calls[0][1]).toMatchObject({ status: 'completed' })
    // An optional question may be left out entirely.
    const again = requests.createHosted(onboarding)
    await requests.resolve({
      requestId: again.id,
      response: {
        type: 'permission',
        optionId: 'answer',
        answers: { email: 'a@b.co', login: 'a' }
      }
    })
    expect((await requests.resultAfter(again.id, 's1')).answers).toEqual({
      email: 'a@b.co',
      login: 'a'
    })
    requests.close()
  })

  it('refuses an answer that does not fit its kind and leaves the prompt pending', async () => {
    const requests = new PendingRequests()
    const request = requests.createHosted(onboarding)
    const wrong: Record<string, string | string[]>[] = [
      { email: 'not-an-email', login: 'luca-a' },
      { email: 'luca@antasphere.com', login: '-bad-' },
      { email: 'luca@antasphere.com', login: 'luca-a', projects: ['nope'] },
      { login: 'luca-a' },
      { email: 'luca@antasphere.com', login: 'luca-a', extra: 'x' }
    ]
    for (const answers of wrong)
      await expect(
        requests.resolve({
          requestId: request.id,
          response: { type: 'permission', optionId: 'answer', answers }
        })
      ).rejects.toMatchObject({ code: 'invalid' })
    expect((await requests.resultAfter(request.id, 's1')).status).toBe('pending')
    requests.close()
  })

  it('a skip reads as dismissed to the tool', async () => {
    const requests = new PendingRequests()
    const request = requests.createHosted(onboarding)
    await requests.resolve({
      requestId: request.id,
      response: { type: 'permission', optionId: 'deny' }
    })
    expect(await requests.resultAfter(request.id, 's1')).toEqual({
      requestId: request.id,
      status: 'dismissed'
    })
    requests.close()
  })

  it('the result waits for the person, bounded, and answers when they do', async () => {
    vi.useFakeTimers()
    try {
      const requests = new PendingRequests()
      const request = requests.createHosted(onboarding)
      const waiting = requests.resultAfter(request.id, 's1', 10 * 60_000)
      let done = false
      void waiting.then(() => {
        done = true
      })
      await vi.advanceTimersByTimeAsync(RESULT_WAIT_MAX_MS - 1)
      expect(done).toBe(false)
      await requests.resolve({
        requestId: request.id,
        response: { type: 'permission', optionId: 'deny' }
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(done).toBe(true)
      expect((await waiting).status).toBe('dismissed')
      // A wait longer than the bound ends at the bound, still pending.
      const second = requests.createHosted(onboarding)
      const bounded = requests.resultAfter(second.id, 's1', 10 * 60_000)
      await vi.advanceTimersByTimeAsync(RESULT_WAIT_MAX_MS)
      expect((await bounded).status).toBe('pending')
      requests.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('belongs to its session alone, lives across the turn, and is cancelled with the session or by name', async () => {
    const requests = new PendingRequests()
    const request = requests.createHosted(onboarding)
    await expect(requests.resultAfter(request.id, 'another')).rejects.toMatchObject({
      code: 'not_found'
    })
    const settled = vi.fn()
    requests.onSettled(settled)
    // The turn's end cancels the provider's own requests, never the form:
    // the agent ends its turn and the person fills it or writes.
    const native = requests.create({
      sessionId: 's1',
      kind: 'clarification',
      providerRequestId: 'native-1',
      description: 'A native question',
      options: [{ id: 'answer', label: 'Submit' }],
      questions: [{ question: 'Which?', options: [{ label: 'A' }] }]
    })
    requests.cancelNative('s1')
    expect((await requests.resultAfter(request.id, 's1')).status).toBe('pending')
    expect(requests.result(native.id, 's1').status).toBe('cancelled')
    expect(settled).toHaveBeenCalledTimes(1)
    // Named, the form is cancelled like any other request.
    requests.cancelNative('s1', request.providerRequestId)
    expect((await requests.resultAfter(request.id, 's1')).status).toBe('cancelled')
    expect(settled).toHaveBeenCalledTimes(2)
    const next = requests.createHosted(onboarding)
    requests.cancelSession('s1')
    expect((await requests.resultAfter(next.id, 's1')).status).toBe('cancelled')
    requests.close()
  })

  it('the agent sets fields on the open form: judged by kind, kept as the draft the tool reads, told to the views', async () => {
    const requests = new PendingRequests()
    const request = requests.createHosted(onboarding)
    const updated = vi.fn()
    requests.onUpdated(updated)
    const set = { requestId: request.id, sessionId: 's1' }
    await expect(
      requests.setAnswers({ ...set, answers: { email: 'luca@antasphere' } })
    ).rejects.toMatchObject({ code: 'invalid', message: '"email": This is not an e-mail address.' })
    await expect(requests.setAnswers({ ...set, answers: { nope: 'x' } })).rejects.toMatchObject({
      code: 'invalid',
      message: 'No question "nope" on this form.'
    })
    await expect(
      requests.setAnswers({ ...set, sessionId: 'another', answers: { login: 'luca-a' } })
    ).rejects.toMatchObject({ code: 'not_found' })
    expect(updated).not.toHaveBeenCalled()
    const first = await requests.setAnswers({ ...set, answers: { login: ' luca-a ' } })
    expect(first).toEqual({
      requestId: request.id,
      status: 'pending',
      answers: { login: 'luca-a' }
    })
    expect(updated).toHaveBeenCalledWith(
      expect.objectContaining({ id: request.id }),
      { login: 'luca-a' },
      false
    )
    const second = await requests.setAnswers({ ...set, answers: { projects: ['reb'] } })
    expect(second.answers).toEqual({ login: 'luca-a', projects: ['reb'] })
    expect(requests.draftOf(request.id)).toEqual({ login: 'luca-a', projects: ['reb'] })
    // The draft is what a result read answers while the form is open, and
    // the person's approve replaces it with every answer.
    expect((await requests.resultAfter(request.id, 's1')).answers).toEqual({
      login: 'luca-a',
      projects: ['reb']
    })
    await requests.resolve({
      requestId: request.id,
      response: {
        type: 'permission',
        optionId: 'answer',
        answers: { email: 'luca@antasphere.com', login: 'luca-a' }
      }
    })
    expect(await requests.resultAfter(request.id, 's1')).toEqual({
      requestId: request.id,
      status: 'completed',
      answers: { email: 'luca@antasphere.com', login: 'luca-a' }
    })
    expect(requests.draftOf(request.id)).toEqual({})
    requests.close()
  })

  it('the agent approves the open form itself only once every required field is set', async () => {
    const requests = new PendingRequests()
    const request = requests.createHosted(onboarding)
    const settled = vi.fn()
    requests.onSettled(settled)
    const set = { requestId: request.id, sessionId: 's1' }
    await expect(
      requests.setAnswers({ ...set, answers: { login: 'luca-a' }, submit: true })
    ).rejects.toMatchObject({
      code: 'invalid',
      message: '"email" is still unanswered; set it, or let the person approve.'
    })
    // Nothing was written by the refused call; the form is still open.
    expect(await requests.resultAfter(request.id, 's1')).toEqual({
      requestId: request.id,
      status: 'pending'
    })
    expect(settled).not.toHaveBeenCalled()
    const view = await requests.setAnswers({
      ...set,
      answers: { login: 'luca-a', email: 'luca@antasphere.com' },
      submit: true
    })
    expect(view).toEqual({
      requestId: request.id,
      status: 'completed',
      answers: { login: 'luca-a', email: 'luca@antasphere.com' }
    })
    expect(settled).toHaveBeenCalledTimes(1)
    expect(settled.mock.calls[0][2]).toEqual({ byAgent: true })
    requests.close()
  })

  it('a refused submit writes nothing, an empty value clears an optional field, and a no-op set revises nothing', async () => {
    const requests = new PendingRequests()
    const request = requests.createHosted(onboarding)
    const updated = vi.fn()
    requests.onUpdated(updated)
    const set = { requestId: request.id, sessionId: 's1' }
    // The refusal of the submit comes before any field is written.
    await expect(
      requests.setAnswers({ ...set, answers: { projects: ['reb'] }, submit: true })
    ).rejects.toMatchObject({ code: 'invalid' })
    expect(requests.draftOf(request.id)).toEqual({})
    expect(updated).not.toHaveBeenCalled()
    // An empty value on a required field is refused; on an optional one it
    // clears the field, and the views are told with an empty value.
    await expect(requests.setAnswers({ ...set, answers: { login: '' } })).rejects.toMatchObject({
      code: 'invalid',
      message: '"login": An answer is needed.'
    })
    await requests.setAnswers({ ...set, answers: { projects: ['reb'], login: 'luca-a' } })
    const cleared = await requests.setAnswers({ ...set, answers: { projects: [] } })
    expect(cleared.answers).toEqual({ login: 'luca-a' })
    expect(updated).toHaveBeenLastCalledWith(expect.anything(), { projects: '' }, false)
    // The same value again is no change: nothing published.
    updated.mockClear()
    await requests.setAnswers({ ...set, answers: { login: 'luca-a' } })
    expect(updated).not.toHaveBeenCalled()
    await requests.resolve({
      requestId: request.id,
      response: {
        type: 'permission',
        optionId: 'answer',
        answers: { email: 'luca@antasphere.com', login: 'luca-a' }
      }
    })
    const same = await requests.setAnswers({ ...set, answers: { login: 'luca-a' } })
    expect(same).toEqual({
      requestId: request.id,
      status: 'completed',
      answers: { email: 'luca@antasphere.com', login: 'luca-a' }
    })
    const none = await requests.setAnswers({ ...set, answers: {} })
    expect(none.revised).toBeUndefined()
    const dropped = await requests.setAnswers({ ...set, answers: { projects: [] } })
    expect(dropped.revised).toBeUndefined()
    await requests.setAnswers({ ...set, answers: { projects: ['reb', 'wat'] } })
    const reordered = await requests.setAnswers({ ...set, answers: { projects: ['wat', 'reb'] } })
    expect(reordered.answers).toEqual({
      email: 'luca@antasphere.com',
      login: 'luca-a',
      projects: ['reb', 'wat']
    })
    const changed = await requests.setAnswers({ ...set, answers: { projects: ['wat'] } })
    expect(changed).toEqual({
      requestId: request.id,
      status: 'completed',
      answers: { email: 'luca@antasphere.com', login: 'luca-a', projects: ['wat'] },
      revised: true
    })
    requests.close()
  })

  it('a later correction sets a field on the approved form, which then reads revised', async () => {
    const requests = new PendingRequests()
    const request = requests.createHosted(onboarding)
    const updated = vi.fn()
    requests.onUpdated(updated)
    await requests.resolve({
      requestId: request.id,
      response: {
        type: 'permission',
        optionId: 'answer',
        answers: { email: 'luca@antasphere.com', login: 'luca-a' }
      }
    })
    const view = await requests.setAnswers({
      requestId: request.id,
      sessionId: 's1',
      answers: { login: 'luca-antasphere' }
    })
    expect(view).toEqual({
      requestId: request.id,
      status: 'completed',
      answers: { email: 'luca@antasphere.com', login: 'luca-antasphere' },
      revised: true
    })
    expect(updated).toHaveBeenCalledWith(
      expect.objectContaining({ id: request.id }),
      { login: 'luca-antasphere' },
      true
    )
    await expect(
      requests.setAnswers({ requestId: request.id, sessionId: 's1', answers: { login: 'x_y' } })
    ).rejects.toMatchObject({ code: 'invalid' })
    requests.close()
  })

  it('a note under a field the agent could not fill reaches the views, and names a question of the form', async () => {
    const requests = new PendingRequests()
    const request = requests.createHosted(onboarding)
    const updated = vi.fn()
    requests.onUpdated(updated)
    const set = { requestId: request.id, sessionId: 's1' }
    await expect(
      requests.setAnswers({ ...set, answers: {}, notes: { nope: 'x' } })
    ).rejects.toMatchObject({ code: 'invalid', message: 'No question "nope" on this form.' })
    const view = await requests.setAnswers({
      ...set,
      answers: {},
      notes: { email: ' I did not catch an e-mail in that ' }
    })
    expect(view).toEqual({ requestId: request.id, status: 'pending' })
    expect(updated).toHaveBeenCalledWith(expect.objectContaining({ id: request.id }), {}, false, {
      email: 'I did not catch an e-mail in that'
    })
    // A blank note is no note.
    updated.mockClear()
    await requests.setAnswers({ ...set, answers: {}, notes: { email: '  ' } })
    expect(updated).not.toHaveBeenCalled()
    requests.close()
  })

  it('a skipped or cancelled form takes nothing more', async () => {
    const requests = new PendingRequests()
    const skipped = requests.createHosted(onboarding)
    await requests.resolve({
      requestId: skipped.id,
      response: { type: 'permission', optionId: 'deny' }
    })
    await expect(
      requests.setAnswers({ requestId: skipped.id, sessionId: 's1', answers: { login: 'a' } })
    ).rejects.toMatchObject({ code: 'closed', message: 'This form was skipped; ask again.' })
    const cancelled = requests.createHosted(onboarding)
    requests.cancelSession('s1')
    await expect(
      requests.setAnswers({ requestId: cancelled.id, sessionId: 's1', answers: { login: 'a' } })
    ).rejects.toMatchObject({ code: 'closed', message: 'This form was cancelled; ask again.' })
    requests.close()
  })

  it("a settle says whether the agent settled it itself; the person's never does", async () => {
    const requests = new PendingRequests()
    const request = requests.createHosted(onboarding)
    const settled = vi.fn()
    requests.onSettled(settled)
    const waiting = requests.resultAfter(request.id, 's1', 5_000)
    await new Promise((r) => setTimeout(r, 0))
    await requests.resolve({
      requestId: request.id,
      response: { type: 'permission', optionId: 'deny' }
    })
    expect((await waiting).status).toBe('dismissed')
    expect(settled.mock.calls[0][2]).toEqual({ byAgent: false })
    requests.close()
  })

  it('a native question keeps the strict rule: every question answered with words', async () => {
    const requests = new PendingRequests()
    const native = requests.create({
      sessionId: 's1',
      kind: 'clarification',
      providerRequestId: 'native-1',
      description: 'Which?',
      options: [{ id: 'answer', label: 'Submit' }],
      questions: [{ question: 'Which?', options: [{ label: 'A' }] }]
    })
    await expect(
      requests.resolve({
        requestId: native.id,
        response: { type: 'permission', optionId: 'answer', answers: {} }
      })
    ).rejects.toMatchObject({ code: 'invalid' })
    expect(requests.isHosted(native.id)).toBe(false)
    requests.close()
  })

  it.each([
    [
      'a link that is not http(s)',
      [{ id: 'go', question: 'Go', kind: 'link', url: 'javascript:alert(1)', options: [] }]
    ],
    ['a choice with no options', [{ id: 'pick', question: 'Pick', kind: 'choice', options: [] }]],
    ['an id that is not a key', [{ id: 'Bad Id!', question: 'Q', kind: 'text', options: [] }]],
    ['an id the prototype owns', [{ id: 'constructor', question: 'Q', kind: 'text', options: [] }]],
    [
      'two questions under one id',
      [
        { id: 'a', question: 'A', options: [] },
        { id: 'a', question: 'B', options: [] }
      ]
    ],
    [
      'options on a text question',
      [{ id: 'a', question: 'A', kind: 'text', options: [{ label: 'x' }, { label: 'y' }] }]
    ]
  ])('refuses to store a question the card could not answer: %s', (_label, questions) => {
    const requests = new PendingRequests()
    expect(() =>
      requests.createHosted({ sessionId: 's1', description: 'D', questions: questions as never })
    ).toThrow()
    expect(requests.snapshot().pending).toHaveLength(0)
    requests.close()
  })

  it('trims what any client sends, so the tool reads what the person meant', async () => {
    const requests = new PendingRequests()
    const request = requests.createHosted(onboarding)
    await requests.resolve({
      requestId: request.id,
      response: {
        type: 'permission',
        optionId: 'answer',
        answers: { email: '  luca@antasphere.com ', login: ' luca-a', projects: [' reb '] }
      }
    })
    expect((await requests.resultAfter(request.id, 's1')).answers).toEqual({
      email: 'luca@antasphere.com',
      login: 'luca-a',
      projects: ['reb']
    })
    requests.close()
  })

  it("a native request carrying the tool's name is still judged by the native rule", async () => {
    const requests = new PendingRequests()
    const native = requests.create({
      sessionId: 's1',
      kind: 'clarification',
      providerRequestId: 'native-2',
      description: 'Which?',
      toolName: INPUT_REQUEST_TOOL,
      options: [{ id: 'answer', label: 'Submit' }],
      questions: [
        {
          id: 'q',
          question: 'Which?',
          kind: 'choice',
          multiSelect: true,
          options: [{ label: 'A' }]
        }
      ]
    })
    await expect(
      requests.resolve({
        requestId: native.id,
        response: { type: 'permission', optionId: 'answer', answers: { q: ['A'] } }
      })
    ).rejects.toMatchObject({ code: 'invalid' })
    requests.close()
  })
})

/* PRDCT-4210: what the person types into the card reaches the form's draft,
   so the agent's read and its own submit see the person's values. */
describe("the person's typing in the form's draft", () => {
  it('the person corrects a field the agent set; the agent submits on their word and approves the correction', async () => {
    const requests = new PendingRequests()
    const request = requests.createHosted(onboarding)
    const updated = vi.fn()
    requests.onUpdated(updated)
    await requests.setAnswers({
      requestId: request.id,
      sessionId: 's1',
      answers: { email: 'luca@antasphere.com', login: 'luca-a' }
    })
    updated.mockClear()
    requests.setDraft({ requestId: request.id, sessionId: 's1', answers: { login: ' luca-b ' } })
    // Nobody is told: the card that typed it shows it already.
    expect(updated).not.toHaveBeenCalled()
    expect(await requests.resultAfter(request.id, 's1')).toEqual({
      requestId: request.id,
      status: 'pending',
      answers: { email: 'luca@antasphere.com', login: 'luca-b' }
    })
    expect([...requests.typedOf(request.id)]).toEqual(['login'])
    const view = await requests.setAnswers({
      requestId: request.id,
      sessionId: 's1',
      answers: {},
      submit: true
    })
    expect(view).toEqual({
      requestId: request.id,
      status: 'completed',
      answers: { email: 'luca@antasphere.com', login: 'luca-b' }
    })
    requests.close()
  })

  it('a field the agent sets again speaks for the agent; an emptied field leaves the draft', async () => {
    const requests = new PendingRequests()
    const request = requests.createHosted(onboarding)
    requests.setDraft({
      requestId: request.id,
      sessionId: 's1',
      answers: { login: 'luca-b', projects: ['reb'] }
    })
    expect([...requests.typedOf(request.id)].sort()).toEqual(['login', 'projects'])
    await requests.setAnswers({
      requestId: request.id,
      sessionId: 's1',
      answers: { login: 'luca-c' }
    })
    expect([...requests.typedOf(request.id)]).toEqual(['projects'])
    requests.setDraft({ requestId: request.id, sessionId: 's1', answers: { projects: [] } })
    expect(requests.draftOf(request.id)).toEqual({ login: 'luca-c' })
    expect([...requests.typedOf(request.id)]).toEqual([])
    requests.close()
  })

  it("the agent's submit judges the person's half-typed value and says it is theirs", async () => {
    const requests = new PendingRequests()
    const request = requests.createHosted(onboarding)
    requests.setDraft({
      requestId: request.id,
      sessionId: 's1',
      answers: { email: 'luca@antasph', login: 'luca-a' }
    })
    await expect(
      requests.setAnswers({ requestId: request.id, sessionId: 's1', answers: {}, submit: true })
    ).rejects.toMatchObject({
      code: 'invalid',
      message: expect.stringMatching(/^"email": .*as the person typed it/)
    })
    expect((await requests.resultAfter(request.id, 's1')).status).toBe('pending')
    requests.close()
  })

  it('is refused on a settled form, another session, a key the form does not ask, or a native request', async () => {
    const requests = new PendingRequests()
    const request = requests.createHosted(onboarding)
    expect(() =>
      requests.setDraft({ requestId: request.id, sessionId: 's2', answers: { login: 'x' } })
    ).toThrow(expect.objectContaining({ code: 'not_found' }))
    expect(() =>
      requests.setDraft({ requestId: request.id, sessionId: 's1', answers: { nope: 'x' } })
    ).toThrow(expect.objectContaining({ code: 'invalid' }))
    expect(() =>
      requests.setDraft({
        requestId: request.id,
        sessionId: 's1',
        answers: JSON.parse('{"__proto__":"x"}')
      })
    ).toThrow(expect.objectContaining({ code: 'invalid' }))
    const native = requests.create({
      sessionId: 's1',
      kind: 'permission',
      providerRequestId: 'n1',
      description: 'Run?',
      options: [{ id: 'allow', label: 'Allow' }]
    })
    expect(() => requests.setDraft({ requestId: native.id, sessionId: 's1', answers: {} })).toThrow(
      expect.objectContaining({ code: 'not_found' })
    )
    await requests.resolve({
      requestId: request.id,
      response: { type: 'permission', optionId: 'deny' }
    })
    expect(() =>
      requests.setDraft({ requestId: request.id, sessionId: 's1', answers: { login: 'x' } })
    ).toThrow(expect.objectContaining({ code: 'closed' }))
    expect(requests.draftOf(request.id)).toEqual({})
    requests.close()
  })
})

describe("a form's defaults are what the card shows (PRDCT-4210, verifier round 2, Minor A)", () => {
  const withDefault = {
    sessionId: 's1',
    description: 'This machine.',
    questions: [
      { id: 'name', question: 'Your name', kind: 'text' as const, options: [] },
      {
        id: 'machine',
        question: 'This machine',
        kind: 'text' as const,
        options: [],
        default: 'mbp'
      }
    ]
  }
  it('the agent reads a default the card shows and its submit approves it', async () => {
    const requests = new PendingRequests()
    const request = requests.createHosted(withDefault)
    expect(await requests.resultAfter(request.id, 's1')).toEqual({
      requestId: request.id,
      status: 'pending',
      answers: { machine: 'mbp' }
    })
    // The draft a late view is handed holds no default: nothing lands as
    // anyone's fill.
    expect(requests.draftOf(request.id)).toEqual({})
    const view = await requests.setAnswers({
      requestId: request.id,
      sessionId: 's1',
      answers: { name: 'Luca' },
      submit: true
    })
    expect(view.answers).toEqual({ name: 'Luca', machine: 'mbp' })
    requests.close()
  })
  it('a default the person emptied stays empty, so the submit asks for it', async () => {
    const requests = new PendingRequests()
    const request = requests.createHosted(withDefault)
    requests.setDraft({
      requestId: request.id,
      sessionId: 's1',
      answers: { name: 'Luca', machine: '' }
    })
    expect((await requests.resultAfter(request.id, 's1')).answers).toEqual({ name: 'Luca' })
    expect(requests.draftOf(request.id)).toEqual({ name: 'Luca', machine: '' })
    await expect(
      requests.setAnswers({ requestId: request.id, sessionId: 's1', answers: {}, submit: true })
    ).rejects.toMatchObject({
      code: 'invalid',
      message: expect.stringMatching(/^"machine" is still unanswered/)
    })
    requests.setDraft({ requestId: request.id, sessionId: 's1', answers: { machine: 'studio' } })
    const view = await requests.setAnswers({
      requestId: request.id,
      sessionId: 's1',
      answers: {},
      submit: true
    })
    expect(view.answers).toEqual({ name: 'Luca', machine: 'studio' })
    requests.close()
  })
})
