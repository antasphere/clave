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
      { id: 'answer', label: 'Send' },
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

  it('belongs to its session alone and is cancelled with the turn or the session', async () => {
    const requests = new PendingRequests()
    const request = requests.createHosted(onboarding)
    await expect(requests.resultAfter(request.id, 'another')).rejects.toMatchObject({
      code: 'not_found'
    })
    const settled = vi.fn()
    requests.onSettled(settled)
    requests.cancelNative('s1')
    expect((await requests.resultAfter(request.id, 's1')).status).toBe('cancelled')
    expect(settled).toHaveBeenCalledTimes(1)
    const next = requests.createHosted(onboarding)
    requests.cancelSession('s1')
    expect((await requests.resultAfter(next.id, 's1')).status).toBe('cancelled')
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
})
