/**
 * The workspace files over HTTP and the push channel: a read that needs a
 * review publishes `workspace_files.review_needed` and waits for the answer
 * command; a watched file's change reaches a welcomed peer once; the trust
 * roots are behind the bearer; an answer to no review is the declared
 * failure; a review nobody answers reads as Cancel at the timeout.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startEmbedded, type EmbeddedServer } from '../embedded'
import { FakeSource, Peer } from '../test-support'
import { WorkspaceFiles, memoryWorkspaceFilesStorage } from './files'

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
  server = await startEmbedded({
    ports: { sessions: new FakeSource(), workspaceFiles: files },
    helloTimeoutMs: 200,
    reviewTimeoutMs: 400
  })
})
afterEach(async () => {
  await server.stop()
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
    const peer = await welcomed()
    expect([200, 204]).toContain((await post('/workspace-files/watch', { path: file })).status)
    await new Promise((r) => setTimeout(r, 50))
    writeFileSync(file, elevated('EDIT'))
    const frame = await peer.next()
    expect(frame).toMatchObject({
      _tag: 'event',
      event: { _tag: 'workspace_files.changed', path: file }
    })
    expect(await peer.silence(200)).toBe(true)
    await post('/workspace-files/unwatch', { path: file })
    writeFileSync(file, elevated('EDIT 2'))
    expect(await peer.silence(250)).toBe(true)
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
    const deep = await get(
      `/workspace-files/discover-recursive?rootDir=${encodeURIComponent(root)}&maxDepth=3&exclude=node_modules&exclude=dist`
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
      `/workspace-files/discover-recursive?rootDir=${encodeURIComponent(root)}&maxDepth=1&exclude=labs`
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
