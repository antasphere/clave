import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import type { ConversationSnapshot } from '../../shared/agent-session'
import type { PluginViewDescriptor } from '../../shared/runtime-plugins'
import { RuntimePluginViews, readWorkspaceFile, type PluginViewDependencies } from './views'
import { RuntimePluginJobs } from './jobs'
import {
  attachPluginFramePolicy,
  pluginProtocolResponse,
  PLUGIN_BOOTSTRAP,
  PLUGIN_CSP
} from './protocol'

const plugin = { pluginId: 'test', revision: 'r1', version: '1.0.0' }
const descriptor: PluginViewDescriptor = {
  id: 'view',
  name: 'Test',
  plugin,
  capabilities: [
    'conversation.read',
    'workspace.execute',
    'conversation.send',
    'workspace.readFile'
  ]
}
const entry = {
  kind: 'artifact' as const,
  id: 'a',
  title: 'A',
  mimeType: 'text/html' as const,
  content: '<p>hello</p>',
  fallback: 'hello'
}
const snapshot = { entries: [entry] } as ConversationSnapshot
const temporary: string[] = []
const executors: RuntimePluginJobs[] = []
async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'clave-plugin-test-'))
  temporary.push(dir)
  return dir
}
afterEach(async () => {
  for (const executor of executors.splice(0)) executor.dispose()
  // Allow killed processes to close and finish their ledger writes.
  await new Promise((resolve) => setTimeout(resolve, 60))
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true })
})
function broker(): { views: RuntimePluginViews; deps: PluginViewDependencies } {
  const deps: PluginViewDependencies = {
    snapshot: vi.fn(async () => snapshot),
    resolveView: vi.fn(async () => ({ descriptor, html: '<p>installed</p>' })),
    isAvailable: vi.fn(() => true),
    cwd: vi.fn(() => '/workspace'),
    confirm: vi.fn(async () => true),
    executeJob: vi.fn(async () => 'job'),
    readJob: vi.fn(async () => 'job'),
    cancelJob: vi.fn(async () => 'cancelled'),
    setDraft: vi.fn(async () => undefined),
    send: vi.fn(async () => undefined),
    openFile: vi.fn(async () => undefined),
    openArtifact: vi.fn(async () => undefined)
  }
  return { views: new RuntimePluginViews(deps), deps }
}

describe('view authority', () => {
  it('gives generated HTML zero capabilities and requires a stored entry', async () => {
    const { views } = broker()
    await expect(views.open(1, 'session', 'missing')).rejects.toThrow('Entry unavailable')
    const lease = await views.open(1, 'session', 'a')
    expect(lease.capabilities).toEqual([])
    expect(lease.id).toMatch(/^[a-f0-9]{64}$/)
    await expect(
      views.request(1, lease.id, { id: '1', method: 'conversation.read' })
    ).rejects.toThrow('Capability denied')
  })
  it('uses resolved capabilities, not caller claims or mutable lease objects', async () => {
    const { views, deps } = broker()
    const lease = await views.open(1, 'session', 'a', {
      ...descriptor,
      capabilities: ['composer.setDraft']
    })
    lease.capabilities.push('composer.setDraft')
    lease.view!.plugin.revision = 'spoofed'
    await expect(
      views.request(1, lease.id, { id: '1', method: 'composer.setDraft', params: { text: 'x' } })
    ).rejects.toThrow('Capability denied')
    await expect(
      views.request(2, lease.id, { id: '1', method: 'conversation.read' })
    ).rejects.toThrow('View unavailable')
    expect(deps.setDraft).not.toHaveBeenCalled()
    await views.request(1, lease.id, { id: 'read', method: 'conversation.read' })
    expect(deps.isAvailable).toHaveBeenLastCalledWith(plugin)
  })
  it('denies unknown methods, extra scope and disabled or revoked leases', async () => {
    const { views, deps } = broker()
    const lease = await views.open(1, 'session', 'a', descriptor)
    for (const request of [
      { id: '1', method: 'unknown' },
      { id: '1', method: 'conversation.read', params: null },
      { id: '1', method: 'conversation.read', sessionId: 'other' },
      { id: '1', method: 'conversation.read', params: { sessionId: 'other' } },
      { id: '1', method: 'workspace.execute', params: { argv: ['echo'], cwd: '/tmp' } },
      {
        id: '1',
        method: 'workspace.execute',
        params: { argv: ['echo'], capabilities: ['workspace.execute'] }
      }
    ])
      await expect(views.request(1, lease.id, request)).rejects.toThrow()
    vi.mocked(deps.isAvailable).mockReturnValue(false)
    await expect(
      views.request(1, lease.id, { id: '2', method: 'conversation.read' })
    ).rejects.toThrow('Capability denied')
    await expect(views.open(1, 'session', 'a', descriptor)).rejects.toThrow('Plugin unavailable')
    views.revokeOwner(1)
    expect(views.html(lease.id)).toBeUndefined()
    await expect(
      views.request(1, lease.id, { id: '3', method: 'conversation.read' })
    ).rejects.toThrow('View unavailable')
  })
  it('confirms mutations, binds job scope and rejects duplicate IDs', async () => {
    const { views, deps } = broker()
    const lease = await views.open(1, 'session', 'a', descriptor)
    const request = {
      id: '1',
      method: 'workspace.execute',
      params: { argv: ['echo', 'literal;value'] }
    }
    await views.request(1, lease.id, request)
    expect(deps.confirm).toHaveBeenCalledWith(1, 'workspace.execute', request.params, {
      sessionId: 'session',
      plugin
    })
    expect(deps.executeJob).toHaveBeenCalledWith(
      { sessionId: 'session', plugin },
      request.params.argv,
      `${lease.id}:1`
    )
    await expect(views.request(1, lease.id, request)).rejects.toThrow('already consumed')
    vi.mocked(deps.confirm).mockResolvedValue(false)
    await expect(
      views.request(1, lease.id, { id: '2', method: 'conversation.send', params: { text: 'send' } })
    ).rejects.toThrow('declined')
    expect(deps.send).not.toHaveBeenCalled()
    await views.request(1, lease.id, {
      id: '3',
      method: 'workspace.jobRead',
      params: { jobId: 'job' }
    })
    expect(deps.readJob).toHaveBeenCalledWith({ sessionId: 'session', plugin }, 'job')
  })
  it('rechecks revocation after a pending native confirmation', async () => {
    const { views, deps } = broker()
    const lease = await views.open(1, 'session', 'a', descriptor)
    vi.mocked(deps.confirm).mockImplementation(async () => {
      views.close(1, lease.id)
      return true
    })
    await expect(
      views.request(1, lease.id, {
        id: '1',
        method: 'workspace.execute',
        params: { argv: ['echo'] }
      })
    ).rejects.toThrow('Capability denied')
    expect(deps.executeJob).not.toHaveBeenCalled()
  })
  it('serves each document once and caps live leases per owner', async () => {
    const { views } = broker()
    const lease = await views.open(1, 'session', 'a')
    expect(views.html(lease.id)).toBe(entry.content)
    expect(views.html(lease.id)).toBeUndefined()
    for (let i = 1; i < 16; i++) await views.open(1, 'session', 'a')
    await expect(views.open(1, 'session', 'a')).rejects.toThrow('limit')
    views.close(2, lease.id)
    await expect(views.open(1, 'session', 'a')).rejects.toThrow('limit')
    views.close(1, lease.id)
    await expect(views.open(1, 'session', 'a')).resolves.toHaveProperty('id')
    views.revokeSession('session')
    await expect(
      views.request(1, lease.id, { id: '1', method: 'conversation.read' })
    ).rejects.toThrow('unavailable')
  })
  it('cannot finish opening a lease after its host is destroyed', async () => {
    const { views, deps } = broker()
    vi.mocked(deps.snapshot).mockImplementation(async () => {
      views.revokeOwner(1)
      return snapshot
    })
    await expect(views.open(1, 'session', 'a')).rejects.toThrow('owner closed')
  })
  it('bounds pending requests and refuses a late-confirmed side effect after timeout', async () => {
    const { views, deps } = broker()
    const lease = await views.open(1, 'session', 'a', descriptor)
    let confirm!: (value: boolean) => void
    vi.mocked(deps.confirm).mockImplementation(
      () =>
        new Promise((resolve) => {
          confirm = resolve
        })
    )
    vi.useFakeTimers()
    try {
      const pending = views.request(1, lease.id, {
        id: 'slow',
        method: 'workspace.execute',
        params: { argv: ['echo'] }
      })
      const assertion = expect(pending).rejects.toThrow('timed out')
      await vi.advanceTimersByTimeAsync(30_001)
      await assertion
      confirm(true)
      await vi.advanceTimersByTimeAsync(1)
      expect(deps.executeJob).not.toHaveBeenCalled()
      vi.mocked(deps.isAvailable).mockImplementation(() => new Promise(() => {}))
      const requests = Array.from({ length: 8 }, (_, i) =>
        views
          .request(1, lease.id, { id: `read-${i}`, method: 'conversation.read' })
          .catch((error) => error)
      )
      await expect(
        views.request(1, lease.id, { id: 'overflow', method: 'conversation.read' })
      ).rejects.toThrow('limit')
      await vi.advanceTimersByTimeAsync(30_001)
      await Promise.all(requests)
      await expect(
        views.request(1, lease.id, { id: 'still-overflow', method: 'conversation.read' })
      ).rejects.toThrow('limit')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('workspace text boundary', () => {
  it('rejects traversal, absolute paths, symlink escapes, directories, binary and oversized data', async () => {
    const dir = await directory()
    const workspace = join(dir, 'workspace')
    await mkdir(workspace)
    await writeFile(join(dir, 'secret'), 'outside')
    await writeFile(join(workspace, 'ok'), 'hello')
    await writeFile(join(workspace, 'binary'), Buffer.from([0, 1]))
    await writeFile(join(workspace, 'invalid-utf8'), Buffer.from([255, 255]))
    await writeFile(join(workspace, 'large'), 'x'.repeat(262_145))
    await symlink(join(dir, 'secret'), join(workspace, 'escape'))
    await symlink(dir, join(workspace, 'escape-dir'))
    await mkdir(join(workspace, 'folder'))
    expect(await readWorkspaceFile(workspace, 'ok')).toBe('hello')
    for (const path of [
      '../secret',
      join(dir, 'secret'),
      'escape',
      'escape-dir/secret',
      'folder',
      'binary',
      'invalid-utf8',
      'large',
      'a\\..\\secret'
    ]) {
      await expect(readWorkspaceFile(workspace, path)).rejects.toThrow()
    }
  })
  it('scopes an injected reader before calling it and validates its returned data', async () => {
    const dir = await directory()
    await writeFile(join(dir, 'file'), 'hello')
    const { views, deps } = broker()
    vi.mocked(deps.cwd).mockReturnValue(dir)
    deps.readFile = vi.fn(async () => 'hello')
    const lease = await views.open(1, 'session', 'a', descriptor)
    await expect(
      views.request(1, lease.id, {
        id: '1',
        method: 'workspace.readFile',
        params: { path: '../secret' }
      })
    ).rejects.toThrow()
    expect(deps.readFile).not.toHaveBeenCalled()
    await expect(
      views.request(1, lease.id, {
        id: '2',
        method: 'workspace.readFile',
        params: { path: 'file' }
      })
    ).resolves.toBe('hello')
    expect(deps.readFile).toHaveBeenCalledWith(join(await realpath(dir), 'file'), 262_144)
    vi.mocked(deps.readFile).mockResolvedValue('x'.repeat(262_145))
    await expect(
      views.request(1, lease.id, {
        id: '3',
        method: 'workspace.readFile',
        params: { path: 'file' }
      })
    ).rejects.toThrow('small text')
  })
})

describe('private protocol', () => {
  it('serves restrictive response CSP and rejects noncanonical URLs', async () => {
    const id = 'a'.repeat(64)
    const source = { html: (key: string) => (key === id ? '<script>hello()</script>' : undefined) }
    const response = pluginProtocolResponse(`clave-plugin://view/${id}`, source)
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Security-Policy')).toBe(PLUGIN_CSP)
    expect(PLUGIN_CSP).toContain("connect-src 'none'")
    expect(PLUGIN_CSP).toContain('sandbox allow-scripts')
    expect(PLUGIN_CSP).not.toContain('allow-same-origin')
    expect(await response.text()).toBe(
      '<!doctype html><meta charset="utf-8">' + PLUGIN_BOOTSTRAP + '<script>hello()</script>'
    )
    for (const url of [
      `clave-plugin://view/${id}?x=1`,
      'https://view/x',
      'clave-plugin://view/../secret'
    ]) {
      expect(pluginProtocolResponse(url, source).status).toBe(404)
    }
  })
  it('blocks self navigation and redirects before requests without relying on frame names', () => {
    const contents = new EventEmitter()
    const detach = attachPluginFramePolicy(contents as WebContents)
    const frame = { url: 'about:blank', processId: 1, routingId: 2, name: 'innocent' }
    const initial = {
      frame,
      url: `clave-plugin://view/${'a'.repeat(64)}`,
      isMainFrame: false,
      preventDefault: vi.fn()
    }
    contents.emit('will-frame-navigate', initial)
    expect(initial.preventDefault).not.toHaveBeenCalled()
    frame.name = 'not-a-plugin'
    const escape = {
      frame,
      url: 'https://attacker.example',
      isMainFrame: false,
      preventDefault: vi.fn()
    }
    contents.emit('will-frame-navigate', escape)
    expect(escape.preventDefault).toHaveBeenCalledOnce()
    const redirected = { preventDefault: vi.fn() }
    contents.emit('will-redirect', redirected, 'https://attacker.example', false, false, 1, 2)
    expect(redirected.preventDefault).toHaveBeenCalledOnce()
    const unrelated = {
      frame: { url: 'clave-preview://file/x', processId: 1, routingId: 3 },
      url: 'https://example.com',
      preventDefault: vi.fn()
    }
    contents.emit('will-frame-navigate', unrelated)
    expect(unrelated.preventDefault).not.toHaveBeenCalled()
    detach()
    expect(contents.listenerCount('will-frame-navigate')).toBe(0)
  })
})

describe('durable jobs', () => {
  it('deduplicates execution, does not persist environment and enforces revision/session scope', async () => {
    const dir = await directory()
    const jobs = new RuntimePluginJobs(dir)
    executors.push(jobs)
    const scope = { sessionId: 'session', plugin }
    const input = {
      ...scope,
      cwd: dir,
      requestId: 'request',
      env: { PRIVATE_TOKEN: 'do-not-persist' },
      argv: [process.execPath, '-e', 'console.log("literal;not-a-shell")']
    }
    const job = jobs.execute(input)
    expect(jobs.execute(input).id).toBe(job.id)
    await vi.waitFor(() => expect(jobs.read(scope, job.id).status).toBe('completed'))
    expect(jobs.read(scope, job.id).output).toBe('literal;not-a-shell\n')
    expect(() => jobs.read({ ...scope, sessionId: 'other' }, job.id)).toThrow('unavailable')
    expect(() => jobs.cancel({ ...scope, plugin: { ...plugin, revision: 'r2' } }, job.id)).toThrow(
      'unavailable'
    )
    const ledger = await readFile(join(dir, `${job.id}.json`), 'utf8')
    expect(ledger).not.toContain('PRIVATE_TOKEN')
    expect(ledger).not.toContain('do-not-persist')
    const reopened = new RuntimePluginJobs(dir)
    executors.push(reopened)
    expect(reopened.execute(input).id).toBe(job.id)
    expect((await readdir(dir)).filter((f) => f.endsWith('.json'))).toHaveLength(1)
  })
  it('cancels owned children and bounds output and runtime', async () => {
    const dir = await directory()
    const jobs = new RuntimePluginJobs(dir, {
      concurrent: 1,
      timeoutMs: 200,
      outputBytes: 64,
      records: 10
    })
    executors.push(jobs)
    const scope = { sessionId: 's', plugin }
    const input = {
      ...scope,
      cwd: dir,
      requestId: '1',
      env: {},
      argv: [process.execPath, '-e', 'setInterval(() => {}, 100)']
    }
    const job = jobs.execute(input)
    expect(() => jobs.execute({ ...input, requestId: '2' })).toThrow('limit')
    expect(jobs.cancel(scope, job.id).status).toBe('cancelled')
    // Cancellation keeps the slot until process-tree cleanup has finished.
    // The fixed request ID makes polling safe if an attempt is accepted.
    const noisy = await vi.waitFor(() =>
      jobs.execute({
        ...input,
        requestId: '2',
        argv: [
          process.execPath,
          '-e',
          'process.stdout.write("🙂".repeat(100));setInterval(() => {}, 100)'
        ]
      })
    )
    await vi.waitFor(() => expect(jobs.read(scope, noisy.id).status).toBe('interrupted'))
    expect(Buffer.byteLength(jobs.read(scope, noisy.id).output)).toBeLessThanOrEqual(64)
    expect(jobs.read(scope, noisy.id).truncated).toBe(true)
  })
  it('marks uncertain accepted jobs interrupted on restart and never respawns', async () => {
    const dir = await directory()
    const jobs = new RuntimePluginJobs(dir)
    executors.push(jobs)
    const input = {
      sessionId: 's',
      plugin,
      cwd: dir,
      requestId: '1',
      env: {},
      argv: [process.execPath, '-e', 'setInterval(() => {}, 100)']
    }
    const job = jobs.execute(input)
    const recovered = new RuntimePluginJobs(dir)
    executors.push(recovered)
    expect(recovered.read(input, job.id).status).toBe('interrupted')
    expect(recovered.execute(input).status).toBe('interrupted')
    expect(recovered.execute(input).id).toBe(job.id)
    jobs.cancel(input, job.id)
  })
  it('cancels only the closing session and rejects new work after disposal', async () => {
    const dir = await directory()
    const jobs = new RuntimePluginJobs(dir)
    executors.push(jobs)
    const input = {
      sessionId: 'first',
      plugin,
      cwd: dir,
      requestId: '1',
      env: {},
      argv: [process.execPath, '-e', 'setInterval(() => {}, 100)']
    }
    const first = jobs.execute(input)
    const otherInput = { ...input, sessionId: 'second' }
    const second = jobs.execute(otherInput)
    jobs.cancelSession('first')
    expect(jobs.read(input, first.id).status).toBe('cancelled')
    expect(jobs.read(otherInput, second.id).status).toBe('running')
    jobs.dispose()
    expect(jobs.read(otherInput, second.id).status).toBe('interrupted')
    expect(() => jobs.execute({ ...input, requestId: 'new' })).toThrow('closed')
  })
})
