/**
 * The workspace files over HTTP and the push channel: a read that needs a
 * review publishes `workspace_files.review_needed` and waits for the answer
 * command; a watched file's change reaches a welcomed peer once; the trust
 * roots are behind the bearer; an answer to no review is the declared
 * failure; a review nobody answers reads as Cancel at the timeout.
 */
import * as fs from 'node:fs'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startEmbedded, type EmbeddedServer } from '../embedded'
import { FakeSource, Peer } from '../test-support'
import { WorkspaceFiles, memoryWorkspaceFilesStorage } from './files'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return { ...actual, watch: vi.fn(actual.watch) }
})

// Opt-in attribution for the once-only case. Keep the real watcher, timers,
// publisher and peer; print only tags, fixture-relative paths and digests.
let trace: ((tag: string, fields?: Record<string, unknown>) => void) | undefined
let stopTrace: (() => void) | undefined

function traceWatch(): void {
  const started = performance.now()
  trace = (tag, fields = {}) =>
    console.info(JSON.stringify({ watchTrace: tag, ms: performance.now() - started, ...fields }))
  const revision = (): string => {
    try {
      return createHash('sha256')
        .update(fs.readFileSync(join(root, 'watched.clave')))
        .digest('hex')
    } catch (error) {
      return (error as NodeJS.ErrnoException).code ?? 'unreadable'
    }
  }
  const realWatch = vi.mocked(fs.watch).getMockImplementation()!
  stopTrace = () => vi.mocked(fs.watch).mockImplementation(realWatch)
  let inCallback = false
  vi.mocked(fs.watch).mockImplementation((...args: Parameters<typeof fs.watch>) => {
    const [dir, callback] = args
    trace?.('watch_registered', { path: 'watched.clave', revision: revision() })
    return realWatch(dir, (eventType, filename) => {
      trace?.('native_callback', { eventType, filename, revision: revision() })
      inCallback = true
      try {
        if (typeof callback === 'function') callback(eventType, filename)
      } finally {
        inCallback = false
      }
    })
  })
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const timers = new Map<ReturnType<typeof setTimeout>, number>()
  let nextTimer = 0
  vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, ms, ...args) => {
    if (!inCallback) return realSetTimeout(callback, ms, ...args)
    const id = ++nextTimer
    const timer = realSetTimeout(() => {
      timers.delete(timer)
      trace?.('timer_fired', { id, revision: revision() })
      callback(...args)
    }, ms)
    timers.set(timer, id)
    trace?.('timer_scheduled', { id, delay: ms })
    return timer
  })
  vi.spyOn(globalThis, 'clearTimeout').mockImplementation((timer) => {
    const id = timers.get(timer as ReturnType<typeof setTimeout>)
    if (id !== undefined) {
      trace?.('timer_cancelled', { id })
      timers.delete(timer as ReturnType<typeof setTimeout>)
    }
    return realClearTimeout(timer)
  })
  files.onEvent((event) =>
    trace?.('domain_emission', {
      tag: event._tag,
      path: path.basename(event.path),
      revision: revision()
    })
  )
  const subscribe = files.onEvent.bind(files)
  vi.spyOn(files, 'onEvent').mockImplementation((listener) =>
    subscribe((event) => {
      trace?.('publication_requested', { tag: event._tag, path: path.basename(event.path) })
      listener(event)
    })
  )
}

let server: EmbeddedServer
let root: string
let files: WorkspaceFiles

const headers = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/json'
})
const get = (path: string): Promise<Response> =>
  fetch(`${server.url}${path}`, { headers: headers(server.token) })
const post = (path: string, body: unknown): Promise<Response> =>
  fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: headers(server.token),
    body: JSON.stringify(body)
  })
const elevated = (prompt: string): string =>
  JSON.stringify({
    $schema: 'clave/1.0',
    name: 'Lane',
    cwd: '.',
    prompt,
    sessions: [{ cwd: '.', name: 'tab', claudeMode: true, dangerousMode: false }],
    terminals: []
  })

/** A welcomed peer whose event frames are read one at a time. */
async function welcomed(): Promise<Peer> {
  const peer = new Peer(server.url.replace('http', 'ws') + '/push')
  await peer.opened
  peer.send({ _tag: 'hello', token: server.token, client: 'test' })
  expect((await peer.next())._tag).toBe('welcome')
  return peer
}

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'clave-wsf-http-')))
  files = new WorkspaceFiles(memoryWorkspaceFilesStorage(), { debounceMs: 60 })
  if (
    process.env.CLAVE_WATCH_TRACE === '1' &&
    expect.getState().currentTestName?.includes('tells a welcomed peer once')
  )
    traceWatch()
  server = await startEmbedded({
    ports: { sessions: new FakeSource(), workspaceFiles: files },
    helloTimeoutMs: 200,
    reviewTimeoutMs: 400
  })
})
afterEach(async () => {
  await server.stop()
  files.close()
  stopTrace?.()
  stopTrace = undefined
  trace = undefined
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

describe('the workspace files over HTTP', () => {
  it('reads a plain file straight away, paths resolved', async () => {
    const file = join(root, 'plain.clave')
    writeFileSync(file, JSON.stringify({ name: 'Plain', cwd: 'src', sessions: [], terminals: [] }))
    const read = await post('/workspace-files/read', { path: file })
    expect(read.status).toBe(200)
    expect(await read.json()).toMatchObject({
      type: 'single',
      name: 'Plain',
      cwd: join(root, 'src')
    })
    const exists = await get(`/workspace-files/exists?path=${encodeURIComponent(file)}`)
    expect(await exists.json()).toBe(true)
  })

  it('every endpoint is behind the bearer', async () => {
    const paths = [
      '/workspace-files/trust/roots',
      `/workspace-files/exists?path=${encodeURIComponent(root)}`
    ]
    for (const path of paths) {
      const res = await fetch(`${server.url}${path}`)
      expect(res.status, path).toBe(401)
    }
    const read = await fetch(`${server.url}/workspace-files/read`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: join(root, 'x.clave') })
    })
    expect(read.status).toBe(401)
  })

  it('publishes a review for an elevated untrusted file and answers the read with the client’s word', async () => {
    const file = join(root, 'untrusted.clave')
    writeFileSync(file, elevated('UNTRUSTED-BRIEF do the thing'))
    const peer = await welcomed()
    const reading = post('/workspace-files/read', { path: file, rootDir: root, requestId: 'req-1' })
    const frame = await peer.next()
    expect(frame._tag).toBe('event')
    if (frame._tag !== 'event') throw new Error('expected an event')
    expect(frame.event).toMatchObject({
      _tag: 'workspace_files.review_needed',
      requestId: 'req-1',
      path: file,
      folder: root,
      autoCommands: [],
      prompts: ['UNTRUSTED-BRIEF do the thing'],
      dangerous: false
    })
    const reviewId = (frame.event as { reviewId: string }).reviewId
    expect(typeof reviewId).toBe('string')
    // Open safely: the file comes back without its prompt.
    const answered = await post('/workspace-files/review/answer', {
      reviewId,
      response: 0,
      checkboxChecked: false
    })
    expect([200, 204]).toContain(answered.status)
    const result = (await (await reading).json()) as { prompt?: string; name: string }
    expect(result.name).toBe('Lane')
    expect(result.prompt).toBeUndefined()
    // The review is spent: the same id is refused.
    const again = await post('/workspace-files/review/answer', {
      reviewId,
      response: 1,
      checkboxChecked: false
    })
    expect(again.status).toBe(422)
    expect(await again.json()).toMatchObject({ _tag: 'ReviewNotFound', reviewId })
  })

  it('Trust and run answers the file whole, and the next read asks nobody', async () => {
    const file = join(root, 'trust.clave')
    writeFileSync(file, elevated('BRIEF'))
    const peer = await welcomed()
    const reading = post('/workspace-files/read', { path: file })
    const frame = await peer.next()
    if (frame._tag !== 'event') throw new Error('expected an event')
    const { reviewId } = frame.event as { reviewId: string }
    await post('/workspace-files/review/answer', { reviewId, response: 1, checkboxChecked: false })
    expect(await (await reading).json()).toMatchObject({ prompt: 'BRIEF' })
    const second = await post('/workspace-files/read', { path: file })
    expect(await second.json()).toMatchObject({ prompt: 'BRIEF' })
    expect(await peer.silence(150)).toBe(true)
  })

  it('Cancel answers null; a review nobody answers reads as Cancel at the timeout', async () => {
    const file = join(root, 'cancel.clave')
    writeFileSync(file, elevated('BRIEF'))
    const peer = await welcomed()
    const cancelled = post('/workspace-files/read', { path: file })
    const frame = await peer.next()
    if (frame._tag !== 'event') throw new Error('expected an event')
    await post('/workspace-files/review/answer', {
      reviewId: (frame.event as { reviewId: string }).reviewId,
      response: 2,
      checkboxChecked: false
    })
    expect(await (await cancelled).json()).toBeNull()

    const started = Date.now()
    const silent = await post('/workspace-files/read', { path: file })
    expect(await silent.json()).toBeNull()
    expect(Date.now() - started).toBeGreaterThanOrEqual(350)
    expect((await peer.next())._tag).toBe('event')
  })

  it('a stopping server answers its held reads at once, as Cancel', async () => {
    const file = join(root, 'stop.clave')
    writeFileSync(file, elevated('BRIEF'))
    const peer = await welcomed()
    const reading = post('/workspace-files/read', { path: file })
    expect((await peer.next())._tag).toBe('event')
    const started = Date.now()
    await server.stop()
    const stoppedAfter = Date.now() - started
    expect(stoppedAfter).toBeLessThan(2000)
    const answer = await reading.then(
      async (res) => ({ status: res.status, body: await res.text() }),
      (error: unknown) => ({ status: 0, body: String(error) })
    )
    // Null (Cancel) when the answer still left the closing listener, else the
    // connection closed; never a read still held after the stop.
    if (answer.status === 200) expect(answer.body).toBe('null')
    // Restarted so afterEach's stop has a server.
    server = await startEmbedded({
      ports: { sessions: new FakeSource(), workspaceFiles: files },
      helloTimeoutMs: 200,
      reviewTimeoutMs: 400
    })
  })

  it('an answer to a review it does not hold is the declared failure', async () => {
    const res = await post('/workspace-files/review/answer', {
      reviewId: 'nope',
      response: 0,
      checkboxChecked: false
    })
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ _tag: 'ReviewNotFound', reviewId: 'nope' })
  })

  it('a trusted root skips the review, through the command and the list', async () => {
    const file = join(root, 'rooted.clave')
    writeFileSync(file, elevated('ROOTED'))
    expect([200, 204]).toContain((await post('/workspace-files/trust/roots', { root })).status)
    expect(await (await get('/workspace-files/trust/roots')).json()).toEqual([root])
    const peer = await welcomed()
    expect(await (await post('/workspace-files/read', { path: file })).json()).toMatchObject({
      prompt: 'ROOTED'
    })
    expect(await peer.silence(150)).toBe(true)
    await post('/workspace-files/trust/roots/remove', { root })
    expect(await (await get('/workspace-files/trust/roots')).json()).toEqual([])
  })

  it('tells a welcomed peer once when a watched file changes on disk, and not after unwatch', async () => {
    const file = join(root, 'watched.clave')
    writeFileSync(file, elevated(''))
    trace?.('initial_write', { path: 'watched.clave' })
    const peer = await welcomed()
    const frames: Array<Record<string, unknown>> = []
    peer.ws.on('message', (data) => {
      // Peer's earlier listener already decoded this frame against the schema.
      const frame = JSON.parse(data.toString())
      const tags = {
        tag: frame._tag,
        eventTag: frame.event?._tag,
        path: frame.event?.path ? path.basename(frame.event.path) : undefined,
        seq: frame.seq
      }
      frames.push(tags)
      trace?.('decoded_frame', tags)
    })
    expect([200, 204]).toContain((await post('/workspace-files/watch', { path: file })).status)
    await new Promise((r) => setTimeout(r, 50))
    writeFileSync(file, elevated('EDIT'))
    trace?.('external_write', { path: 'watched.clave' })
    const frame = await peer.next()
    expect(frame).toMatchObject({
      _tag: 'event',
      event: { _tag: 'workspace_files.changed', path: file }
    })
    expect(await peer.silence(200), JSON.stringify(frames)).toBe(true)
    await post('/workspace-files/unwatch', { path: file })
    writeFileSync(file, elevated('EDIT 2'))
    expect(await peer.silence(250)).toBe(true)
  })

  it('answers null, never 500, for a file that is not a document', async () => {
    for (const [name, text] of [
      ['object-sessions.clave', '{"sessions":{}}'],
      ['bare-null.clave', 'null'],
      ['array.clave', '[1,2]'],
      ['number-cwd.clave', '{"cwd":5}']
    ] as const) {
      const file = join(root, name)
      writeFileSync(file, text)
      const read = await post('/workspace-files/read', { path: file })
      expect(read.status, name).toBe(200)
      expect(await read.json(), name).toBeNull()
    }
  })

  it('normalises autoDiscover on the wire: a loose `enabled` never fails the GET', async () => {
    const file = join(root, 'loose.clave')
    writeFileSync(file, JSON.stringify({ autoDiscover: { maxDepth: 3, exclude: ['x'] } }))
    const res = await get(`/workspace-files/auto-discover?path=${encodeURIComponent(file)}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ enabled: false, maxDepth: 3, exclude: ['x'] })
  })

  it('a watch held by two holders survives one holder’s release', async () => {
    const file = join(root, 'held.clave')
    writeFileSync(file, elevated(''))
    const peer = await welcomed()
    await post('/workspace-files/watch', { path: file, holder: 'ipc:w1' })
    await post('/workspace-files/watch', { path: file, holder: 'server:w1' })
    await post('/workspace-files/unwatch', { path: file, holder: 'ipc:w1' })
    expect(files.holdersOf(file)).toEqual(['server:w1'])
    await new Promise((r) => setTimeout(r, 50))
    writeFileSync(file, elevated('EDIT'))
    expect(await peer.next()).toMatchObject({
      event: { _tag: 'workspace_files.changed', path: file }
    })
    await post('/workspace-files/unwatch', { path: file, holder: 'server:w1' })
    expect(files.watched()).toEqual([])
  })

  it('writes a file through the server and trusts what it wrote', async () => {
    const file = join(root, 'written.clave')
    const written = await post('/workspace-files/write', {
      path: file,
      rootDir: root,
      data: {
        name: 'W',
        cwd: join(root, 'p'),
        color: null,
        prompt: 'AUTHORED',
        sessions: [],
        terminals: []
      }
    })
    expect([200, 204]).toContain(written.status)
    const peer = await welcomed()
    expect(
      await (await post('/workspace-files/read', { path: file, rootDir: root })).json()
    ).toMatchObject({
      prompt: 'AUTHORED',
      cwd: join(root, 'p')
    })
    expect(await peer.silence(150)).toBe(true)
  })

  it('discovers, recursively too, with the GET’s parameters decoded', async () => {
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(root, 'labs', 'one', '.clave', 'workspaces'), { recursive: true })
    writeFileSync(join(root, 'labs', 'one', '.clave', 'workspaces', 'default.clave'), elevated(''))
    writeFileSync(
      join(root, 'workspace.clave'),
      JSON.stringify({ autoDiscover: { enabled: true } })
    )
    expect(
      await (await get(`/workspace-files/discover?folder=${encodeURIComponent(root)}`)).json()
    ).toEqual([{ name: 'workspace', path: join(root, 'workspace.clave'), rootDir: null }])
    const list = (values: string[]): string => encodeURIComponent(JSON.stringify(values))
    const deep = await get(
      `/workspace-files/discover-recursive?rootDir=${encodeURIComponent(root)}&maxDepth=3&exclude=${list(['node_modules', 'dist'])}`
    )
    expect(deep.status).toBe(200)
    // The root's own workspace file is found too, at depth 0, as it always was.
    expect(await deep.json()).toEqual([
      { name: path.basename(root), path: join(root, 'workspace.clave'), rootDir: root },
      {
        name: 'one',
        path: join(root, 'labs/one/.clave/workspaces/default.clave'),
        rootDir: join(root, 'labs/one')
      }
    ])
    const shallow = await get(
      `/workspace-files/discover-recursive?rootDir=${encodeURIComponent(root)}&maxDepth=1&exclude=${list(['labs'])}`
    )
    expect(await shallow.json()).toEqual([
      { name: path.basename(root), path: join(root, 'workspace.clave'), rootDir: root }
    ])
    expect(
      await (
        await get(
          `/workspace-files/auto-discover?path=${encodeURIComponent(join(root, 'workspace.clave'))}`
        )
      ).json()
    ).toEqual({ enabled: true })
  })
})
