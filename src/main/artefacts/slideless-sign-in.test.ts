import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LinksStorage } from './links'
import { createSlidelessAccounts } from './slideless-accounts'
import { SlidelessSettings } from './slideless-settings'
import {
  ADDRESS_FIRST,
  createSlidelessSignIns,
  HUB_ADDRESS,
  NO_CODE_SIGN_IN,
  NO_QUESTION,
  PICK_A_HUB,
  QUESTION_TIMEOUT_MS,
  SIGN_IN_LIFE_MS,
  SIGN_IN_OVER,
  type SlidelessSignIns
} from './slideless-sign-in'
import {
  answer,
  CLOUD,
  DECKS,
  fakeSlideless,
  flush,
  HUB,
  isListing,
  listedProfile,
  listingJson,
  LOCAL,
  type FakeCall,
  type FakeSlideless
} from './slideless.test-support'

/**
 * A site's e-mail code sign-in with no terminal (PRDCT-4266), over a fake
 * copy of the command line that asks its questions on stderr: the start
 * answered when the code is asked, when the command ends first, or after a
 * minute with no question; a question for an address refused; the code
 * written once with its newline; a cancel; one sign-in per site; the kill
 * at ten minutes and at the service's stop; the code in no log, no sentence.
 */
const hubLogin = { kind: 'hub_login', argv: ['slideless', '--profile', 'decks', 'login'] }
const emailCode = { kind: 'email_code', argv: ['slideless', '--profile', 'local', 'login'] }
const pickHub = { kind: 'pick_hub', argv: ['slideless', '--api-url', CLOUD, 'login', '--hub'] }
const SENT =
  'A sign-in code was sent to someone@example.test (if that Antasphere account can receive mail).'
const CODE = '424242'

const memory = (): LinksStorage => {
  let text: string | null = null
  return {
    read: () => text,
    write: (next) => {
      text = next
    }
  }
}

interface Setup {
  signIns: SlidelessSignIns
  slideless: FakeSlideless
  /** The sign-in commands started, in order (the listings left out). */
  started: () => FakeCall[]
}

function setup(profiles: unknown[], logins: unknown[] = []): Setup {
  const slideless = fakeSlideless((args, child) => {
    if (isListing(args)) answer(listingJson(profiles, logins))(child)
    // A sign-in's command is driven by the test.
  })
  const accounts = createSlidelessAccounts({
    cli: slideless.deps.cli,
    run: slideless.run,
    settings: new SlidelessSettings(memory(), () => {})
  })
  let n = 0
  const signIns = createSlidelessSignIns({
    listed: accounts.listed,
    start: slideless.start,
    newId: () => `sign-in-${++n}`
  })
  return {
    signIns,
    slideless,
    started: () => slideless.calls.filter((call) => !isListing(call.args))
  }
}

const refusal = (run: Promise<unknown>): Promise<string> =>
  run.then(
    () => 'no refusal',
    (error: Error) => `${error.name}: ${error.message}`
  )

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('starting a sign-in', () => {
  it('runs the listing’s fix after the global options, answers when the code is asked, then ends on the answer', async () => {
    const s = setup([listedProfile(DECKS, hubLogin)])
    const starting = s.signIns.start(`${DECKS}/`, { email: 'someone@example.test' })
    await flush()
    const [call] = s.started()
    expect(call!.args).toEqual([
      '--api-url',
      DECKS,
      '--json',
      '--profile',
      'decks',
      'login',
      '--email',
      'someone@example.test'
    ])
    // The input is held for the code, never closed at the start.
    expect(call!.child.stdin.ended).toBe(false)
    call!.child.say(`${SENT}\n`)
    call!.child.say('Code: ')
    expect(await starting).toEqual({
      id: 'sign-in-1',
      origin: DECKS,
      phase: 'code_asked',
      email: 'someone@example.test',
      message: SENT
    })
    const answering = s.signIns.answer('sign-in-1', CODE)
    expect(call!.child.stdin.written).toBe(`${CODE}\n`)
    expect(call!.child.stdin.writes).toBe(1)
    expect(call!.child.stdin.ended).toBe(true)
    call!.child.print('{"profile":"decks","via":"login"}')
    call!.child.exit(0)
    expect(await answering).toEqual({
      id: 'sign-in-1',
      origin: DECKS,
      phase: 'done',
      email: 'someone@example.test',
      message: null
    })
    expect(call!.args.join(' ')).not.toContain(CODE)
  })

  it('reads the address the code went to when none was given', async () => {
    const s = setup([listedProfile(CLOUD, pickHub)], [{ hub: HUB, email: null, name: 'hub' }])
    const starting = s.signIns.start(CLOUD, { hub: `${HUB}/` })
    await flush()
    const [call] = s.started()
    expect(call!.args).toEqual([
      '--api-url',
      CLOUD,
      '--json',
      '--api-url',
      CLOUD,
      'login',
      '--hub',
      HUB
    ])
    call!.child.say(`${SENT}\nCode: `)
    expect(await starting).toMatchObject({ phase: 'code_asked', email: 'someone@example.test' })
  })

  it('ends with the command when it ends before any question: done on 0, else its first error line', async () => {
    const s = setup([listedProfile(DECKS, hubLogin), listedProfile(LOCAL, emailCode, 'local')])
    const done = s.signIns.start(DECKS, { email: 'someone@example.test' })
    await flush()
    s.started()[0]!.child.exit(0)
    expect(await done).toMatchObject({ phase: 'done', message: null })
    const failed = s.signIns.start(LOCAL, { email: 'someone@example.test' })
    await flush()
    s.started()[1]!.child.say('Error: this site is not reachable\nmore\n')
    s.started()[1]!.child.exit(1)
    expect(await failed).toMatchObject({
      origin: LOCAL,
      phase: 'failed',
      message: 'this site is not reachable'
    })
  })

  it('kills a command that asks nothing for a minute', async () => {
    vi.useFakeTimers()
    const s = setup([listedProfile(DECKS, hubLogin)])
    const starting = s.signIns.start(DECKS, { email: 'someone@example.test' })
    await flush()
    const [call] = s.started()
    vi.advanceTimersByTime(QUESTION_TIMEOUT_MS - 1)
    expect(call!.child.killedWith).toBeNull()
    vi.advanceTimersByTime(1)
    expect(call!.child.killedWith).toBe('SIGKILL')
    expect(await starting).toMatchObject({ phase: 'failed', message: NO_QUESTION })
  })

  it('kills a command that asks for an address: the address comes first', async () => {
    const s = setup([listedProfile(DECKS, hubLogin), listedProfile(LOCAL, emailCode, 'local')])
    for (const [origin, question] of [
      [DECKS, 'Antasphere email: '],
      [LOCAL, 'Email: ']
    ] as const) {
      const starting = s.signIns.start(origin, {})
      await flush()
      const call = s.started().at(-1)!
      expect(call.args).not.toContain('--email')
      call.child.say(question)
      expect(await starting).toMatchObject({ origin, phase: 'failed', message: ADDRESS_FIRST })
      expect(call.child.killedWith).toBe('SIGKILL')
    }
  })

  it('takes the hub a pick asks for, and the address a pick of a login asks for', async () => {
    const pickLocalLogin = {
      kind: 'pick_login',
      argv: ['slideless', '--api-url', LOCAL, 'login', '--email']
    }
    const s = setup(
      [listedProfile(CLOUD, pickHub), listedProfile(LOCAL, pickLocalLogin, 'local')],
      [{ hub: HUB, email: 'someone@example.test', name: 'hub' }]
    )
    expect(await refusal(s.signIns.start(CLOUD, {}))).toBe(`ArtefactRefusal: ${PICK_A_HUB}`)
    // A hub is an address, never an option of the command.
    expect(await refusal(s.signIns.start(CLOUD, { hub: '--api-key=x' }))).toBe(
      `ArtefactRefusal: ${HUB_ADDRESS}`
    )
    expect(await refusal(s.signIns.start(LOCAL, {}))).toBe(`ArtefactRefusal: ${ADDRESS_FIRST}`)
    expect(s.started()).toEqual([])
    void s.signIns.start(LOCAL, { email: 'someone@example.test' })
    await flush()
    expect(s.started()[0]!.args).toEqual([
      '--api-url',
      LOCAL,
      '--json',
      '--api-url',
      LOCAL,
      'login',
      '--email',
      'someone@example.test'
    ])
    // The machine holds no login at the hub the site needs: the hub the person types.
    void s.signIns.start(CLOUD, { hub: 'https://other.example.test/' })
    await flush()
    expect(s.started()[1]!.args).toEqual([
      '--api-url',
      CLOUD,
      '--json',
      '--api-url',
      CLOUD,
      'login',
      '--hub',
      'https://other.example.test'
    ])
    // With the address the form gives: the command never has to ask for it.
    void s.signIns.start(CLOUD, { hub: HUB, email: 'someone@example.test' })
    await flush()
    expect(s.started()[2]!.args.slice(-4)).toEqual([
      '--hub',
      HUB,
      '--email',
      'someone@example.test'
    ])
    s.signIns.stop()
  })

  it('refuses a fix that names another site than its own row, and starts nothing', async () => {
    const elsewhere = {
      kind: 'hub_login',
      argv: ['slideless', '--api-url', 'https://elsewhere.example.test', 'login']
    }
    const s = setup([listedProfile(CLOUD, elsewhere)])
    expect(await refusal(s.signIns.start(CLOUD, { email: 'someone@example.test' }))).toBe(
      `ArtefactRefusal: ${NO_CODE_SIGN_IN}`
    )
    expect(s.started()).toEqual([])
  })

  it('refuses a site that does not sign in with a code, or is not the machine’s, and starts nothing', async () => {
    const s = setup([
      listedProfile(DECKS),
      listedProfile(LOCAL, { kind: 'paste_key', argv: ['slideless', 'login'] }, 'local')
    ])
    expect(await refusal(s.signIns.start(DECKS, {}))).toBe(`ArtefactRefusal: ${NO_CODE_SIGN_IN}`)
    expect(await refusal(s.signIns.start(LOCAL, {}))).toBe(`ArtefactRefusal: ${NO_CODE_SIGN_IN}`)
    expect(await refusal(s.signIns.start(CLOUD, {}))).toBe(
      `ArtefactRefusal: ${CLOUD} is not one of this machine's Slideless sites.`
    )
    expect(s.started()).toEqual([])
  })
})

describe('answering a sign-in', () => {
  /** A sign-in of DECKS waiting on its code. */
  const asked = async (): Promise<Setup & { call: FakeCall }> => {
    const s = setup([listedProfile(DECKS, hubLogin), listedProfile(LOCAL, emailCode, 'local')])
    const starting = s.signIns.start(DECKS, { email: 'someone@example.test' })
    await flush()
    const call = s.started()[0]!
    call.child.say('Code: ')
    await starting
    return { ...s, call }
  }

  it('writes the code once, even when it is given twice', async () => {
    const { signIns, call } = await asked()
    const first = signIns.answer('sign-in-1', CODE)
    const second = signIns.answer('sign-in-1', CODE)
    expect(call.child.stdin.written).toBe(`${CODE}\n`)
    expect(call.child.stdin.writes).toBe(1)
    call.child.exit(0)
    expect(await first).toMatchObject({ phase: 'done' })
    expect(await second).toMatchObject({ phase: 'done' })
  })

  it('says the command’s first line after the code when it refuses it, never the code, and logs nothing', async () => {
    const said = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')]
    const { signIns, call } = await asked()
    const answering = signIns.answer('sign-in-1', CODE)
    call.child.say('Error: the code is not valid or has expired\n')
    call.child.exit(1)
    const failed = await answering
    expect(failed).toMatchObject({
      phase: 'failed',
      message: 'the code is not valid or has expired'
    })
    expect(JSON.stringify(failed)).not.toContain(CODE)
    for (const spy of said) expect(spy).not.toHaveBeenCalled()
  })

  it('never says the code back, when the command echoes it in its refusal or in why it stopped', async () => {
    const { signIns, call, started } = await asked()
    const answering = signIns.answer('sign-in-1', CODE)
    call.child.say(`Error: the code ${CODE} is not valid or has expired\n`)
    call.child.exit(1)
    const failed = await answering
    expect(failed).toMatchObject({
      phase: 'failed',
      message: 'the code [hidden] is not valid or has expired'
    })
    expect(JSON.stringify(failed)).not.toContain(CODE)
    // A command that fails to run on while the code is in play: its reason without it too.
    const second = signIns.start(LOCAL, { email: 'someone@example.test' })
    await flush()
    const local = started()[1]!
    local.child.say('Code: ')
    await second
    const stopped = signIns.answer('sign-in-2', CODE)
    local.child.emit('error', new Error(`write EPIPE after ${CODE}`))
    expect(await stopped).toMatchObject({ phase: 'failed', message: 'write EPIPE after [hidden]' })
  })

  it('answers an unknown or finished sign-in that it is over', async () => {
    const { signIns, call } = await asked()
    expect(await signIns.answer('nobody', CODE)).toEqual({
      id: 'nobody',
      origin: '',
      phase: 'failed',
      email: null,
      message: SIGN_IN_OVER
    })
    const answering = signIns.answer('sign-in-1', CODE)
    call.child.exit(0)
    await answering
    expect(await signIns.answer('sign-in-1', '999999')).toMatchObject({
      origin: DECKS,
      phase: 'failed',
      message: SIGN_IN_OVER
    })
    expect(call.child.stdin.writes).toBe(1)
  })

  it('cancels: the command is killed, a call waiting hears it, and an answer after is over', async () => {
    const { signIns, call, started } = await asked()
    signIns.cancel('sign-in-1')
    expect(call.child.killedWith).toBe('SIGKILL')
    expect(await signIns.answer('sign-in-1', CODE)).toMatchObject({ message: SIGN_IN_OVER })
    expect(call.child.stdin.written).toBe('')
    // A start still waiting for its question hears the cancel too.
    const starting = signIns.start(LOCAL, { email: 'someone@example.test' })
    await flush()
    signIns.cancel('sign-in-2')
    expect(await starting).toMatchObject({ id: 'sign-in-2', phase: 'cancelled' })
    expect(started()[1]!.child.killedWith).toBe('SIGKILL')
    signIns.cancel('nobody')
  })

  it('runs one sign-in per site: a second start lets go of the first', async () => {
    const { signIns, call, started } = await asked()
    const second = signIns.start(`${DECKS}/`, { email: 'someone@example.test' })
    await flush()
    expect(call.child.killedWith).toBe('SIGKILL')
    expect(await signIns.answer('sign-in-1', CODE)).toMatchObject({
      origin: DECKS,
      message: SIGN_IN_OVER
    })
    started()[1]!.child.say('Code: ')
    expect(await second).toMatchObject({ id: 'sign-in-2', phase: 'code_asked' })
    // Another site's sign-in runs beside it.
    void signIns.start(LOCAL, { email: 'someone@example.test' })
    await flush()
    expect(started()[1]!.child.killedWith).toBeNull()
    signIns.stop()
  })

  it('kills every command after ten minutes, whatever it waits on', async () => {
    vi.useFakeTimers()
    const { signIns, call } = await asked()
    vi.advanceTimersByTime(SIGN_IN_LIFE_MS - 1)
    expect(call.child.killedWith).toBeNull()
    vi.advanceTimersByTime(1)
    expect(call.child.killedWith).toBe('SIGKILL')
    expect(await signIns.answer('sign-in-1', CODE)).toMatchObject({ message: SIGN_IN_OVER })
    expect(call.child.stdin.written).toBe('')
  })

  it('kills every command when the service stops', async () => {
    const { signIns, call, started } = await asked()
    const starting = signIns.start(LOCAL, { email: 'someone@example.test' })
    await flush()
    signIns.stop()
    expect(call.child.killedWith).toBe('SIGKILL')
    expect(started()[1]!.child.killedWith).toBe('SIGKILL')
    expect(await starting).toMatchObject({ phase: 'cancelled' })
  })
})
