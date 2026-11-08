import recordedEcho from '../../../../plugins/chat-view/fixtures/echo.json'
import { SessionEventSchema } from '../../../shared/session-model'
import { describe, expect, it } from 'vitest'
import {
  answeredSince,
  emptyConversation,
  openRequests,
  reduceConversation,
  type Conversation,
  type ChatEvent
} from '../../../../plugins/chat-view/src/reducer'
import { visibleEntries } from '../../../../plugins/chat-view/src/tools'
const run = (events: ChatEvent[]): Conversation =>
  events.reduce((state, event) => reduceConversation(state, { event, at: 1 }), emptyConversation)
const elsewhere = (entry: Conversation['entries'][number]): boolean | undefined =>
  entry.kind === 'permission' ? entry.answeredElsewhere : undefined
describe('conversation stream', () => {
  it('renders the recorded echo sequence in order and correlates its tool', () => {
    const state = run(recordedEcho.map((event) => SessionEventSchema.parse(event)))
    expect(state.state).toBe('done')
    expect(state.entries.map((e) => e.kind)).toEqual(['user', 'assistant', 'tool'])
    expect(state.entries[2]).toMatchObject({
      id: recordedEcho[3].id,
      input: { text: 'hello' },
      output: 'hello',
      complete: true
    })
  })
  it('handles every vocabulary event, streaming boundaries and an early tool result', () => {
    let state = run([
      { type: 'session_meta', model: 'fixture', providerSessionId: 'provider-id' },
      { type: 'assistant_text', delta: 'one ', final: false },
      { type: 'assistant_text', delta: 'two', final: false },
      { type: 'assistant_text', delta: '', final: true },
      { type: 'tool_result', id: 'early', output: { ok: true } },
      { type: 'tool_call', id: 'early', name: 'Read', input: '/tmp/file' },
      {
        type: 'permission_request',
        id: 'p',
        description: 'Allow?',
        toolName: 'Write',
        input: {},
        options: [{ id: 'yes', label: 'Allow' }]
      },
      { type: 'provider_event', provider: 'fixture', payload: { raw: true } },
      { type: 'error', message: 'recoverable', fatal: false }
    ])
    expect(state.model).toBe('fixture')
    expect(state.state).toBe('blocked')
    expect(state.entries[0]).toMatchObject({ text: 'one two', final: true })
    expect(state.entries[1]).toMatchObject({ name: 'Read', output: { ok: true }, complete: true })
    state = reduceConversation(state, { answer: 'p', optionId: 'yes' })
    expect(state.entries[2]).toMatchObject({ answer: 'yes' })
    expect(state.state).toBe('working')
    // A provider's own wire event never becomes a transcript entry.
    expect(state.entries.map((e) => e.kind)).toEqual(['assistant', 'tool', 'permission', 'error'])
    expect(reduceConversation(state, { exit: 7 })).toMatchObject({ state: 'ended', exitCode: 7 })
    expect(run([{ type: 'error', message: 'fatal', fatal: true }]).state).toBe('ended')
  })
  it('keeps the effort the provider last reported, null until it says', () => {
    expect(emptyConversation.effort).toBeNull()
    expect(run([]).effort).toBeNull()
    const state = run([
      { type: 'effort', effort: 'high' },
      { type: 'assistant_text', delta: 'hi', final: true }
    ])
    expect(state.effort).toBe('high')
    expect(state.entries.map((e) => e.kind)).toEqual(['assistant'])
    expect(
      reduceConversation(state, { event: { type: 'effort', effort: null }, at: 2 }).effort
    ).toBe(null)
  })
  it('keeps what a user message attached, and adds nothing to one that attached nothing', () => {
    const shot = {
      id: 'shot',
      path: '/pictures/shot.png',
      name: 'shot.png',
      mimeType: 'image/png',
      size: 3,
      delivery: 'image' as const
    }
    const state = run([
      { type: 'user_message', text: '', attachments: [shot] },
      { type: 'user_message', text: 'plain' },
      { type: 'user_message', text: 'empty list', attachments: [] }
    ])
    expect(state.entries[0]).toEqual({
      kind: 'user',
      text: '',
      final: true,
      at: 1,
      attachments: [shot]
    })
    expect(state.entries[1]).toEqual({ kind: 'user', text: 'plain', final: true, at: 1 })
    expect('attachments' in state.entries[2]).toBe(false)
  })
  it('marks a request answered elsewhere when the kernel leaves blocked without this view', () => {
    const request = {
      type: 'permission_request' as const,
      id: 'p',
      description: 'Allow?',
      toolName: 'Write',
      input: {},
      options: [
        { id: 'yes', label: 'Allow' },
        { id: 'no', label: 'Deny' }
      ]
    }
    let state = run([request])
    expect(state.state).toBe('blocked')
    expect(state.entries[0]).toMatchObject({ kind: 'permission' })
    expect(elsewhere(state.entries[0])).toBe(undefined)
    // Another consumer answered: the kernel says working, so the request is no
    // longer outstanding and this view's card must stop offering a click.
    state = reduceConversation(state, { event: { type: 'state_change', state: 'working' } })
    expect(state.state).toBe('working')
    expect(elsewhere(state.entries[0])).toBe(true)
    expect(state.entries[0]).toMatchObject({ kind: 'permission' })
    expect((state.entries[0] as { answer?: string }).answer).toBe(undefined)
  })
  it('keeps a pending request open while the kernel stays blocked, and on ended', () => {
    const request = {
      type: 'permission_request' as const,
      id: 'p',
      description: 'Allow?',
      toolName: 'Write',
      input: {},
      options: [{ id: 'yes', label: 'Allow' }]
    }
    const blocked = reduceConversation(run([request]), {
      event: { type: 'state_change', state: 'blocked' }
    })
    expect(elsewhere(blocked.entries[0])).toBe(undefined)
    const ended = reduceConversation(blocked, { event: { type: 'state_change', state: 'ended' } })
    expect(ended.state).toBe('ended')
    expect(elsewhere(ended.entries[0])).toBe(undefined)
  })
  it('never relabels a request this view answered itself', () => {
    const request = {
      type: 'permission_request' as const,
      id: 'p',
      description: 'Allow?',
      toolName: 'Write',
      input: {},
      options: [{ id: 'yes', label: 'Allow' }]
    }
    let state = reduceConversation(run([request]), { answer: 'p', optionId: 'yes' })
    state = reduceConversation(state, { event: { type: 'state_change', state: 'working' } })
    expect(state.entries[0]).toMatchObject({ answer: 'yes' })
    expect(elsewhere(state.entries[0])).toBe(undefined)
  })
  it('reopens a card it closed when the kernel goes back to blocked', () => {
    const request = {
      type: 'permission_request' as const,
      id: 'p',
      description: 'Allow?',
      toolName: 'Write',
      input: {},
      options: [{ id: 'yes', label: 'Allow' }]
    }
    // Codex emits working on every turn/started, approvals pending or not, and
    // leaves an approval whose turn id is empty in its set: without this, the
    // one request the user must answer would be dead for the session's life.
    let state = reduceConversation(run([request]), {
      event: { type: 'state_change', state: 'working' }
    })
    expect(elsewhere(state.entries[0])).toBe(true)
    state = reduceConversation(state, { event: { type: 'state_change', state: 'blocked' } })
    expect(state.state).toBe('blocked')
    expect(elsewhere(state.entries[0])).toBe(undefined)
    // And the card is answerable again, by this view.
    state = reduceConversation(state, { answer: 'p', optionId: 'yes' })
    expect(state.entries[0]).toMatchObject({ answer: 'yes' })
    expect(state.state).toBe('working')
  })
  it('never reopens a card this view answered itself', () => {
    const request = {
      type: 'permission_request' as const,
      id: 'p',
      description: 'Allow?',
      toolName: 'Write',
      input: {},
      options: [{ id: 'yes', label: 'Allow' }]
    }
    let state = reduceConversation(run([request]), { answer: 'p', optionId: 'yes' })
    state = reduceConversation(state, { event: { type: 'state_change', state: 'blocked' } })
    expect(state.entries[0]).toMatchObject({ answer: 'yes' })
    expect(elsewhere(state.entries[0])).toBe(undefined)
  })
  it('mutes the message whose turn was interrupted and closes the answer as it stands', () => {
    const state = run([
      { type: 'user_message', text: 'first' },
      { type: 'assistant_text', delta: 'done', final: true },
      { type: 'user_message', text: 'count to 400' },
      { type: 'assistant_text', delta: '1\n2\n3', final: false },
      { type: 'turn_interrupted' },
      { type: 'state_change', state: 'done' }
    ])
    expect(state.entries.map((e) => e.kind)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(state.entries[0]).toMatchObject({ text: 'first' })
    expect(state.entries[0]).not.toHaveProperty('interrupted')
    expect(state.entries[2]).toMatchObject({ text: 'count to 400', interrupted: true })
    expect(state.entries[3]).toMatchObject({ text: '1\n2\n3', final: true })
    expect(state.entries.some((e) => e.kind === 'error')).toBe(false)
    expect(state.state).toBe('done')
  })
  it('an interruption with no message to mute changes nothing', () => {
    const state = run([{ type: 'assistant_text', delta: 'hello', final: true }])
    const next = reduceConversation(state, { event: { type: 'turn_interrupted' } })
    expect(next.entries).toEqual(state.entries)
  })
  it('keeps the entries array when a state_change changes nothing in it', () => {
    const state = run([
      { type: 'assistant_text', delta: 'hello', final: true },
      { type: 'tool_call', id: 't', name: 'Read', input: {} }
    ])
    for (const word of ['working', 'done', 'idle', 'blocked', 'ended'] as const) {
      const next = reduceConversation(state, { event: { type: 'state_change', state: word } })
      expect(next.state).toBe(word)
      expect(next.entries).toBe(state.entries)
    }
  })
  it('lets this view answer a second request while the first was answered elsewhere', () => {
    const make = (id: string): ChatEvent => ({
      type: 'permission_request' as const,
      id,
      description: 'Allow?',
      toolName: 'Write',
      input: {},
      options: [{ id: 'yes', label: 'Allow' }]
    })
    let state = run([make('one')])
    state = reduceConversation(state, { event: { type: 'state_change', state: 'working' } })
    state = reduceConversation(state, { event: make('two') })
    expect(state.state).toBe('blocked')
    state = reduceConversation(state, { answer: 'two', optionId: 'yes' })
    // Nothing is outstanding any more: the one answered elsewhere does not hold
    // the conversation on blocked.
    expect(state.state).toBe('working')
    expect(state.entries[0]).toMatchObject({ answeredElsewhere: true })
    expect(state.entries[1]).toMatchObject({ answer: 'yes' })
  })
  it('puts a page of the past in front without moving a key already given', () => {
    const past: ChatEvent[] = [
      { type: 'user_message', text: 'old question' },
      { type: 'tool_call', id: 't', name: 'Read', input: {} },
      { type: 'tool_result', id: 't', output: 'ok' },
      { type: 'assistant_text', delta: 'old answer', final: true }
    ]
    const live = run([{ type: 'user_message', text: 'new question' }])
    const keyOf = (c: Conversation, text: string): number =>
      c.first + c.entries.findIndex((e) => e.kind === 'user' && e.text === text)
    const before = keyOf(live, 'new question')
    const merged = reduceConversation(live, {
      prepend: past.map((event, i) => ({ event, at: 100 + i }))
    })
    // The same entries as reading the whole conversation in order, each of
    // the past dated by its transcript line, and the live one keeps its key.
    const whole = run([...past, { type: 'user_message', text: 'new question' }])
    const undated = (c: Conversation): unknown[] => c.entries.map((e) => ({ ...e, at: 0 }))
    expect(undated(merged)).toEqual(undated(whole))
    expect(merged.entries.map((e) => e.at)).toEqual([100, 101, 103, 1])
    expect(keyOf(merged, 'new question')).toBe(before)
    expect(merged.first).toBe(live.first - 3)
    expect(reduceConversation(merged, { prepend: [] })).toBe(merged)
  })
})

describe('a request the agent no longer holds', () => {
  const ask = (id: string): ChatEvent => ({
    type: 'permission_request',
    id,
    description: 'Run a command?',
    toolName: 'Bash',
    input: { command: `echo ${id}` },
    options: [
      { id: 'allow-once', label: 'Allow once' },
      { id: 'deny', label: 'Deny' }
    ]
  })
  const blocked: ChatEvent = { type: 'state_change', state: 'blocked' }
  const working: ChatEvent = { type: 'state_change', state: 'working' }
  const done: ChatEvent = { type: 'state_change', state: 'done' }
  const withdrawn = (id: string): ChatEvent => ({ type: 'permission_withdrawn', id })
  // The dock's own filter, as the views read it: what the reader can still answer.
  const waiting = (state: Conversation): string[] =>
    state.entries.flatMap((e) =>
      e.kind === 'permission' && !e.answer && !e.answeredElsewhere ? [e.request.id] : []
    )

  it('keeps a request the adapter withdrew out of the queue when the next one puts the view back on blocked', () => {
    // The adapter withdraws the old request and leaves blocked; the next
    // request puts the view back on blocked. The old card must not come back
    // ahead of the live one: an answer to it would only be refused.
    const state = run([ask('old'), blocked, withdrawn('old'), working, ask('current'), blocked])
    expect(waiting(state)).toEqual(['current'])
    expect(elsewhere(state.entries[0])).toBe(true)
    expect(state.state).toBe('blocked')
    // The views read the same list through the reducer's own helper.
    expect(openRequests(state.entries).map((r) => r.id)).toEqual(['current'])
    // Answering the live one leaves nothing waiting: the old card never held
    // the conversation on blocked.
    const answered = reduceConversation(state, { answer: 'current', optionId: 'allow-once' })
    expect(answered.state).toBe('working')
    expect(waiting(answered)).toEqual([])
  })
  it('settles a withdrawn request through every later state word, and only that request', () => {
    const both = run([ask('a'), ask('b'), blocked, withdrawn('a')])
    expect(waiting(both)).toEqual(['b'])
    expect(both.state).toBe('blocked')
    const later = run([
      ask('a'),
      blocked,
      withdrawn('a'),
      done,
      ask('b'),
      blocked,
      working,
      blocked
    ])
    expect(waiting(later)).toEqual(['b'])
    // A request this view answered is left as answered.
    const mine = reduceConversation(run([ask('a'), blocked]), { answer: 'a', optionId: 'deny' })
    expect(reduceConversation(mine, { event: withdrawn('a') }).entries[0]).toMatchObject({
      answer: 'deny'
    })
  })
  it('leaves a withdrawal naming another request alone, and keeps the entries array', () => {
    const state = run([ask('p'), blocked])
    const other = reduceConversation(state, { event: withdrawn('someone-else') })
    expect(other.entries).toBe(state.entries)
    expect(waiting(other)).toEqual(['p'])
  })
  it('retires a card whose answer the host refused as gone, without an answer', () => {
    const state = run([ask('gone'), blocked, ask('live')])
    const retired = reduceConversation(state, { retire: 'gone' })
    expect(waiting(retired)).toEqual(['live'])
    expect(retired.entries[0]).toMatchObject({ kind: 'permission', answeredElsewhere: true })
    expect((retired.entries[0] as { answer?: string }).answer).toBe(undefined)
    // The kernel's word is the state: nothing here changes it.
    expect(retired.state).toBe('blocked')
    // A later blocked does not bring the card back; an id nothing waits on
    // changes nothing.
    expect(waiting(reduceConversation(retired, { event: blocked }))).toEqual(['live'])
    expect(reduceConversation(retired, { retire: 'nothing' })).toBe(retired)
    expect(reduceConversation(retired, { retire: 'gone' })).toBe(retired)
  })
  it('still reopens a card closed on working or done when blocked follows, as Codex needs', () => {
    // Codex says working at every turn start, approvals pending or not, and
    // keeps an approval without a turn id past the turn's end: a card closed
    // on those words alone comes back on blocked. Only the adapter's own
    // withdrawal, or a refused answer, settles a card for good.
    expect(waiting(run([ask('p'), blocked, working, blocked]))).toEqual(['p'])
    expect(waiting(run([ask('p'), blocked, done, blocked]))).toEqual(['p'])
  })
})

describe('taking a message back', () => {
  const withdraw = (state: Conversation): Conversation =>
    reduceConversation(state, { withdraw: true })
  const shown = (state: Conversation): string[] =>
    visibleEntries(state.entries)
      .filter((e) => e.kind === 'user')
      .map((e) => e.text)

  it('withdraws a message nothing has answered yet', () => {
    const state = withdraw(run([{ type: 'user_message', text: 'go' }]))
    expect(answeredSince(state.entries)).toBe(false)
    expect(shown(state)).toEqual([])
    // The stop that follows leaves it withdrawn.
    expect(shown(reduceConversation(state, { event: { type: 'turn_interrupted' } }))).toEqual([])
  })

  it('keeps a message the agent had begun to answer', () => {
    const started = run([
      { type: 'user_message', text: 'go' },
      { type: 'assistant_text', delta: 'Looking', final: false }
    ])
    expect(answeredSince(started.entries)).toBe(true)
    expect(shown(withdraw(started))).toEqual(['go'])
    const tool = run([
      { type: 'user_message', text: 'go' },
      { type: 'tool_call', id: 't', name: 'Read', input: {} }
    ])
    expect(shown(withdraw(tool))).toEqual(['go'])
    // An empty opening frame is no answer.
    const empty = run([
      { type: 'user_message', text: 'go' },
      { type: 'assistant_text', delta: '', final: false }
    ])
    expect(shown(withdraw(empty))).toEqual([])
  })

  it('shows a withdrawn message again when its answer arrives after all', () => {
    const late = reduceConversation(withdraw(run([{ type: 'user_message', text: 'go' }])), {
      event: { type: 'assistant_text', delta: 'Already on it', final: false },
      at: 2
    })
    expect(shown(late)).toEqual(['go'])
  })

  it('a form the agent asked lives across the turn, follows its writes, and folds its approve into the record', () => {
    const form: ChatEvent = {
      type: 'permission_request',
      id: 'clave:1',
      description: 'Four things before this machine is set up.',
      toolName: 'clave_request_input',
      input: { tool: 'clave_request_input', layout: 'steps' },
      options: [
        { id: 'answer', label: 'Approve' },
        { id: 'deny', label: 'Skip' }
      ],
      questions: [
        { id: 'login', question: 'Your GitHub login', kind: 'github-login', options: [] },
        { id: 'name', question: 'The machine name', kind: 'text', options: [] }
      ]
    }
    // The kernel's turn ends with the form open: the card stays live, where
    // a provider's own question would read as answered elsewhere.
    const open = run([form, { type: 'state_change', state: 'done' }])
    expect(elsewhere(open.entries[0])).toBeUndefined()
    expect(openRequests(open.entries).map((r) => r.id)).toEqual(['clave:1'])
    // The agent set a field from what the reader said: the card's draft.
    const drafted = reduceConversation(open, {
      event: { type: 'permission_updated', id: 'clave:1', answers: { login: 'luca-a' } },
      at: 2
    })
    expect(drafted.entries[0]).toMatchObject({ draft: { login: 'luca-a' } })
    expect(drafted.entries[0]).not.toHaveProperty('answer')
    // The approve, written to the agent as the reader's message, draws no
    // bubble: the record row says it. Every view is handed the answers.
    const message = [
      '[The form "Four things before this machine is set up." was approved by the person]',
      'Your GitHub login: luca-a',
      '(form clave:35e6218e-85f6-4dc0-9b19-366bf927d351 · request r1: clave_input_result reads it, clave_input_set revises a field)'
    ].join('\n')
    const approved = run([
      ...[{ ...form, id: 'clave:35e6218e-85f6-4dc0-9b19-366bf927d351' }],
      {
        type: 'permission_updated',
        id: 'clave:35e6218e-85f6-4dc0-9b19-366bf927d351',
        answers: { login: 'luca-a', name: 'mbp' },
        sent: true
      },
      { type: 'permission_withdrawn', id: 'clave:35e6218e-85f6-4dc0-9b19-366bf927d351' },
      { type: 'user_message', text: message, form: 'clave:35e6218e-85f6-4dc0-9b19-366bf927d351' },
      { type: 'state_change', state: 'working' }
    ])
    // A message that carries the flag without saying so in its text is a
    // message of the person like any other.
    const faked = run([{ type: 'user_message', text: 'hello', form: 'clave:1' }])
    expect(faked.entries.map((e) => e.kind)).toEqual(['user'])
    expect(approved.entries.map((e) => e.kind)).toEqual(['permission'])
    expect(approved.entries[0]).toMatchObject({
      answer: 'answer',
      answers: { login: 'luca-a', name: 'mbp' }
    })
    expect(approved.entries[0]).not.toHaveProperty('revised')
    // A later correction on the approved form: the row reads revised; the
    // same values again do not.
    const id = 'clave:35e6218e-85f6-4dc0-9b19-366bf927d351'
    const revised = reduceConversation(approved, {
      event: { type: 'permission_updated', id, answers: { name: 'studio' }, sent: true },
      at: 3
    })
    expect(revised.entries[0]).toMatchObject({
      answers: { login: 'luca-a', name: 'studio' },
      revised: true
    })
    const same = reduceConversation(approved, {
      event: { type: 'permission_updated', id, answers: { name: 'mbp' }, sent: true },
      at: 3
    })
    expect(same.entries[0]).not.toHaveProperty('revised')
    // An empty value clears the answer, as the server dropped it.
    const cleared = reduceConversation(approved, {
      event: { type: 'permission_updated', id, answers: { name: '' }, sent: true },
      at: 3
    })
    expect((cleared.entries[0] as { answers?: object }).answers).toEqual({ login: 'luca-a' })
    // An update naming no entry changes nothing.
    expect(
      reduceConversation(approved, {
        event: { type: 'permission_updated', id: 'nope', answers: { a: 'b' } },
        at: 3
      })
    ).toBe(approved)
  })

  it('a form that settled is drawn where it stood, at the end, and the entry it left behind is not drawn', () => {
    const id = 'clave:35e6218e-85f6-4dc0-9b19-366bf927d351'
    const form: ChatEvent = {
      type: 'permission_request',
      id,
      description: 'One thing.',
      toolName: 'clave_request_input',
      input: { tool: 'clave_request_input', layout: 'form' },
      options: [
        { id: 'answer', label: 'Approve' },
        { id: 'deny', label: 'Skip' }
      ],
      questions: [{ id: 'login', question: 'Your GitHub login', kind: 'github-login', options: [] }]
    }
    const open = run([
      form,
      { type: 'state_change', state: 'done' },
      { type: 'user_message', text: 'I am luca-a' },
      { type: 'assistant_text', delta: 'Set.', final: true }
    ])
    expect(open.entries.map((e) => e.kind)).toEqual(['permission', 'user', 'assistant'])
    // The reader approves: the record goes to the end, the old place is kept
    // for the rows' keys and filtered out of what is drawn.
    const approved = reduceConversation(open, {
      answer: id,
      optionId: 'answer',
      answers: { login: 'luca-a' }
    })
    expect(approved.entries.map((e) => e.kind)).toEqual([
      'permission',
      'user',
      'assistant',
      'permission'
    ])
    expect(approved.entries[0]).toMatchObject({ relocated: true, answer: 'answer' })
    expect(approved.entries[3]).toMatchObject({ answer: 'answer', answers: { login: 'luca-a' } })
    expect(approved.entries[3]).not.toHaveProperty('relocated')
    expect(visibleEntries(approved.entries).map((e) => e.kind)).toEqual([
      'user',
      'assistant',
      'permission'
    ])
    expect(openRequests(approved.entries)).toEqual([])
    // The agent's own approve, told by the server, lands the same way; a
    // note under a field stands until the field changes.
    const noted = reduceConversation(open, {
      event: {
        type: 'permission_updated',
        id,
        answers: {},
        notes: { login: 'I did not catch a login' }
      },
      at: 2
    })
    expect(noted.entries[0]).toMatchObject({ notes: { login: 'I did not catch a login' } })
    const filled = reduceConversation(noted, {
      event: { type: 'permission_updated', id, answers: { login: 'luca-a' } },
      at: 3
    })
    expect(filled.entries[0]).not.toHaveProperty('notes')
    const sent = reduceConversation(filled, {
      event: { type: 'permission_updated', id, answers: { login: 'luca-a' }, sent: true },
      at: 4
    })
    expect(sent.entries.map((e) => e.kind)).toEqual([
      'permission',
      'user',
      'assistant',
      'permission'
    ])
    expect(visibleEntries(sent.entries).map((e) => e.kind)).toEqual([
      'user',
      'assistant',
      'permission'
    ])
    // A form that is already the last entry stays where it is.
    const alone = reduceConversation(run([form]), { answer: id, optionId: 'deny' })
    expect(alone.entries).toHaveLength(1)
  })

  it('never touches an earlier, answered message', () => {
    const state = withdraw(
      run([
        { type: 'user_message', text: 'first' },
        { type: 'assistant_text', delta: 'Done.', final: true },
        { type: 'user_message', text: 'second' }
      ])
    )
    expect(shown(state)).toEqual(['first'])
  })
})
