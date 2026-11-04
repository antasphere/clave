import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { foldEvents, parseLine } from './claude'
import {
  emptyLedger,
  emptyTally,
  groupView,
  sessionView,
  workspaceView,
  type Ledger,
  type PublishedDeck,
  type ScopeView,
  type SessionRow,
  type Tally
} from './ledger'
import { loadPrices } from './prices'
import {
  ENV_COMMAND,
  ENV_MARK,
  MESSAGES,
  TIMEOUT_TEXT,
  assembleDeck,
  cachedLoginEnv,
  cleanTokens,
  fileKey,
  forgetLoginEnv,
  loginShellEnv,
  mergePaths,
  nextOrdinal,
  parseEnv0,
  parseMarkedEnv,
  parsePush,
  parseWhoami,
  publishDeck,
  pushArgs,
  redactView,
  slidelessRunner,
  type CliResult,
  type CliRunner,
  type ExecLike,
  type PublishRequest
} from './publish'
import { newCursor } from './reader'

const fixture = readFileSync(join(__dirname, 'fixtures', 'session.jsonl'), 'utf8')
const template = readFileSync(join(__dirname, '..', 'page', 'index.html'), 'utf8')
const prices = loadPrices(join(__dirname, '..', 'prices.json'), null)
const NOW = new Date('2026-11-04T15:00:00.000Z')

const CSS = [
  ':root { --ink: #111; }',
  '/* a comment that names </style> once */',
  '.deck { color: var(--ink); }'
].join('\n')
const JS = 'const closing = "</script>"\nconsole.log(closing)'

function tally(): Tally {
  return foldEvents(fixture.split('\n').map(parseLine), emptyTally())
}

function session(id: string, name: string, createdAt: number): SessionRow {
  return {
    id,
    provider: 'claude',
    providerSessionId: `conv-${id}`,
    cwd: '/work/secret-folder',
    name,
    model: null,
    state: 'idle',
    group: { id: 'g1', name: 'Theme work' },
    workspaceId: 'ws-1',
    createdAt,
    seenAt: '2026-11-04T10:00:00.000Z',
    root: { tally: tally(), file: { ...newCursor(`/x/${id}.jsonl`), offset: 10 } },
    subagents: [],
    stateSpans: []
  }
}

/** Two sessions in the group `Theme work`, the newer one with an `Explore` subagent. */
function ledger(): Ledger {
  const l = emptyLedger(15, NOW)
  const a = session('sa', 'Session a', 2)
  a.subagents.push({
    id: 'agent-1',
    type: 'Explore',
    description: 'Find the reads',
    model: null,
    finished: true,
    tally: tally(),
    file: newCursor('/x/agent-1.jsonl')
  })
  l.sessions['sa'] = a
  l.sessions['sb'] = session('sb', 'Session b', 1)
  return l
}

function theGroup(): ScopeView {
  return groupView(ledger(), 'g1', prices, 'all', NOW)
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function dataBlock(html: string): ScopeView {
  const m = /<script type="application\/json" id="slideless-data">([\s\S]*?)<\/script>/.exec(html)
  expect(m).not.toBeNull()
  return JSON.parse(m![1]!) as ScopeView
}

function count(text: string, part: string): number {
  return text.split(part).length - 1
}

describe('redactView', () => {
  it('names the sessions by their order, keeps the rest, and shares the aliases with live', () => {
    const group = theGroup()
    expect(group.rows.map((r) => r.id)).toEqual(['sa', 'sb'])
    const workspace = workspaceView(ledger(), 'ws-1', prices, 'all', NOW)
    expect(workspace.live.map((s) => s.id)).toEqual(['sa', 'sb'])
    // The live list in the other order: an alias of its own would make its first `Session 1`.
    const mixed: ScopeView = { ...group, live: [...workspace.live].reverse() }
    const before = JSON.stringify(mixed)

    const out = redactView(mixed, false)
    const expected = clone(mixed)
    expected.rows[0]!.name = 'Session 1'
    expected.rows[1]!.name = 'Session 2'
    expected.live[0]!.name = 'Session 2'
    expected.live[1]!.name = 'Session 1'
    expected.header.folder = null
    expect(out).toEqual(expected)
    expect(out.name).toBe('Theme work')
    expect(out.rows[0]!.children[0]).toMatchObject({
      kind: 'subagent',
      type: 'Explore',
      description: 'Find the reads',
      name: 'Explore'
    })
    expect(out.figures).toEqual(group.figures)
    expect(JSON.stringify(mixed)).toBe(before)

    expect(redactView(mixed, true)).toEqual(mixed)
    expect(JSON.stringify(mixed)).toBe(before)
  })

  it('aliases the live sessions of a workspace view', () => {
    const workspace = workspaceView(ledger(), 'ws-1', prices, 'all', NOW)
    const out = redactView(workspace, false)
    expect(out.live.map((s) => s.name)).toEqual(['Session 1', 'Session 2'])
    expect(out.live.map((s) => s.groupName)).toEqual(['Theme work', 'Theme work'])
    expect(out.cards).toEqual(workspace.cards)
    expect(workspace.live.map((s) => s.name)).toEqual(['Session a', 'Session b'])
  })

  it('drops the folder of a session view and names the session itself', () => {
    const view = sessionView(ledger(), 'sa', prices)!
    expect(view.header.folder).toBe('secret-folder')
    const before = JSON.stringify(view)
    const out = redactView(view, false)
    expect(out.header.folder).toBeNull()
    expect(out.name).toBe('Session 1')
    expect(out.rows.map((r) => r.name)).toEqual(['Session 1', 'Explore'])
    expect(out.figures).toEqual(view.figures)
    expect(JSON.stringify(view)).toBe(before)
    expect(redactView(view, true)).toEqual(view)
  })
})

describe('cleanTokens', () => {
  it('keeps the token entries a style block can carry and drops the rest', () => {
    expect(
      cleanTokens({
        '--surface-0': '#fff',
        '--ink': '  #000 ',
        color: 'red',
        [`--${'a'.repeat(65)}`]: '#111',
        '--brace': 'a}b',
        '--open': 'a{b',
        '--semi': 'red; color: blue',
        '--tag': 'x<y',
        '--comment': 'a/*b',
        '--number': 12
      })
    ).toEqual({ '--surface-0': '#fff', '--ink': '#000' })
    expect(cleanTokens(null)).toEqual({})
    expect(cleanTokens(['--a'])).toEqual({})
  })

  it('stops at 600 entries', () => {
    const many: Record<string, string> = {}
    for (let i = 0; i < 650; i++) many[`--t${i}`] = `#${i}`
    const out = cleanTokens(many)
    expect(Object.keys(out)).toHaveLength(600)
    expect(out['--t599']).toBe('#599')
    expect(out['--t600']).toBeUndefined()
  })
})

describe('assembleDeck', () => {
  const input = (): Parameters<typeof assembleDeck>[0] => ({
    template,
    css: CSS,
    js: JS,
    data: theGroup(),
    theme: 'coffee',
    tokens: { '--surface-0': '#fff', bad: 'x', '--y': 'a}b' },
    title: 'Theme work · Analytics'
  })

  it('inlines the stylesheet and the script, writes the tokens, and sets the deck mode', () => {
    const view = theGroup()
    const html = assembleDeck({ ...input(), data: view })
    expect(html).not.toContain('<link rel="stylesheet"')
    expect(html).not.toContain('<script src=')
    expect(html).toContain('<style>\n:root { --ink: #111; }')
    expect(html).toContain('.deck { color: var(--ink); }')
    expect(html).toContain(':root {\n  --surface-0: #fff;\n}')
    expect(html).not.toContain('bad: x')
    expect(html).not.toContain('a}b')
    expect(html).toContain('<meta name="analytics-mode" content="deck" />')
    expect(html).toContain('<meta name="analytics-events" content="" />')
    expect(html).toContain('<html lang="en" data-theme="coffee">')
    expect(dataBlock(html)).toEqual(view)
    expect(count(html, '</script>')).toBe(2)
    expect(html).toContain('"<\\/script>"')
    expect(count(html, '</style>')).toBe(1)
    expect(html).toContain('<\\/style')
  })

  it('refuses a template whose stylesheet link moved', () => {
    const changed = template.replace('<link rel="stylesheet" href="{{base}}assets/deck.css" />', '')
    expect(changed).not.toBe(template)
    expect(() => assembleDeck({ ...input(), template: changed })).toThrow(/template changed/)
  })
})

describe('pushArgs', () => {
  const deck: PublishedDeck = {
    deckId: 'deck-7',
    baseUrl: 'https://share.antasphere.com',
    url: 'https://share.antasphere.com/p/deck-7',
    version: 1,
    n: 1,
    at: '2026-11-04T15:00:00.000Z',
    title: 'Theme · Analytics',
    names: false
  }

  it('makes a new deck with its title the first time', () => {
    expect(pushArgs('/data/decks/group-g1', 'Theme · Analytics', null)).toEqual([
      'push',
      '/data/decks/group-g1',
      '--json',
      '--no-open',
      '--title',
      'Theme · Analytics',
      '--new'
    ])
  })

  it('pushes a new version of the deck on record without its title', () => {
    expect(pushArgs('/data/decks/group-g1', 'Theme · Analytics', deck)).toEqual([
      'push',
      '/data/decks/group-g1',
      '--json',
      '--no-open',
      '--id',
      'deck-7'
    ])
  })

  it('keeps a folder with a space as one argument', () => {
    const args = pushArgs('/Users/x/My data/decks/group-g1', 'T', null)
    expect(args[1]).toBe('/Users/x/My data/decks/group-g1')
    expect(args).toHaveLength(7)
  })
})

describe('parsePush', () => {
  const url = 'https://share.antasphere.com/p/deck-7'

  it('reads the deck id, the version and the URL of the CLI answer', () => {
    expect(
      parsePush(
        JSON.stringify({ presentation: { id: 'deck-7', title: 'x' }, version: { version: 3 }, url })
      )
    ).toEqual({ deckId: 'deck-7', version: 3, url, baseUrl: 'https://share.antasphere.com' })
  })

  it('answers null for an answer it cannot read', () => {
    expect(parsePush(JSON.stringify({ presentation: {}, version: { version: 3 }, url }))).toBeNull()
    expect(
      parsePush(JSON.stringify({ presentation: { id: 'deck-7' }, version: { version: '3' }, url }))
    ).toBeNull()
    expect(
      parsePush(
        JSON.stringify({
          presentation: { id: 'deck-7' },
          version: { version: 3 },
          url: 'not a url'
        })
      )
    ).toBeNull()
    expect(parsePush('not json')).toBeNull()
  })
})

describe('the login shell environment', () => {
  it('parses env -0 output and merges path lists in order', () => {
    expect(parseEnv0('A=1\0B=x=y\0junk\0')).toEqual({ A: '1', B: 'x=y' })
    expect(mergePaths('/own/bin:/usr/bin', '/login/bin:/usr/bin:')).toBe(
      '/own/bin:/usr/bin:/login/bin'
    )
  })

  it('takes the login shell environment with the plugin path first', async () => {
    const calls: { file: string; args: string[]; killSignal: string | undefined }[] = []
    const exec: ExecLike = (file, args, options, callback) => {
      calls.push({ file, args, killSignal: options.killSignal })
      callback(
        null,
        `${ENV_MARK}PATH=/login/bin:/usr/bin\0HOME=/Users/x\0SLIDELESS_PROFILE=share\0`,
        ''
      )
      return undefined
    }
    const env = await loginShellEnv(exec, {
      PATH: '/own/bin:/usr/bin',
      HOME: '/Users/x',
      TMPDIR: '/tmp/t'
    })
    expect(calls).toEqual([
      { file: '/bin/zsh', args: ['-lic', ENV_COMMAND], killSignal: 'SIGKILL' }
    ])
    expect(ENV_COMMAND).toBe(`printf '%s' '${ENV_MARK}'; env -0`)
    expect(env).toEqual({
      PATH: '/own/bin:/usr/bin:/login/bin',
      HOME: '/Users/x',
      TMPDIR: '/tmp/t',
      SLIDELESS_PROFILE: 'share'
    })
  })

  it('drops what a chatty profile prints before the mark, and takes nothing without it', async () => {
    const chatty: ExecLike = (_file, _args, _options, callback) => {
      callback(null, `Welcome, a line from .zshrc\n${ENV_MARK}PATH=/login/bin\0HOME=/Users/x\0`, '')
      return undefined
    }
    const env = await loginShellEnv(chatty, { PATH: '/own/bin:/usr/bin', HOME: '/Users/x' })
    expect(env['PATH']).toBe('/own/bin:/usr/bin:/login/bin')
    expect(Object.keys(env).some((key) => key.includes('\n'))).toBe(false)
    expect(parseMarkedEnv('no mark at all\nPATH=/x\0')).toEqual({})
    const unmarked: ExecLike = (_file, _args, _options, callback) => {
      callback(null, 'PATH=/login/bin\0', '')
      return undefined
    }
    const bare = await loginShellEnv(unmarked, { PATH: '/own/bin', HOME: '/Users/x' })
    expect(bare['PATH']).toBe('/own/bin')
  })

  it('resolves the shell once per process and again after it was forgotten', async () => {
    let runs = 0
    const exec: ExecLike = (_file, _args, _options, callback) => {
      runs++
      callback(null, `${ENV_MARK}PATH=/login/bin\0`, '')
      return undefined
    }
    forgetLoginEnv()
    const first = await cachedLoginEnv(exec, { PATH: '/own/bin' })
    const second = await cachedLoginEnv(exec, { PATH: '/own/bin' })
    expect(runs).toBe(1)
    expect(second).toBe(first)
    forgetLoginEnv()
    await cachedLoginEnv(exec, { PATH: '/own/bin' })
    expect(runs).toBe(2)
    forgetLoginEnv()
  })

  it('keeps the plugin path when the shell fails', async () => {
    const exec: ExecLike = (_file, _args, _options, callback) => {
      callback(new Error('zsh failed'), '', '')
      return undefined
    }
    const env = await loginShellEnv(exec, { PATH: '/own/bin:/usr/bin', HOME: '/Users/x' })
    expect(env['PATH']).toBe('/own/bin:/usr/bin')
    expect(env['HOME']).toBe('/Users/x')
  })
})

describe('slidelessRunner', () => {
  type Answer = {
    error: (Error & { code?: string | number }) | null
    stdout: string
    stderr: string
  }
  const calls: {
    file: string
    args: string[]
    env: Record<string, string>
    killSignal: string | undefined
    timeout: number
  }[] = []
  const execAnswering =
    (answer: Answer): ExecLike =>
    (file, args, options, callback) => {
      calls.push({
        file,
        args,
        env: options.env,
        killSignal: options.killSignal,
        timeout: options.timeout
      })
      callback(answer.error, answer.stdout, answer.stderr)
      return undefined
    }
  const env = { PATH: '/own/bin', HOME: '/Users/x' }
  const args = ['push', '/Users/x/My data/decks/group-g1', '--json']

  beforeEach(() => {
    calls.length = 0
  })

  it('runs slideless with the arguments as a list and the env given, killed at its deadline', async () => {
    const run = slidelessRunner(env, execAnswering({ error: null, stdout: '{}', stderr: 'w' }))
    expect(await run(args)).toEqual({ ok: true, stdout: '{}', stderr: 'w' })
    expect(calls).toEqual([
      { file: 'slideless', args, env, killSignal: 'SIGKILL', timeout: 120_000 }
    ])
    expect(calls[0]!.args[1]).toBe('/Users/x/My data/decks/group-g1')
  })

  it('says a missing binary apart from a failure', async () => {
    const missing = Object.assign(new Error('spawn slideless ENOENT'), { code: 'ENOENT' })
    expect(
      await slidelessRunner(env, execAnswering({ error: missing, stdout: '', stderr: '' }))(args)
    ).toMatchObject({ ok: false, missing: true })
    const failed = Object.assign(new Error('Command failed'), { code: 2 })
    expect(
      await slidelessRunner(
        env,
        execAnswering({ error: failed, stdout: '', stderr: '  Error: refused \n' })
      )(args)
    ).toEqual({ ok: false, missing: false, code: 2, stderr: 'Error: refused' })
    expect(calls[1]!.args).toEqual(args)
  })

  it('says a CLI stopped at its deadline in words, never its command line', async () => {
    const killed = Object.assign(new Error('Command failed: slideless push /Users/x/My data'), {
      code: null as unknown as number,
      killed: true
    })
    const run = slidelessRunner(env, execAnswering({ error: killed, stdout: '', stderr: '' }))
    const result = await run(args)
    expect(result).toEqual({ ok: false, missing: false, code: null, stderr: TIMEOUT_TEXT })
    const silent = Object.assign(new Error('Command failed: slideless push /Users/x/My data'), {
      code: 3
    })
    expect(
      await slidelessRunner(env, execAnswering({ error: silent, stdout: '', stderr: '' }))(args)
    ).toEqual({ ok: false, missing: false, code: 3, stderr: 'the CLI exited with code 3' })
  })
})

describe('publishDeck', () => {
  const URL_7 = 'https://share.antasphere.com/p/deck-7'
  const AUTH =
    'An API key is required. Sign in (`slideless login`), pass --api-key, or set SLIDELESS_API_KEY.'
  let root: string
  let dir: string
  let pageDir: string
  let calls: string[][]

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'analytics-publish-'))
    dir = join(root, 'data')
    pageDir = join(root, 'page')
    mkdirSync(dir)
    mkdirSync(pageDir)
    writeFileSync(join(pageDir, 'index.html'), template)
    writeFileSync(join(pageDir, 'deck.css'), CSS)
    writeFileSync(join(pageDir, 'deck.js'), JS)
    calls = []
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const ok = (stdout: string): CliResult => ({ ok: true, stdout, stderr: '' })
  const fail = (stderr: string): CliResult => ({ ok: false, missing: false, code: 1, stderr })
  const pushed = (version: number): CliResult =>
    ok(
      JSON.stringify({
        presentation: { id: 'deck-7', title: 'Theme work · Analytics' },
        version: { version },
        url: URL_7
      })
    )

  /** A runner answering `whoami` and `push` with the results given, recording every call. */
  function runner(whoami: CliResult, push: CliResult = pushed(1)): CliRunner {
    return async (args) => {
      calls.push(args)
      return args[0] === 'whoami' ? whoami : push
    }
  }
  const signedIn = (): CliResult => ok('{"user":{"email":"x"}}')

  function request(names = false): PublishRequest {
    return {
      key: 'group:g1',
      range: 'all',
      names,
      theme: 'coffee',
      tokens: { '--surface-0': '#f5f1eb' },
      data: theGroup()
    }
  }

  const firstDeck: PublishedDeck = {
    deckId: 'deck-7',
    baseUrl: 'https://share.antasphere.com',
    url: URL_7,
    version: 1,
    n: 1,
    at: '2026-11-04T15:00:00.000Z',
    title: 'Theme work · Analytics',
    names: false,
    by: 'x'
  }

  const publish = (
    run: CliRunner,
    existing: PublishedDeck | null = null,
    names = false
  ): ReturnType<typeof publishDeck> =>
    publishDeck({ dir, pageDir, request: request(names), existing, run, now: () => NOW })

  it('stops at a missing CLI before writing anything, and forgets the login environment', async () => {
    let forgotten = 0
    const outcome = await publishDeck({
      dir,
      pageDir,
      request: request(),
      existing: null,
      run: runner({ ok: false, missing: true, code: null, stderr: 'spawn slideless ENOENT' }),
      now: () => NOW,
      forget: () => forgotten++
    })
    expect(outcome).toEqual({ ok: false, kind: 'missing', message: MESSAGES.missing })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual(['whoami', '--json'])
    expect(existsSync(join(dir, 'decks'))).toBe(false)
    expect(existsSync(join(dir, 'published'))).toBe(false)
    expect(forgotten).toBe(1)
    // A CLI that answered whoami and went missing at the push forgets it too.
    let gone = 0
    const atPush: CliRunner = async (args) =>
      args[0] === 'whoami'
        ? signedIn()
        : { ok: false, missing: true, code: null, stderr: 'spawn slideless ENOENT' }
    const later = await publishDeck({
      dir,
      pageDir,
      request: request(),
      existing: null,
      run: atPush,
      now: () => NOW,
      forget: () => gone++
    })
    expect(later).toMatchObject({ ok: false, kind: 'missing' })
    expect(gone).toBe(1)
  })

  it('stops at a CLI that is not signed in', async () => {
    const outcome = await publish(runner(fail(AUTH)))
    expect(outcome).toEqual({ ok: false, kind: 'auth', message: MESSAGES.auth })
    expect(calls).toHaveLength(1)
    expect(existsSync(join(dir, 'decks'))).toBe(false)
  })

  it('stops at a Slideless it cannot reach', async () => {
    const outcome = await publish(runner(fail('TypeError: fetch failed')))
    expect(outcome.ok).toBe(false)
    expect(outcome).toMatchObject({ kind: 'failed' })
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.message.startsWith('Slideless could not be reached:')).toBe(true)
    expect(outcome.message).toBe('Slideless could not be reached: TypeError: fetch failed.')
    expect(calls).toHaveLength(1)
  })

  it('publishes a new deck, redacted, and keeps what it pushed', async () => {
    const outcome = await publish(runner(signedIn(), pushed(1)))
    expect(outcome).toEqual({ ok: true, deck: firstDeck })
    const folder = join(dir, 'decks', 'group-g1')
    expect(calls).toHaveLength(2)
    expect(calls[1]).toEqual(pushArgs(folder, 'Theme work · Analytics', null))

    const html = readFileSync(join(folder, 'index.html'), 'utf8')
    expect(html).toContain('content="deck"')
    expect(html).toContain('data-theme="coffee"')
    expect(html).toContain('--surface-0: #f5f1eb;')
    expect(html).not.toContain('Session a')
    expect(html).not.toContain('Session b')
    expect(dataBlock(html).rows.map((r) => r.name)).toEqual(['Session 1', 'Session 2'])

    const snapshot = JSON.parse(
      readFileSync(join(dir, 'published', 'group-g1-1.json'), 'utf8')
    ) as { data: ScopeView }
    const data = redactView(theGroup(), false)
    expect(snapshot).toEqual({
      v: 1,
      scope: 'group:g1',
      deck: 'deck-7',
      version: 1,
      url: URL_7,
      at: '2026-11-04T15:00:00.000Z',
      by: 'x',
      names: false,
      theme: 'coffee',
      range: 'all',
      data
    })
    expect(snapshot.data.rows[0]!.name).toBe('Session 1')
    expect(snapshot.data.name).toBe('Theme work')
  })

  it('carries nothing of its own publish record into the deck or the snapshot', async () => {
    const view = { ...theGroup(), published: { ...firstDeck, by: 'romain@example.test' } }
    const outcome = await publishDeck({
      dir,
      pageDir,
      request: { ...request(), data: view },
      existing: firstDeck,
      run: runner(signedIn(), pushed(2)),
      now: () => NOW
    })
    expect(outcome.ok).toBe(true)
    const html = readFileSync(join(dir, 'decks', 'group-g1', 'index.html'), 'utf8')
    expect(html).not.toContain('romain@example.test')
    expect(html).not.toContain('deck-7')
    expect(dataBlock(html).published).toBeNull()
    const snapshot = JSON.parse(
      readFileSync(join(dir, 'published', 'group-g1-2.json'), 'utf8')
    ) as { by: string | null; data: ScopeView }
    expect(snapshot.data.published).toBeNull()
    expect(snapshot.by).toBe('x')
  })

  it('publishes a new version of the deck on record and keeps its title', async () => {
    const existing: PublishedDeck = { ...firstDeck, title: 'Renamed by Romain' }
    const outcome = await publish(runner(signedIn(), pushed(2)), existing)
    expect(calls[1]).toEqual([
      'push',
      join(dir, 'decks', 'group-g1'),
      '--json',
      '--no-open',
      '--id',
      'deck-7'
    ])
    expect(calls[1]).not.toContain('--title')
    expect(outcome).toEqual({
      ok: true,
      deck: { ...firstDeck, version: 2, n: 2, title: 'Renamed by Romain' }
    })
    expect(existsSync(join(dir, 'published', 'group-g1-2.json'))).toBe(true)
    expect(existsSync(join(dir, 'published', 'group-g1-1.json'))).toBe(false)
  })

  it('says a deck gone from Slideless only when there was one on record', async () => {
    const stderr = 'Error: not_found: no presentation deck-7'
    expect(await publish(runner(signedIn(), fail(stderr)), firstDeck)).toEqual({
      ok: false,
      kind: 'failed',
      gone: true,
      message: MESSAGES.gone
    })
    const fresh = await publish(runner(signedIn(), fail(stderr)))
    if (fresh.ok) throw new Error('the push should have failed')
    expect(fresh.kind).toBe('failed')
    expect(fresh.gone).toBeUndefined()
    expect(fresh.message.startsWith('Slideless refused the push:')).toBe(true)
  })

  it('records nothing when the CLI answer has no deck in it', async () => {
    const outcome = await publish(runner(signedIn(), ok('not json')))
    expect(outcome).toEqual({ ok: false, kind: 'failed', message: MESSAGES.unreadable })
    expect(existsSync(join(dir, 'published'))).toBe(false)
  })

  it('keeps the real names when asked', async () => {
    const outcome = await publish(runner(signedIn(), pushed(1)), null, true)
    expect(outcome).toEqual({ ok: true, deck: { ...firstDeck, names: true } })
    const html = readFileSync(join(dir, 'decks', 'group-g1', 'index.html'), 'utf8')
    expect(html).toContain('Session a')
    expect(html).toContain('Session b')
    const snapshot = JSON.parse(
      readFileSync(join(dir, 'published', 'group-g1-1.json'), 'utf8')
    ) as { names: boolean; data: ScopeView }
    expect(snapshot.names).toBe(true)
    expect(snapshot.data.rows.map((r) => r.name)).toEqual(['Session a', 'Session b'])
  })

  it('removes the CLI link file of an earlier push', async () => {
    const folder = join(dir, 'decks', 'group-g1')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, '.slideless.json'), '{"id":"deck-old"}')
    await publish(runner(signedIn(), pushed(1)))
    expect(existsSync(join(folder, '.slideless.json'))).toBe(false)
    expect(existsSync(join(folder, 'index.html'))).toBe(true)
  })

  it('names the folders and files after the scope key, a long one cut and hashed', () => {
    expect(fileKey('workspace:-')).toBe('workspace--')
    expect(fileKey('session:tab 1')).toBe('session-tab-1')
    expect(fileKey('group:g1')).toBe('group-g1')
    const long = fileKey(`workspace:${'x'.repeat(300)}`)
    expect(long.length).toBeLessThanOrEqual(96)
    expect(long.startsWith(`workspace-${'x'.repeat(70)}`)).toBe(true)
    expect(long).toMatch(/-[0-9a-f]{8}$/)
    expect(fileKey(`workspace:${'x'.repeat(300)}`)).toBe(long)
    expect(fileKey(`workspace:${'y'.repeat(300)}`)).not.toBe(long)
  })

  it('numbers a snapshot past the highest on disk or on record, so none is overwritten', () => {
    const published = join(dir, 'published')
    expect(
      nextOrdinal(
        {
          readdirSync: () => {
            throw new Error('ENOENT')
          }
        },
        published,
        'group-g1'
      )
    ).toBe(1)
    const names = [
      'group-g1-1.json',
      'group-g1-2.json',
      'group-g2-9.json',
      'group-g1-x.json',
      'other'
    ]
    expect(nextOrdinal({ readdirSync: () => names as never }, published, 'group-g1')).toBe(3)
    expect(nextOrdinal({ readdirSync: () => names as never }, published, 'group-g2')).toBe(10)
    expect(parseWhoami('{"user":{"email":"a@b"}}')).toBe('a@b')
    expect(parseWhoami('{}')).toBeNull()
    expect(parseWhoami('not json')).toBeNull()
  })

  it('makes a new deck after one was reported gone without overwriting the snapshots', async () => {
    mkdirSync(join(dir, 'published'), { recursive: true })
    writeFileSync(join(dir, 'published', 'group-g1-1.json'), '{"v":1,"first":true}')
    writeFileSync(join(dir, 'published', 'group-g1-2.json'), '{"v":1}')
    const outcome = await publish(runner(signedIn(), pushed(1)))
    expect(outcome).toEqual({ ok: true, deck: { ...firstDeck, n: 3 } })
    expect(calls[1]).toContain('--new')
    expect(readFileSync(join(dir, 'published', 'group-g1-1.json'), 'utf8')).toBe(
      '{"v":1,"first":true}'
    )
    expect(existsSync(join(dir, 'published', 'group-g1-3.json'))).toBe(true)
  })

  it('titles a session deck after the redaction when the names stay out', async () => {
    const view = sessionView(ledger(), 'sa', prices)!
    const names = publishDeck({
      dir,
      pageDir,
      request: { ...request(true), key: 'session:sa', data: view },
      existing: null,
      run: runner(signedIn(), pushed(1)),
      now: () => NOW
    })
    expect((await names).ok).toBe(true)
    expect(calls[1]![5]).toBe('Session a · Analytics')
    calls = []
    const redacted = await publishDeck({
      dir,
      pageDir,
      request: { ...request(false), key: 'session:sa', data: view },
      existing: null,
      run: runner(signedIn(), pushed(1)),
      now: () => NOW
    })
    expect(redacted.ok).toBe(true)
    expect(calls[1]![5]).toBe('Session 1 · Analytics')
  })
})
