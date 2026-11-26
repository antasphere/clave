import { describe, expect, it } from 'vitest'
import { CLOUD, DECKS } from '../artefacts/slideless.test-support'
import {
  type ExecResult,
  NO_SITE_CHOSEN,
  PUSH_TIMEOUT_MS,
  PublishFailure,
  type PublishInput,
  SlidelessPublisher,
  VERSIONS_TIMEOUT_MS,
  notInstalled,
  onSeveralSites,
  parseJsonOutput,
  parsePush,
  parseShare,
  pushArgs,
  shareArgs,
  versionsArgs
} from './publisher'
import type { RoutinePublishState } from './store'

/**
 * The Slideless publisher over a fake run of Clave's own copy (PRDCT-4149,
 * PRDCT-4266): the arguments it gives the command, the site first on every
 * one; which site a deck goes to (the record's, the one a look by id finds,
 * the machine's « New links go to »); what it reads back; and every way a push
 * or a share can fail without the run failing with it.
 */

interface Call {
  args: string[]
  options: { cwd: string; timeoutMs: number }
}

/** What a run answers: a finished run, or the refusal of a copy that is not ready. */
type Answer = ExecResult | 'not ready'

const ok = (payload: unknown): ExecResult => ({
  code: 0,
  stdout: JSON.stringify(payload),
  stderr: '',
  timedOut: false
})
const pushed = (id: string, version: number): ExecResult =>
  ok({ presentation: { id }, version: { version } })
const shared = (url: string, id = 'tok-1'): ExecResult => ok({ url, shareToken: { id } })
const refused = (stderr: string, code = 1): ExecResult => ({
  code,
  stdout: '',
  stderr,
  timedOut: false
})
const late: ExecResult = { code: null, stdout: '', stderr: '', timedOut: true }
/** The deck is on the site asked: `versions` answers its list. */
const listed: ExecResult = ok({ versions: [{ version: 1 }] })

interface Harness {
  publisher: SlidelessPublisher
  calls: Call[]
  /** Every run and every write of the record, in the order they happened. */
  events: string[]
  /** What the publisher wrote into the record before its push. */
  saved: RoutinePublishState[]
  logs: Array<{ level: 'info' | 'warn'; message: string }>
  asked: { newLinksSite: number; sites: number }
  input: (state: RoutinePublishState | null) => PublishInput
}

/** A publisher whose runs answer in order, on a machine with these sites and this « New links go to ». */
function publisher(
  answers: Answer[],
  machine: { newLinksSite?: string | null; sites?: string[] | (() => Promise<string[]>) } = {}
): Harness {
  const calls: Call[] = []
  const events: string[] = []
  const saved: RoutinePublishState[] = []
  const logs: Harness['logs'] = []
  const asked = { newLinksSite: 0, sites: 0 }
  const queue = [...answers]
  const sites = machine.sites ?? [DECKS]
  const built = new SlidelessPublisher({
    run: async (args, options) => {
      calls.push({ args, options })
      events.push(`${args[3]} ${args[1]}`)
      const next = queue.shift()
      if (next === undefined) throw new Error(`no canned answer for ${args.join(' ')}`)
      if (next === 'not ready') throw new Error('Slideless is not installed yet')
      return next
    },
    newLinksSite: async () => {
      asked.newLinksSite++
      return machine.newLinksSite === undefined ? DECKS : machine.newLinksSite
    },
    sites: async () => {
      asked.sites++
      return typeof sites === 'function' ? sites() : sites
    },
    log: (level, message) => logs.push({ level, message })
  })
  return {
    publisher: built,
    calls,
    events,
    saved,
    logs,
    asked,
    input: (state) => ({
      folder: '/data/decks/r/run-1',
      title: 'Workspace health',
      shareName: 'Clave routine · Workspace health · Studio',
      state,
      save: (next) => {
        events.push(`save ${next.site}`)
        saved.push(next)
      }
    })
  }
}

const failureOf = async (promise: Promise<unknown>): Promise<PublishFailure> => {
  const failure = await promise.catch((e: unknown) => e)
  expect(failure).toBeInstanceOf(PublishFailure)
  return failure as PublishFailure
}

describe('the command’s arguments, the site first', () => {
  it('creates the deck on a first push and adds a version to it after', () => {
    expect(pushArgs(DECKS, '/f', 'T', null)).toEqual([
      '--api-url',
      DECKS,
      '--json',
      'push',
      '/f',
      '--title',
      'T',
      '--no-open',
      '--new'
    ])
    expect(pushArgs(DECKS, '/f', 'T', 'deck-1')).toEqual([
      '--api-url',
      DECKS,
      '--json',
      'push',
      '/f',
      '--title',
      'T',
      '--no-open',
      '--id',
      'deck-1'
    ])
  })

  it('mints a named link that lets the recipient submit, download and upload nothing', () => {
    expect(shareArgs(CLOUD, 'deck-1', 'Clave routine · X')).toEqual([
      '--api-url',
      CLOUD,
      '--json',
      'share',
      'deck-1',
      '--name',
      'Clave routine · X',
      '--no-forms',
      '--no-download',
      '--no-uploads'
    ])
  })

  it('looks for a deck on one site by its id', () => {
    expect(versionsArgs(CLOUD, 'deck-1')).toEqual([
      '--api-url',
      CLOUD,
      '--json',
      'versions',
      'deck-1'
    ])
  })
})

describe('what the CLI answers', () => {
  it('reads the deck id and the version of a push', () => {
    expect(
      parsePush(JSON.stringify({ presentation: { id: 'd' }, version: { version: 3 } }))
    ).toEqual({ deckId: 'd', version: 3 })
  })

  it('answers null for a push without an id, with a non-integer version, or not in JSON', () => {
    expect(parsePush(JSON.stringify({ presentation: {}, version: { version: 1 } }))).toBeNull()
    expect(
      parsePush(JSON.stringify({ presentation: { id: '' }, version: { version: 1 } }))
    ).toBeNull()
    expect(
      parsePush(JSON.stringify({ presentation: { id: 'd' }, version: { version: 1.5 } }))
    ).toBeNull()
    expect(
      parsePush(JSON.stringify({ presentation: { id: 'd' }, version: { version: '2' } }))
    ).toBeNull()
    expect(parsePush('Pushed version 2')).toBeNull()
    expect(parsePush('')).toBeNull()
  })

  it('finds the JSON object after a line of text', () => {
    expect(parseJsonOutput('Uploading 12 files…\n{"a":1}')).toEqual({ a: 1 })
    expect(
      parsePush('note: logged in as x\n{"presentation":{"id":"d"},"version":{"version":2}}')
    ).toEqual({ deckId: 'd', version: 2 })
    expect(parseJsonOutput('[1,2]')).toBeNull()
  })

  it('reads the URL and the token id of a share, and refuses a URL that is not http', () => {
    expect(
      parseShare(JSON.stringify({ url: 'https://s.example/x', shareToken: { id: 't' } }))
    ).toEqual({ url: 'https://s.example/x', tokenId: 't' })
    expect(
      parseShare(JSON.stringify({ url: 'javascript:alert(1)', shareToken: { id: 't' } }))
    ).toBeNull()
    expect(parseShare(JSON.stringify({ url: 'https://s.example/x', shareToken: {} }))).toBeNull()
    expect(parseShare('not json')).toBeNull()
  })
})

describe('SlidelessPublisher.publish', () => {
  it('creates the deck on the site chosen for new links and mints its one link there, the first time', async () => {
    const h = publisher([pushed('deck-1', 1), shared('https://s.example/1')], {
      newLinksSite: CLOUD
    })
    const outcome = await h.publisher.publish(h.input(null))
    expect(h.calls.map((c) => c.args)).toEqual([
      pushArgs(CLOUD, '/data/decks/r/run-1', 'Workspace health', null),
      shareArgs(CLOUD, 'deck-1', 'Clave routine · Workspace health · Studio')
    ])
    expect(outcome).toEqual({
      deckId: 'deck-1',
      version: 1,
      url: 'https://s.example/1',
      state: {
        deckId: 'deck-1',
        share: { tokenId: 'tok-1', url: 'https://s.example/1' },
        site: CLOUD
      },
      shareError: null
    })
    // No site was looked for, and nothing written before the push.
    expect(h.asked.sites).toBe(0)
    expect(h.saved).toEqual([])
  })

  it('says no site is chosen when there is no record and no « New links go to », and runs nothing', async () => {
    const h = publisher([], { newLinksSite: null })
    const failure = await failureOf(h.publisher.publish(h.input(null)))
    expect(failure.message).toBe(NO_SITE_CHOSEN)
    expect(failure.message).toBe(
      'no site is chosen for new links on this server (Settings › Slideless), so the deck was not pushed'
    )
    expect(h.calls).toEqual([])
  })

  it('adds a version to the kept deck on the site its record names, never the setting’s, and mints no second link', async () => {
    const state = {
      deckId: 'deck-1',
      share: { tokenId: 'tok-1', url: 'https://s.example/1' },
      site: CLOUD
    }
    const h = publisher([pushed('deck-1', 2)], { newLinksSite: DECKS })
    const outcome = await h.publisher.publish(h.input(state))
    expect(h.calls.map((c) => c.args)).toEqual([
      pushArgs(CLOUD, '/data/decks/r/run-1', 'Workspace health', 'deck-1')
    ])
    expect(outcome).toMatchObject({ deckId: 'deck-1', version: 2, url: 'https://s.example/1' })
    expect(outcome.state).toEqual(state)
    expect(h.asked).toEqual({ newLinksSite: 0, sites: 0 })
    expect(h.saved).toEqual([])
  })

  it('names the record’s site in its normal form', async () => {
    const h = publisher([pushed('deck-1', 2)])
    const outcome = await h.publisher.publish(
      h.input({ deckId: 'deck-1', share: null, site: 'HTTPS://Cloud.Example.Test/' })
    )
    expect(h.calls[0]!.args.slice(0, 2)).toEqual(['--api-url', CLOUD])
    expect(outcome.state.site).toBe(CLOUD)
  })

  it('mints a new link when the CLI pushed under another deck than the one asked', async () => {
    const state = {
      deckId: 'deck-1',
      share: { tokenId: 'tok-1', url: 'https://s.example/1' },
      site: DECKS
    }
    const h = publisher([pushed('deck-2', 1), shared('https://s.example/2', 'tok-2')])
    const outcome = await h.publisher.publish(h.input(state))
    expect(h.calls.map((c) => c.args[3])).toEqual(['push', 'share'])
    expect(h.calls[1]!.args).toEqual(
      shareArgs(DECKS, 'deck-2', 'Clave routine · Workspace health · Studio')
    )
    expect(outcome.url).toBe('https://s.example/2')
    expect(outcome.state).toEqual({
      deckId: 'deck-2',
      share: { tokenId: 'tok-2', url: 'https://s.example/2' },
      site: DECKS
    })
  })

  it('says Clave’s Slideless is not installed when the copy is not ready, and runs nothing more', async () => {
    const h = publisher(['not ready'])
    const failure = await failureOf(h.publisher.publish(h.input(null)))
    expect(failure.message).toBe(notInstalled('pushed'))
    expect(failure.message).toBe(
      "Clave's Slideless is not installed on this server, so the deck was not pushed"
    )
    expect(h.calls).toHaveLength(1)
  })

  it('keeps a pushed deck when the copy goes before its share, with the sentence', async () => {
    const h = publisher([pushed('deck-1', 1), 'not ready'])
    const outcome = await h.publisher.publish(h.input(null))
    expect(outcome).toMatchObject({
      deckId: 'deck-1',
      url: null,
      shareError: notInstalled('shared')
    })
    expect(outcome.state).toEqual({ deckId: 'deck-1', share: null, site: DECKS })
  })

  it('carries the command’s Error line on a failed push, over a notice that it is older than its site', async () => {
    const h = publisher([
      refused(
        'Notice: this Slideless is older than the site (0.16.0)\nError: not signed in\n  at x\n',
        2
      )
    ])
    const failure = await failureOf(h.publisher.publish(h.input(null)))
    expect(failure.message).toBe('the deck was not pushed: not signed in')
  })

  it('says the copy did not answer in time when it was stopped', async () => {
    const h = publisher([late])
    const failure = await failureOf(h.publisher.publish(h.input(null)))
    expect(failure.message).toBe('the deck was not pushed: Slideless did not answer in time.')
  })

  it('keeps a pushed deck when the share fails, with no link and the reason', async () => {
    const h = publisher([pushed('deck-1', 1), refused('Error: quota reached\n')])
    const outcome = await h.publisher.publish(h.input(null))
    expect(outcome).toMatchObject({ deckId: 'deck-1', version: 1, url: null })
    expect(outcome.shareError).toBe('the deck was not shared: quota reached')
    expect(outcome.state).toEqual({ deckId: 'deck-1', share: null, site: DECKS })
  })

  it('runs every call from the deck folder, a push and a share at their time', async () => {
    const h = publisher([pushed('deck-1', 1), shared('https://s.example/1')])
    await h.publisher.publish(h.input(null))
    for (const call of h.calls)
      expect(call.options).toEqual({ cwd: '/data/decks/r/run-1', timeoutMs: PUSH_TIMEOUT_MS })
  })
})

describe('a kept deck Slideless no longer has (round 1, Note 2)', () => {
  const state = {
    deckId: 'old',
    share: { tokenId: 'tok-old', url: 'https://s.example/old' },
    site: CLOUD
  }

  it('replaces a kept deck the push is refused under by a new one ON THE SAME SITE, with a new link', async () => {
    const h = publisher(
      [
        refused('Error: not found\n'),
        pushed('new-1', 1),
        shared('https://s.example/new', 'tok-new')
      ],
      { newLinksSite: DECKS }
    )
    const outcome = await h.publisher.publish(h.input(state))
    // The refused push under the old id, the push that makes a deck, the link for it: all on the record's site.
    expect(h.calls.map((c) => c.args)).toEqual([
      pushArgs(CLOUD, '/data/decks/r/run-1', 'Workspace health', 'old'),
      pushArgs(CLOUD, '/data/decks/r/run-1', 'Workspace health', null),
      shareArgs(CLOUD, 'new-1', 'Clave routine · Workspace health · Studio')
    ])
    expect(h.asked.newLinksSite).toBe(0)
    expect(outcome).toEqual({
      deckId: 'new-1',
      version: 1,
      url: 'https://s.example/new',
      state: {
        deckId: 'new-1',
        share: { tokenId: 'tok-new', url: 'https://s.example/new' },
        site: CLOUD
      },
      shareError: null
    })
    // The person can see why the routine changed decks.
    const warnings = h.logs.filter((l) => l.level === 'warn')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.message).toContain('not found')
    expect(warnings[0]!.message).toContain('old')
  })

  it('does not retry a refusal that does not say the deck is gone: the kept link is not orphaned (round 2, Minor 2)', async () => {
    const reset = publisher([refused('fetch failed: ECONNRESET')])
    await expect(reset.publisher.publish(reset.input(state))).rejects.toThrow(/ECONNRESET/)
    expect(reset.calls).toHaveLength(1)
    // The refusal is read where the CLI writes it: a stdout that happens to
    // carry "404" (a deck id) beside a network error is no gone deck (round 4).
    const lookalike = publisher([
      { code: 1, stdout: '{"deck":"k-404-z"}', stderr: 'fetch failed: ECONNRESET', timedOut: false }
    ])
    await expect(lookalike.publisher.publish(lookalike.input(state))).rejects.toThrow(/ECONNRESET/)
    expect(lookalike.calls).toHaveLength(1)
    const signedOut = publisher([refused('unauthorized: sign in first')])
    await expect(signedOut.publisher.publish(signedOut.input(state))).rejects.toThrow(/sign in/)
    expect(signedOut.calls).toHaveLength(1)
  })

  it('does not retry when the copy is not ready or did not answer: one call, then the failure', async () => {
    const missing = publisher(['not ready'])
    await expect(missing.publisher.publish(missing.input(state))).rejects.toThrow(
      notInstalled('pushed')
    )
    expect(missing.calls).toHaveLength(1)

    const silent = publisher([late])
    await expect(silent.publisher.publish(silent.input(state))).rejects.toThrow(
      /did not answer in time/
    )
    expect(silent.calls).toHaveLength(1)
  })

  it('does not retry a first push (no kept deck) that fails', async () => {
    const h = publisher([refused('Error: quota reached', 2)])
    await expect(h.publisher.publish(h.input(null))).rejects.toThrow(/quota reached/)
    expect(h.calls).toHaveLength(1)
  })
})

describe('a deck kept before records named their site: one look by its id (PRDCT-4266)', () => {
  const kept = { deckId: 'deck-1', share: { tokenId: 'tok-1', url: 'https://s.example/1' } }

  it('takes the one site that knows the deck, every site asked in order, and writes it into the record before the push', async () => {
    const h = publisher([listed, refused('Error: not_found'), pushed('deck-1', 4)], {
      sites: [CLOUD, DECKS],
      newLinksSite: DECKS
    })
    const outcome = await h.publisher.publish(h.input(kept))
    expect(h.calls.map((c) => c.args)).toEqual([
      versionsArgs(CLOUD, 'deck-1'),
      versionsArgs(DECKS, 'deck-1'),
      pushArgs(CLOUD, '/data/decks/r/run-1', 'Workspace health', 'deck-1')
    ])
    for (const call of h.calls.slice(0, 2))
      expect(call.options).toEqual({ cwd: '/data/decks/r/run-1', timeoutMs: VERSIONS_TIMEOUT_MS })
    expect(h.events).toEqual([
      `versions ${CLOUD}`,
      `versions ${DECKS}`,
      `save ${CLOUD}`,
      `push ${CLOUD}`
    ])
    expect(h.saved).toEqual([{ ...kept, site: CLOUD }])
    // The same deck: its link is kept, none minted.
    expect(outcome).toMatchObject({ deckId: 'deck-1', version: 4, url: 'https://s.example/1' })
    expect(outcome.state).toEqual({ ...kept, site: CLOUD })
    expect(h.asked.newLinksSite).toBe(0)
  })

  it('keeps the site it found in the record even when the push then fails', async () => {
    const h = publisher([listed, refused('Error: quota reached', 2)], { sites: [CLOUD] })
    const failure = await failureOf(h.publisher.publish(h.input(kept)))
    expect(failure.message).toBe('the deck was not pushed: quota reached')
    expect(h.saved).toEqual([{ ...kept, site: CLOUD }])
  })

  it('takes a deck no site knows for gone: a new deck on the site for new links, nothing written first', async () => {
    const h = publisher(
      [
        refused('Error: not_found'),
        refused('Error: not_found'),
        pushed('new-1', 1),
        shared('https://s.example/new', 'tok-new')
      ],
      { sites: [DECKS, CLOUD], newLinksSite: DECKS }
    )
    const outcome = await h.publisher.publish(h.input(kept))
    expect(h.calls.map((c) => c.args)).toEqual([
      versionsArgs(DECKS, 'deck-1'),
      versionsArgs(CLOUD, 'deck-1'),
      pushArgs(DECKS, '/data/decks/r/run-1', 'Workspace health', null),
      shareArgs(DECKS, 'new-1', 'Clave routine · Workspace health · Studio')
    ])
    expect(h.saved).toEqual([])
    expect(outcome.state).toEqual({
      deckId: 'new-1',
      share: { tokenId: 'tok-new', url: 'https://s.example/new' },
      site: DECKS
    })
    const warnings = h.logs.filter((l) => l.level === 'warn')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.message).toContain('deck-1')
  })

  it('takes a deck for gone on a machine with no saved site, and says so when no site is chosen for new links', async () => {
    const none = publisher([pushed('new-1', 1), shared('https://s.example/new')], { sites: [] })
    expect((await none.publisher.publish(none.input(kept))).state.site).toBe(DECKS)
    const unchosen = publisher([refused('Error: not_found')], {
      sites: [CLOUD],
      newLinksSite: null
    })
    const failure = await failureOf(unchosen.publisher.publish(unchosen.input(kept)))
    expect(failure.message).toBe(NO_SITE_CHOSEN)
    expect(unchosen.calls).toHaveLength(1)
    expect(unchosen.saved).toEqual([])
  })

  it('guesses no site when two know the deck: the failure names them, nothing written, nothing pushed', async () => {
    const h = publisher([listed, listed], { sites: [DECKS, CLOUD] })
    const failure = await failureOf(h.publisher.publish(h.input(kept)))
    expect(failure.message).toBe(onSeveralSites('deck-1', [DECKS, CLOUD]))
    expect(failure.message).toBe(
      "the routine's deck deck-1 is on several sites of this server (https://decks.example.test, https://cloud.example.test); its site was not guessed"
    )
    expect(h.calls.map((c) => c.args[3])).toEqual(['versions', 'versions'])
    expect(h.saved).toEqual([])
  })

  it('asks each site once, in its normal form', async () => {
    const h = publisher([listed, pushed('deck-1', 2)], {
      sites: ['HTTPS://Decks.Example.Test/', DECKS]
    })
    await h.publisher.publish(h.input(kept))
    expect(h.calls.map((c) => c.args)).toEqual([
      versionsArgs(DECKS, 'deck-1'),
      pushArgs(DECKS, '/data/decks/r/run-1', 'Workspace health', 'deck-1')
    ])
    expect(h.saved).toEqual([{ ...kept, site: DECKS }])
  })

  it('takes nothing for gone when the sites cannot be listed: the publish fails, nothing pushed', async () => {
    const h = publisher([], {
      sites: async () => {
        throw new Error('Slideless answered with no listing Clave can read.')
      }
    })
    await expect(h.publisher.publish(h.input(kept))).rejects.toThrow(/no listing/)
    expect(h.calls).toEqual([])
    expect(h.saved).toEqual([])
  })

  it('says Clave’s Slideless is not installed when the copy goes during a look', async () => {
    const h = publisher(['not ready'], { sites: [DECKS, CLOUD] })
    const failure = await failureOf(h.publisher.publish(h.input(kept)))
    expect(failure.message).toBe(notInstalled('pushed'))
    expect(h.calls).toHaveLength(1)
    expect(h.saved).toEqual([])
  })
})
