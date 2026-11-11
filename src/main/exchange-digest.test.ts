import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The digests on the helpers' runner (PRDCT-4326): what the CLI is asked,
// what is filed, what a failure says. The CLI is a stub.

type Callback = (err: Error | null, stdout: string, stderr: string) => void
const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  calls: [] as Array<{ args: string[]; prompt: string; finish: Callback; done?: boolean }>,
  filed: new Map<string, unknown>(),
  caps: new Map<string, number>(),
  accounts: [] as Array<string | undefined>
}))
vi.mock('electron', () => {
  throw new Error('the exchange digest imported electron')
})
vi.mock('child_process', () => ({ execFile: mocks.execFile }))
vi.mock('./sessions/adapters/pty-backend', () => ({
  getLoginShellEnv: () => ({ PATH: '/bin' }),
  getUserShell: () => '/bin/zsh',
  accountTokenForSpawn: async (_provider: string, accountId?: string) => {
    mocks.accounts.push(accountId)
    return undefined
  }
}))
vi.mock('./launch-profile-manager', () => ({
  launchProfileManager: {
    resolveClaudeCli: () => ({
      id: 'claude',
      name: 'Claude',
      family: 'claude',
      command: ['claude'],
      additionalArgs: []
    })
  }
}))
vi.mock('./shell-launch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./shell-launch')>()),
  findExecutable: (command: string) => command
}))
vi.mock('./ports', () => ({ settingsPorts: () => ({ storage: { pathOf: () => '/dev/null' } }) }))
vi.mock('./exchange-digest-store', () => ({
  DigestStore: class {
    of(): Record<string, unknown> {
      return {}
    }
    get(session: string, key: string): unknown {
      return mocks.filed.get(`${session}|${key}`)
    }
    put(session: string, key: string, value: unknown, cap?: number): void {
      mocks.filed.set(`${session}|${key}`, value)
      if (cap !== undefined) mocks.caps.set(session, cap)
    }
    flush(): void {
      /* nothing buffered */
    }
  }
}))

import {
  UNKNOWN_SESSION_ERROR,
  cancelAll,
  KEY_MISMATCH_ERROR,
  MAX_WAITING_PER_SESSION,
  MAX_WAITING_SPOKEN,
  hostDigests,
  sessionLaunchOf,
  requestDigest,
  requestPageTitle,
  requestSpoken,
  requestWorkDigest
} from './exchange-digest'
import { clipText } from '../shared/helper-prompt'
import { SPOKEN_MARKER, SPOKEN_MAX_CHARS, spokenKey } from '../shared/spoken-rendering'
import { PAGE_TITLE_MARKER, PAGE_TITLE_MESSAGE_CHARS, pageTitleKey } from '../shared/page-title'
import { pageTitleHelper, spokenRenderingHelper } from './helpers/folio'
import { helperCliArgs } from './helpers/runner'
import { exchangeDigestHelper } from './helpers/digests'

const DIGEST_CLI_ARGS = helperCliArgs(exchangeDigestHelper.systemPrompt, exchangeDigestHelper)
import { DIGEST_HELPER_MARKER, clipDigestMessages, digestKey } from '../shared/exchange-digest'
import { WORK_DIGEST_MARKER, clipNotes, workDigestKey } from '../shared/work-digest'
import { resetShutdownForTests } from './helpers/runner'

async function ticks(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve))
}

beforeEach(() => {
  mocks.calls.length = 0
  mocks.accounts.length = 0
  mocks.filed.clear()
  mocks.caps.clear()
  mocks.execFile.mockImplementation(
    (_file: string, args: string[], _opts: unknown, finish: Callback) => {
      const call = { args, prompt: '', finish }
      mocks.calls.push(call)
      return {
        stdin: { write: (text: string) => (call.prompt += text), end: vi.fn(), on: vi.fn() },
        kill: vi.fn(),
        once: vi.fn()
      }
    }
  )
})
afterEach(() => resetShutdownForTests())

describe('the exchange digest on the helpers runner', () => {
  it('asks Haiku, Sonnet behind it, with its own system prompt and the messages as data, and files the answer', async () => {
    expect(DIGEST_CLI_ARGS.slice(0, 5)).toEqual([
      '-p',
      '--model',
      'haiku',
      '--fallback-model',
      'sonnet'
    ])
    const done = requestDigest({
      sessionId: 's1',
      key: 'k1',
      launch: {},
      messages: [
        { from: 'Lane A', text: 'old news' },
        { from: 'Lane B', text: 'Should I merge PR 12?' }
      ]
    })
    await ticks()
    const [call] = mocks.calls
    expect(call.args[call.args.indexOf('--system-prompt') + 1]).toMatch(/not an assistant/)
    expect(call.prompt.startsWith(DIGEST_HELPER_MARKER)).toBe(true)
    expect(call.prompt).toMatch(/<messages>\n[\s\S]*Should I merge PR 12\?[\s\S]*\n<\/messages>/)
    call.finish(null, '{"needs_you": true, "message": 2, "summary": "Lane B asks to merge."}\n', '')
    const result = await done
    expect(result).toEqual({
      ok: true,
      needsYou: true,
      summary: 'Lane B asks to merge.',
      message: 1
    })
    expect(mocks.filed.get('s1|k1')).toEqual(result)
  })

  it('a failure carries its reason and is not filed', async () => {
    const done = requestDigest({
      sessionId: 's2',
      key: 'k2',
      launch: {},
      messages: [{ from: 'x', text: 'y' }]
    })
    await ticks()
    mocks.calls[0].finish(new Error('Command failed'), '', 'Invalid API key · Please run /login')
    await expect(done).resolves.toMatchObject({ ok: false, reason: 'auth' })
    expect(mocks.filed.has('s2|k2')).toBe(false)
  })

  it('the work digest reads its notes as data and puts the note back in the stretch', async () => {
    const notes = Array.from({ length: 45 }, (_, i) => `note ${i}`)
    const done = requestWorkDigest({ sessionId: 's3', key: 'w1', launch: {}, notes, tools: 4 })
    await ticks()
    const [call] = mocks.calls
    expect(call.prompt.startsWith(WORK_DIGEST_MARKER)).toBe(true)
    expect(call.prompt).toMatch(/<notes>\n1\. note 5\n/)
    call.finish(null, '{"title": "Read the notes", "needs_you": true, "note": 2}', '')
    await expect(done).resolves.toEqual({
      ok: true,
      title: 'Read the notes',
      needsYou: true,
      note: 6
    })
  })

  it("the quit's cancel shuts the door for every helper", async () => {
    cancelAll(true)
    await expect(
      requestDigest({
        sessionId: 's4',
        key: 'k4',
        launch: {},
        messages: [{ from: 'x', text: 'y' }]
      })
    ).resolves.toMatchObject({ ok: false, reason: 'cancelled' })
    expect(mocks.calls).toHaveLength(0)
  })
})

describe('Folio’s reads on the helpers runner', () => {
  it('the spoken rendering asks Haiku, Sonnet behind it, the answer as data, and files it under its cap', async () => {
    expect(
      helperCliArgs(spokenRenderingHelper.systemPrompt, spokenRenderingHelper).slice(0, 5)
    ).toEqual(['-p', '--model', 'haiku', '--fallback-model', 'sonnet'])
    const markdown = '# Result\n\n| a | b |\n|---|---|\n| 1 | 2 |'
    const done = requestSpoken({ sessionId: 'f1', key: spokenKey(markdown), launch: {}, markdown })
    await ticks()
    const [call] = mocks.calls
    expect(call.args[call.args.indexOf('--system-prompt') + 1]).toMatch(/spoken by a voice/)
    expect(call.prompt.startsWith(SPOKEN_MARKER)).toBe(true)
    expect(call.prompt).toContain(`<answer>\n${markdown}\n</answer>`)
    call.finish(null, '<spoken>\nResult. Row one: a 1, b 2.\n</spoken>\nNext: nothing.', '')
    await expect(done).resolves.toEqual({ ok: true, text: 'Result. Row one: a 1, b 2.' })
    expect(mocks.filed.get(`f1:spoken|${spokenKey(markdown)}`)).toEqual({
      ok: true,
      text: 'Result. Row one: a 1, b 2.'
    })
    expect(mocks.caps.get('f1:spoken')).toBe(40)
  })

  it('the spoken rendering clips an answer past its bound before the call', async () => {
    const markdown = 'M'.repeat(SPOKEN_MAX_CHARS + 500)
    const done = requestSpoken({ sessionId: 'f2', key: 'k', launch: {}, markdown })
    await ticks()
    expect(mocks.calls[0].prompt).toContain(`${'M'.repeat(SPOKEN_MAX_CHARS)}…`)
    expect(mocks.calls[0].prompt).not.toContain('M'.repeat(SPOKEN_MAX_CHARS + 1))
    mocks.calls[0].finish(null, '<spoken>Long.</spoken>', '')
    await expect(done).resolves.toEqual({ ok: true, text: 'Long.' })
  })

  it('the page title asks Haiku with the message as data, retries an unreadable reply, files under its cap', async () => {
    expect(pageTitleHelper.model).toBe('haiku')
    const message = 'Ok so why does the staging build fail since this morning?'
    const done = requestPageTitle({
      sessionId: 'f3',
      key: pageTitleKey(message),
      launch: {},
      message
    })
    await ticks()
    expect(mocks.calls[0].prompt.startsWith(PAGE_TITLE_MARKER)).toBe(true)
    expect(mocks.calls[0].prompt).toContain(`<message>\n${message}\n</message>`)
    mocks.calls[0].finish(null, 'I think the build fails because of the cache.', '')
    await ticks()
    expect(mocks.calls).toHaveLength(2)
    mocks.calls[1].finish(null, 'Why the staging build fails', '')
    await expect(done).resolves.toEqual({ ok: true, title: 'Why the staging build fails' })
    expect(mocks.filed.get(`f3:title|${pageTitleKey(message)}`)).toMatchObject({ ok: true })
    expect(mocks.caps.get('f3:title')).toBe(200)
  })

  it('refuses an empty answer or message without a call, and a filed one costs none', async () => {
    await expect(
      requestSpoken({ sessionId: 'f4', key: spokenKey(''), launch: {}, markdown: '  ' })
    ).resolves.toMatchObject({ ok: false, reason: 'refused' })
    await expect(
      requestPageTitle({ sessionId: 'f4', key: pageTitleKey(''), launch: {}, message: '' })
    ).resolves.toMatchObject({ ok: false, reason: 'refused' })
    mocks.filed.set('f4:title|t', { ok: true, title: 'Filed' })
    await expect(
      requestPageTitle({ sessionId: 'f4', key: 't', launch: {}, message: 'x' })
    ).resolves.toEqual({ ok: true, title: 'Filed' })
    await ticks()
    expect(mocks.calls).toHaveLength(0)
  })

  it('the same answer asked twice at once is one call', async () => {
    const request = { sessionId: 'f5', key: spokenKey('Twice.'), launch: {}, markdown: 'Twice.' }
    const a = requestSpoken(request)
    const b = requestSpoken(request)
    await ticks()
    expect(mocks.calls).toHaveLength(1)
    mocks.calls[0].finish(null, '<spoken>Twice.</spoken>', '')
    expect(await a).toEqual(await b)
  })
})

describe("the host reads a digest on its own record's launch (PRDCT-4327)", () => {
  const records: Record<string, { claudeProfileId?: string; configDir?: string }> = {
    named: { claudeProfileId: 'server-account-7' },
    plain: {}
  }
  const host = hostDigests((id) => records[id] ?? null)
  // What a client may send: its OWN ids for the tab's launch. Never read.
  const clientLaunch = { launch: { claudeProfileId: 'mac-account-1', configDir: '/mac/home' } }
  const one = [{ from: 'x', text: 'y' }]

  it("a tab on a named account is read on the record's account, not the client's", async () => {
    const done = host.exchangeDigest({
      sessionId: 'named',
      key: digestKey(one),
      messages: one,
      ...clientLaunch
    } as Parameters<typeof host.exchangeDigest>[0])
    await ticks()
    expect(mocks.accounts).toEqual(['server-account-7'])
    mocks.calls[0].finish(
      null,
      '{"needs_you": false, "message": null, "summary": "Nothing for you."}',
      ''
    )
    await expect(done).resolves.toMatchObject({ ok: true, summary: 'Nothing for you.' })
    expect(mocks.filed.get(`named|${digestKey(one)}`)).toMatchObject({ ok: true })
  })

  it('a tab on the Default is read on the machine login, whatever the client sent', async () => {
    const done = host.workDigest({
      sessionId: 'plain',
      key: workDigestKey(['one']),
      notes: ['one'],
      tools: 1,
      ...clientLaunch
    } as Parameters<typeof host.workDigest>[0])
    await ticks()
    expect(mocks.accounts).toEqual([undefined])
    mocks.calls[0].finish(null, '{"title": "One", "needs_you": false, "note": null}', '')
    await expect(done).resolves.toMatchObject({ ok: true, title: 'One' })
    // Filed under the session it was asked for, in its work bucket.
    expect([...mocks.filed.keys()]).toEqual([`plain:work|${workDigestKey(['one'])}`])
  })

  it('a session the host has no record of is refused without a call', async () => {
    await expect(
      host.exchangeDigest({
        sessionId: 'nobody',
        key: digestKey(one),
        messages: one,
        ...clientLaunch
      } as Parameters<typeof host.exchangeDigest>[0])
    ).resolves.toEqual({ ok: false, error: UNKNOWN_SESSION_ERROR, reason: 'unknown-session' })
    await expect(
      host.workDigest({ sessionId: 'nobody', key: workDigestKey(['a']), notes: ['a'], tools: 0 })
    ).resolves.toMatchObject({ ok: false, reason: 'unknown-session' })
    await ticks()
    expect(mocks.calls).toHaveLength(0)
  })

  it('refuses a key that is not the key of what was sent, without a call', async () => {
    await expect(
      host.exchangeDigest({
        sessionId: 'named',
        key: digestKey([{ from: 'x', text: 'z' }]),
        messages: one
      })
    ).resolves.toEqual({ ok: false, error: KEY_MISMATCH_ERROR, reason: 'refused' })
    await expect(
      host.workDigest({ sessionId: 'named', key: workDigestKey(['b']), notes: ['a'], tools: 0 })
    ).resolves.toMatchObject({ ok: false, reason: 'refused' })
    await ticks()
    expect(mocks.calls).toHaveLength(0)
  })

  it('lets a session have at most ten reads waiting; the same read asked twice is one', async () => {
    const asks = Array.from({ length: MAX_WAITING_PER_SESSION }, (_, i) => {
      const messages = [{ from: 'x', text: `cap ${i}` }]
      return host.exchangeDigest({ sessionId: 'named', key: digestKey(messages), messages })
    })
    const again = [{ from: 'x', text: 'cap 0' }]
    const shared = host.exchangeDigest({
      sessionId: 'named',
      key: digestKey(again),
      messages: again
    })
    const extra = [{ from: 'x', text: 'one too many' }]
    await expect(
      host.exchangeDigest({ sessionId: 'named', key: digestKey(extra), messages: extra })
    ).resolves.toMatchObject({ ok: false, reason: 'busy' })
    // Another session is not held back by this one.
    const other = host.workDigest({
      sessionId: 'plain',
      key: workDigestKey(['w']),
      notes: ['w'],
      tools: 0
    })
    // One answer frees one place.
    await ticks()
    const reply = '{"needs_you": false, "message": null, "summary": "Nothing for you."}'
    mocks.calls[0].done = true
    mocks.calls[0].finish(null, reply, '')
    await expect(asks[0]).resolves.toMatchObject({ ok: true })
    await expect(shared).resolves.toMatchObject({ ok: true })
    const next = host.exchangeDigest({ sessionId: 'named', key: digestKey(extra), messages: extra })
    await ticks()
    for (let i = 0; i < 30; i++) {
      for (const call of mocks.calls.filter((c) => !c.done)) {
        call.done = true
        call.finish(
          null,
          call.prompt.includes('<notes>')
            ? '{"title": "W", "needs_you": false, "note": null}'
            : reply,
          ''
        )
      }
      await ticks()
    }
    await expect(next).resolves.toMatchObject({ ok: true })
    await expect(other).resolves.toMatchObject({ ok: true })
    await Promise.all(asks)
  })
})

describe('the host serves Folio’s reads on its own record (PRDCT-4327 terms)', () => {
  const host = hostDigests((id) =>
    id === 'named' ? { claudeProfileId: 'server-account-7' } : id === 'plain' ? {} : null
  )

  it("a spoken rendering is read on the record's account and filed in its bucket", async () => {
    const markdown = 'All green.'
    const done = host.spoken({
      sessionId: 'named',
      key: spokenKey(markdown),
      markdown,
      launch: { claudeProfileId: 'mac-account-1' }
    } as Parameters<typeof host.spoken>[0])
    await ticks()
    expect(mocks.accounts).toEqual(['server-account-7'])
    mocks.calls[0].finish(null, '<spoken>All green.</spoken>', '')
    await expect(done).resolves.toEqual({ ok: true, text: 'All green.' })
    expect([...mocks.filed.keys()]).toEqual([`named:spoken|${spokenKey(markdown)}`])
  })

  it('a page title is read on the machine login for a tab on the Default', async () => {
    const message = 'Why does it fail?'
    const done = host.pageTitle({ sessionId: 'plain', key: pageTitleKey(message), message })
    await ticks()
    expect(mocks.accounts).toEqual([undefined])
    mocks.calls[0].finish(null, 'Why it fails', '')
    await expect(done).resolves.toEqual({ ok: true, title: 'Why it fails' })
    expect([...mocks.filed.keys()]).toEqual([`plain:title|${pageTitleKey(message)}`])
  })

  it('refuses a foreign key and an unknown session without a call', async () => {
    await expect(
      host.spoken({ sessionId: 'named', key: spokenKey('other'), markdown: 'this' })
    ).resolves.toEqual({ ok: false, error: KEY_MISMATCH_ERROR, reason: 'refused' })
    await expect(
      host.pageTitle({ sessionId: 'named', key: pageTitleKey('other'), message: 'this' })
    ).resolves.toMatchObject({ ok: false, reason: 'refused' })
    await expect(
      host.spoken({ sessionId: 'nobody', key: spokenKey('a'), markdown: 'a' })
    ).resolves.toEqual({ ok: false, error: UNKNOWN_SESSION_ERROR, reason: 'unknown-session' })
    await expect(
      host.pageTitle({ sessionId: 'nobody', key: pageTitleKey('a'), message: 'a' })
    ).resolves.toMatchObject({ ok: false, reason: 'unknown-session' })
    await ticks()
    expect(mocks.calls).toHaveLength(0)
  })

  it('clips what it receives before the key check, so an unclipped answer keys as the view keys it', async () => {
    const raw = 'R'.repeat(SPOKEN_MAX_CHARS * 2)
    const key = spokenKey(clipText(raw, SPOKEN_MAX_CHARS))
    const done = host.spoken({ sessionId: 'plain', key, markdown: raw })
    await ticks()
    expect(mocks.calls).toHaveLength(1)
    mocks.calls[0].finish(null, '<spoken>Raw.</spoken>', '')
    await expect(done).resolves.toEqual({ ok: true, text: 'Raw.' })
    const message = 'Q'.repeat(PAGE_TITLE_MESSAGE_CHARS * 3)
    const titled = host.pageTitle({
      sessionId: 'plain',
      key: pageTitleKey(clipText(message, PAGE_TITLE_MESSAGE_CHARS)),
      message
    })
    await ticks()
    expect(mocks.calls).toHaveLength(2)
    mocks.calls[1].finish(null, 'A long question', '')
    await expect(titled).resolves.toEqual({ ok: true, title: 'A long question' })
  })

  /** Answer every call still open until the asks settle. */
  const drain = async (): Promise<void> => {
    for (let i = 0; i < 30; i++) {
      await ticks()
      for (const call of mocks.calls.filter((c) => !c.done)) {
        call.done = true
        call.finish(null, 'Done', '')
      }
    }
  }

  it('keeps a cap per kind of read: ten titles waiting never make a reading busy', async () => {
    const titles = Array.from({ length: MAX_WAITING_PER_SESSION }, (_, i) => {
      const message = `question ${i}`
      return host.pageTitle({ sessionId: 'named', key: pageTitleKey(message), message })
    })
    // An eleventh title waits its turn…
    await expect(
      host.pageTitle({ sessionId: 'named', key: pageTitleKey('eleven'), message: 'eleven' })
    ).resolves.toMatchObject({ ok: false, reason: 'busy' })
    // …but the page read aloud, and a digest, are not held back by the titles.
    const read = host.spoken({ sessionId: 'named', key: spokenKey('read me'), markdown: 'read me' })
    const one = [{ from: 'x', text: 'beside the titles' }]
    const digest = host.exchangeDigest({ sessionId: 'named', key: digestKey(one), messages: one })
    await drain()
    await expect(read).resolves.toMatchObject({ ok: true })
    await expect(digest).resolves.not.toMatchObject({ reason: 'busy' })
    await Promise.all(titles)
  })

  it('lets two spoken renderings wait at once, not a third', async () => {
    expect(MAX_WAITING_SPOKEN).toBe(2)
    const reads = ['first', 'second'].map((markdown) =>
      host.spoken({ sessionId: 'named', key: spokenKey(markdown), markdown })
    )
    await expect(
      host.spoken({ sessionId: 'named', key: spokenKey('third'), markdown: 'third' })
    ).resolves.toMatchObject({ ok: false, reason: 'busy' })
    // Another tab reads aloud all the same.
    const other = host.spoken({ sessionId: 'plain', key: spokenKey('third'), markdown: 'third' })
    await drain()
    await expect(other).resolves.toMatchObject({ ok: true })
    await Promise.all(reads)
  })
})

describe('the launch both servers compose (PRDCT-4327)', () => {
  const source = {
    records: { switched: { claudeProfileId: 'record-account' } } as Record<string, object>,
    spawns: {
      switched: { claudeProfileId: 'old-spawn-account' },
      recordless: { claudeProfileId: 'spawn-account' }
    } as Record<string, object>,
    getSessionRecord(id: string) {
      return this.records[id] ?? null
    },
    spawnLaunchOf(id: string) {
      return this.spawns[id] ?? null
    }
  }
  const launchOf = sessionLaunchOf(source)

  it("reads the record first, then the spawn's launch, then nothing", () => {
    expect(launchOf('switched')).toEqual({ claudeProfileId: 'record-account' })
    expect(launchOf('recordless')).toEqual({ claudeProfileId: 'spawn-account' })
    expect(launchOf('nobody')).toBeNull()
  })

  it('a session known only by its record is read on the record’s account', async () => {
    source.records.cold = { claudeProfileId: 'cold-account' }
    const host = hostDigests(launchOf)
    const messages = [{ from: 'x', text: 'cold' }]
    const done = host.exchangeDigest({ sessionId: 'cold', key: digestKey(messages), messages })
    await ticks()
    expect(mocks.accounts).toEqual(['cold-account'])
    mocks.calls[0].finish(null, '{"needs_you": false, "message": null, "summary": "Cold."}', '')
    await expect(done).resolves.toMatchObject({ ok: true, summary: 'Cold.' })
  })

  it('reads a message of 300,000 characters: the view’s key is the host’s, the model reads the clip', async () => {
    const long = [{ from: 'Lane A', text: 'L'.repeat(300_000) }]
    // What the view sends: the clip, keyed.
    const sent = clipDigestMessages(long).messages
    const host = hostDigests(() => ({}))
    const done = host.exchangeDigest({ sessionId: 'long', key: digestKey(sent), messages: sent })
    await ticks()
    expect(mocks.calls).toHaveLength(1)
    const prompt = mocks.calls[0].prompt
    expect(prompt).toContain(`${'L'.repeat(4_000)}…`)
    expect(prompt).not.toContain('L'.repeat(4_001))
    mocks.calls[0].finish(null, '{"needs_you": false, "message": null, "summary": "Long."}', '')
    await expect(done).resolves.toMatchObject({ ok: true, summary: 'Long.' })
  })

  it('clips what it receives before it checks the key, so an unclipped timeline keys as the view keys it', async () => {
    const raw = Array.from({ length: 33 }, (_, i) => ({
      from: 'Lane B',
      text: `R${i}`.repeat(50_000)
    }))
    const key = digestKey(clipDigestMessages(raw).messages)
    const host = hostDigests(() => ({}))
    const done = host.exchangeDigest({ sessionId: 'raw', key, messages: raw })
    await ticks()
    expect(mocks.calls).toHaveLength(1)
    mocks.calls[0].finish(null, '{"needs_you": true, "message": 1, "summary": "Raw."}', '')
    await expect(done).resolves.toMatchObject({ ok: true, summary: 'Raw.', message: 0 })
  })

  it('clips the notes it receives before it checks the key, so unclipped notes key as the view keys them', async () => {
    const raw = Array.from({ length: 45 }, (_, i) => `N${i} `.repeat(400))
    const key = workDigestKey(clipNotes(raw).notes)
    const host = hostDigests(() => ({}))
    const done = host.workDigest({ sessionId: 'raw-notes', key, notes: raw, tools: 3 })
    await ticks()
    expect(mocks.calls).toHaveLength(1)
    mocks.calls[0].finish(null, '{"title": "Raw notes", "needs_you": false, "note": null}', '')
    await expect(done).resolves.toMatchObject({ ok: true, title: 'Raw notes' })
  })
})
