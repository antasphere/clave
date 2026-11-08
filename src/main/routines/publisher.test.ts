import { describe, expect, it } from 'vitest'
import {
  type ExecLike,
  type ExecResult,
  INSTALL_HINT,
  PublishFailure,
  SlidelessPublisher,
  parseJsonOutput,
  parsePush,
  parseShare,
  pushArgs,
  shareArgs
} from './publisher'

/**
 * The Slideless publisher over a fake `exec` (PRDCT-4149): the arguments it
 * gives the CLI, what it reads back, and every way a push or a share can fail
 * without the run failing with it.
 */

interface Call {
  file: string
  args: string[]
  options: Parameters<ExecLike>[2]
}

/** An exec that records its calls and answers the canned results in order. */
function fakeExec(answers: ExecResult[]): { exec: ExecLike; calls: Call[] } {
  const calls: Call[] = []
  const queue = [...answers]
  const exec: ExecLike = async (file, args, options) => {
    calls.push({ file, args, options })
    const next = queue.shift()
    if (!next) throw new Error(`no canned answer for ${args.join(' ')}`)
    return next
  }
  return { exec, calls }
}

const ok = (payload: unknown): ExecResult => ({
  code: 0,
  stdout: JSON.stringify(payload),
  stderr: ''
})
const pushed = (id: string, version: number): ExecResult =>
  ok({ presentation: { id }, version: { version } })
const shared = (url: string, id = 'tok-1'): ExecResult => ok({ url, shareToken: { id } })

const ENV = { PATH: '/opt/slideless/bin', HOME: '/Users/server' }

function publisher(answers: ExecResult[]): { publisher: SlidelessPublisher; calls: Call[] } {
  const { exec, calls } = fakeExec(answers)
  return { publisher: new SlidelessPublisher({ env: async () => ENV, exec }), calls }
}

const input = {
  folder: '/data/decks/r/run-1',
  title: 'Workspace health',
  shareName: 'Clave routine · Workspace health · Studio'
}

describe('the CLI arguments', () => {
  it('creates the deck on a first push and adds a version to it after', () => {
    const first = pushArgs('/f', 'T', null)
    expect(first).toContain('--new')
    expect(first).not.toContain('--id')
    const later = pushArgs('/f', 'T', 'deck-1')
    expect(later).not.toContain('--new')
    expect(later.slice(later.indexOf('--id'), later.indexOf('--id') + 2)).toEqual([
      '--id',
      'deck-1'
    ])
    for (const args of [first, later]) {
      expect(args.slice(0, 2)).toEqual(['push', '/f'])
      expect(args.slice(args.indexOf('--title'), args.indexOf('--title') + 2)).toEqual([
        '--title',
        'T'
      ])
      expect(args).toContain('--no-open')
      expect(args).toContain('--json')
    }
  })

  it('mints a named link that lets the recipient submit, download and upload nothing', () => {
    const args = shareArgs('deck-1', 'Clave routine · X')
    expect(args.slice(0, 2)).toEqual(['share', 'deck-1'])
    expect(args.slice(args.indexOf('--name'), args.indexOf('--name') + 2)).toEqual([
      '--name',
      'Clave routine · X'
    ])
    for (const flag of ['--no-forms', '--no-download', '--no-uploads', '--json'])
      expect(args).toContain(flag)
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
  it('creates the deck and mints its one link on the first run', async () => {
    const { publisher: p, calls } = publisher([pushed('deck-1', 1), shared('https://s.example/1')])
    const outcome = await p.publish({ ...input, state: null })
    expect(calls.map((c) => c.args[0])).toEqual(['push', 'share'])
    expect(calls[0].args).toContain('--new')
    expect(calls[1].args.slice(0, 2)).toEqual(['share', 'deck-1'])
    expect(outcome).toEqual({
      deckId: 'deck-1',
      version: 1,
      url: 'https://s.example/1',
      state: { deckId: 'deck-1', share: { tokenId: 'tok-1', url: 'https://s.example/1' } },
      shareError: null
    })
  })

  it('adds a version to the kept deck and mints no second link', async () => {
    const state = { deckId: 'deck-1', share: { tokenId: 'tok-1', url: 'https://s.example/1' } }
    const { publisher: p, calls } = publisher([pushed('deck-1', 2)])
    const outcome = await p.publish({ ...input, state })
    expect(calls).toHaveLength(1)
    expect(calls[0].args).toContain('--id')
    expect(calls[0].args).toContain('deck-1')
    expect(calls[0].args).not.toContain('--new')
    expect(outcome).toMatchObject({ deckId: 'deck-1', version: 2, url: 'https://s.example/1' })
    expect(outcome.state).toEqual(state)
  })

  it('mints a new link when the CLI pushed under another deck than the one asked', async () => {
    const state = { deckId: 'deck-1', share: { tokenId: 'tok-1', url: 'https://s.example/1' } }
    const { publisher: p, calls } = publisher([
      pushed('deck-2', 1),
      shared('https://s.example/2', 'tok-2')
    ])
    const outcome = await p.publish({ ...input, state })
    expect(calls.map((c) => c.args[0])).toEqual(['push', 'share'])
    expect(calls[1].args[1]).toBe('deck-2')
    expect(outcome.url).toBe('https://s.example/2')
    expect(outcome.state).toEqual({
      deckId: 'deck-2',
      share: { tokenId: 'tok-2', url: 'https://s.example/2' }
    })
  })

  it('says how to install the CLI when it is not on the path', async () => {
    const { publisher: p } = publisher([{ code: 1, stdout: '', stderr: '', errorCode: 'ENOENT' }])
    const failure = await p.publish({ ...input, state: null }).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(PublishFailure)
    expect((failure as PublishFailure).message).toContain(INSTALL_HINT)
    expect((failure as PublishFailure).message).toContain('team tools install slideless')
  })

  it('carries the first line of the CLI error on a failed push', async () => {
    const { publisher: p } = publisher([
      { code: 2, stdout: '', stderr: '\nError: not signed in\n  at x\n' }
    ])
    const failure = await p.publish({ ...input, state: null }).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(PublishFailure)
    expect((failure as PublishFailure).message).toContain('Error: not signed in')
    expect((failure as PublishFailure).message).not.toContain('at x')
  })

  it('says the CLI did not answer in time when it was stopped', async () => {
    const { publisher: p } = publisher([{ code: null, stdout: '', stderr: '' }])
    await expect(p.publish({ ...input, state: null })).rejects.toThrow(/did not answer in time/)
  })

  it('keeps a pushed deck when the share fails, with no link and the reason', async () => {
    const { publisher: p } = publisher([
      pushed('deck-1', 1),
      { code: 1, stdout: '', stderr: 'quota reached' }
    ])
    const outcome = await p.publish({ ...input, state: null })
    expect(outcome).toMatchObject({ deckId: 'deck-1', version: 1, url: null })
    expect(outcome.shareError).toContain('quota reached')
    expect(outcome.state).toEqual({ deckId: 'deck-1', share: null })
  })

  it('runs the CLI in the environment it is given, from the deck folder', async () => {
    const { publisher: p, calls } = publisher([pushed('deck-1', 1), shared('https://s.example/1')])
    await p.publish({ ...input, state: null })
    for (const call of calls) {
      expect(call.file).toBe('slideless')
      expect(call.options.env).toEqual(ENV)
      expect(call.options.cwd).toBe(input.folder)
    }
  })
})
