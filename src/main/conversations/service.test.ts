import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { ConversationService } from './service'
import type { AdapterFactory, AdapterLaunch, EmitConversationEvent } from './adapter'
import { createPluginAdapterFactory } from '../runtime-plugins/providers'
import { RuntimePluginRegistry } from '../runtime-plugins/registry'

const directories: string[] = []
afterEach(() =>
  directories.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
)

test('artifacts stay readable without their plugin and publishing is idempotent', async () => {
  const f = fixture()
  const service = new ConversationService(f.directory, f.factory)
  const { session } = await service.create(f.options, f.launch)
  const input = {
    title: 'Report',
    mimeType: 'text/html' as const,
    content: '<h1>Report</h1>',
    fallback: 'Report results'
  }
  const artifact = service.publishArtifact(session.id, input, 'report-one')
  expect(service.publishArtifact(session.id, input, 'report-one')).toEqual(artifact)
  expect(() =>
    service.publishArtifact(session.id, { ...input, content: 'changed' }, 'report-one')
  ).toThrow()
  const restored = new ConversationService(f.directory, () => {
    throw new Error('Plugin missing')
  })
  expect(restored.snapshot(session.id).entries).toEqual([artifact])
  expect(f.adapter.start).not.toHaveBeenCalled()
})

test('provider and first-use view bindings survive restart and cannot be replaced', async () => {
  const f = fixture()
  const service = new ConversationService(f.directory, f.factory)
  const provider = { pluginId: 'internal.echo', version: '1.0.0', revision: 'first' }
  const view = { pluginId: 'internal.report', version: '1.0.0', revision: 'original' }
  const options = {
    ...f.options,
    provider: 'internal.echo',
    pluginBindings: { provider, views: [] }
  }
  const { session } = await service.create(options, { ...f.launch, options })
  service.pinView(session.id, view)
  expect(() => service.pinView(session.id, { ...view, revision: 'newer' })).toThrow()
  expect(() =>
    service.bindPlugins(session.id, { provider: { ...provider, revision: 'newer' }, views: [] })
  ).toThrow()
  const restored = new ConversationService(f.directory, f.factory)
  expect(restored.snapshot(session.id).session.pluginBindings).toEqual({ provider, views: [view] })
})

test('an unavailable builtin factory reports safe revision recovery rather than an executable error', async () => {
  const f = fixture()
  const service = new ConversationService(
    f.directory,
    createPluginAdapterFactory(new RuntimePluginRegistry())
  )
  const options = {
    ...f.options,
    pluginBindings: {
      provider: { pluginId: 'builtin.claude', revision: 'unavailable', version: '1.0.0' },
      views: []
    }
  }
  const { session } = await service.create(options, { ...f.launch, options })
  await expect(service.send(session.id, 'not sent to a provider', 'one')).rejects.toThrow(
    'Built-in plugin revision unavailable'
  )
  const error = service.snapshot(session.id).session.error
  expect(error).toContain('Restart background service')
  expect(error).not.toContain('Check the executable')
})

test('interrupting a running turn preserves the provider for the next turn', async () => {
  const f = fixture()
  const service = new ConversationService(f.directory, f.factory)
  const { session } = await service.create(f.options, f.launch)
  await service.send(session.id, 'hello', 'one')
  await service.interrupt(session.id)
  expect(f.adapter.interrupt).toHaveBeenCalledOnce()
  expect(f.adapter.dispose).not.toHaveBeenCalled()
  expect(service.snapshot(session.id).session.status).toBe('running')
  await expect(service.send(session.id, 'too soon', 'early')).rejects.toThrow('already running')
  f.emit({ type: 'turn-end', outcome: 'interrupted' })
  expect(service.snapshot(session.id).session.status).toBe('idle')
  await service.send(session.id, 'next turn', 'two')
  expect(f.adapter.start).toHaveBeenCalledOnce()
  expect(f.adapter.send).toHaveBeenCalledTimes(2)
})

test('provider questions can be answered before send acknowledgment', async () => {
  const f = fixture()
  let accept!: () => void
  f.adapter.send.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        accept = resolve
      })
  )
  f.adapter.respond.mockImplementation(async () => {
    accept()
  })
  const service = new ConversationService(f.directory, f.factory)
  const { session } = await service.create(f.options, f.launch)
  const sending = service.send(session.id, 'interactive preflight', 'one')
  await vi.waitFor(() => expect(f.adapter.send).toHaveBeenCalledOnce())
  f.emit({ type: 'request', request: { id: 'preflight', kind: 'question', title: 'Continue?' } })
  await service.respond(session.id, { requestId: 'preflight', answer: 'yes' })
  await sending
  expect(f.adapter.respond).toHaveBeenCalledOnce()
})

test('burst deltas are durably batched and flushed before turn end', async () => {
  const f = fixture()
  const service = new ConversationService(f.directory, f.factory)
  const { session } = await service.create(f.options, f.launch)
  await service.send(session.id, 'hello', '1')
  const events: unknown[] = []
  service.onEvent((event) => events.push(event))
  for (let i = 0; i < 100; i++) f.emit({ type: 'text-delta', messageId: 'answer', text: 'é' })
  expect(events).toHaveLength(0)
  f.emit({ type: 'turn-end', outcome: 'completed' })
  expect(events).toHaveLength(2)
  expect(service.snapshot(session.id).entries.at(-1)).toMatchObject({ text: 'é'.repeat(100) })
  expect(
    new ConversationService(f.directory, f.factory).snapshot(session.id).entries.at(-1)
  ).toMatchObject({ text: 'é'.repeat(100) })
})

test('oversized provider request stops the adapter and ignores late output', async () => {
  const f = fixture()
  const service = new ConversationService(f.directory, f.factory)
  const { session } = await service.create(f.options, f.launch)
  await service.send(session.id, 'hello', '1')
  f.emit({ type: 'request', request: { id: 'p', kind: 'permission', title: 'é'.repeat(140000) } })
  expect(f.adapter.dispose).toHaveBeenCalledTimes(1)
  f.emit({ type: 'text-delta', messageId: 'late', text: 'ignored' })
  expect(service.snapshot(session.id).entries).toHaveLength(1)
  expect(service.snapshot(session.id).session.status).toBe('error')
})

test('pending request overflow clears approvals and stops the waiting provider', async () => {
  const f = fixture()
  const service = new ConversationService(f.directory, f.factory)
  const { session } = await service.create(f.options, f.launch)
  await service.send(session.id, 'hello', '1')
  for (let i = 0; i < 33; i++) {
    f.emit({ type: 'request', request: { id: `p-${i}`, kind: 'permission', title: 'Read?' } })
  }
  expect(service.snapshot(session.id).session.error).toMatch(/Too many pending requests/)
  expect(service.snapshot(session.id).requests).toEqual([])
  expect(f.adapter.dispose).toHaveBeenCalledTimes(1)
  await expect(
    service.respond(session.id, { requestId: 'p-0', decision: 'allow' })
  ).rejects.toThrow()
  expect(f.adapter.respond).not.toHaveBeenCalled()
})

test('failed initialization retains visible user message without claiming execution', async () => {
  const f = fixture()
  f.adapter.start.mockRejectedValue(new Error('Executable not found'))
  const service = new ConversationService(f.directory, f.factory)
  const { session } = await service.create(f.options, f.launch)
  await expect(service.send(session.id, 'hello', '1')).rejects.toThrow(/not submitted/)
  expect(service.snapshot(session.id).entries).toMatchObject([{ text: 'hello', role: 'user' }])
  expect(service.snapshot(session.id).session.error).not.toMatch(/may have executed/)
  expect(f.adapter.send).not.toHaveBeenCalled()
})

test.each(['close', 'interrupt'] as const)(
  '%s cancels pending initialization and late events',
  async (command) => {
    const f = fixture()
    let finish!: () => void
    f.adapter.start.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    const service = new ConversationService(f.directory, f.factory)
    const { session } = await service.create(f.options, f.launch)
    const sending = service.send(session.id, 'hello', '1')
    await service[command](session.id)
    finish()
    await expect(sending).rejects.toThrow()
    f.emit({ type: 'status', status: 'idle' })
    expect(service.snapshot(session.id).session.status).toBe(
      command === 'close' ? 'closed' : 'stopped'
    )
    expect(f.adapter.send).not.toHaveBeenCalled()
  }
)

test('capacity stops before mutating history and remains enforced after restart', async () => {
  const f = fixture()
  let service = new ConversationService(f.directory, f.factory)
  const { session } = await service.create(f.options, f.launch)
  const path = join(f.directory, `${session.id}.json`)
  const record = JSON.parse(readFileSync(path, 'utf8'))
  record.snapshot.entries = [
    { kind: 'message', id: 'old', role: 'assistant', text: '漢'.repeat(1300000) }
  ]
  writeFileSync(path, JSON.stringify(record))
  service = new ConversationService(f.directory, f.factory)
  await service.send(session.id, 'hello', '1', f.launch)
  const before = service.snapshot(session.id).entries
  for (let i = 0; i < 3; i++) {
    f.emit({ type: 'text-delta', messageId: 'old', text: '漢'.repeat(50000) })
    service.snapshot(session.id)
  }
  const stopped = service.snapshot(session.id)
  expect(stopped.session.error).toMatch(/4 MiB history limit/)
  expect(
    stopped.entries[0].kind === 'message' &&
      stopped.entries[0].text.startsWith(before[0].kind === 'message' ? before[0].text : '')
  ).toBe(true)
  expect(Buffer.byteLength(JSON.stringify(stopped))).toBeLessThan(4 * 1024 * 1024 + 1024)
  expect(f.adapter.dispose).toHaveBeenCalledTimes(1)
  service = new ConversationService(f.directory, f.factory)
  await expect(service.send(session.id, 'retry', '2', f.launch)).rejects.toThrow(/history limit/)
  expect(f.adapter.send).toHaveBeenCalledTimes(1)
})

test('history never silently evicts older entries and closed records leave the active list', async () => {
  const f = fixture()
  let service = new ConversationService(f.directory, f.factory)
  const { session } = await service.create(f.options, f.launch)
  const path = join(f.directory, `${session.id}.json`)
  const record = JSON.parse(readFileSync(path, 'utf8'))
  record.snapshot.entries = Array.from({ length: 600 }, (_, i) => ({
    kind: 'message',
    id: `${i}`,
    role: 'assistant',
    text: 'old'
  }))
  writeFileSync(path, JSON.stringify(record))
  service = new ConversationService(f.directory, f.factory)
  expect(service.snapshot(session.id).entries).toHaveLength(600)
  service.updateMetadata(session.id, { workspaceId: 'workspace' })
  service.updateMetadata(session.id, { workspaceId: null })
  expect(service.snapshot(session.id).session.workspaceId).toBeUndefined()
  await service.close(session.id)
  expect(service.list()).toEqual([])
  expect(service.snapshot(session.id).entries).toHaveLength(600)
})

test('UTF8 message size is enforced and safe initialization diagnostic is bounded', async () => {
  const f = fixture()
  const service = new ConversationService(f.directory, f.factory)
  const { session } = await service.create(f.options, f.launch)
  await expect(service.send(session.id, '漢'.repeat(50000), 'large')).rejects.toThrow(
    /Invalid message/
  )
  f.adapter.start.mockRejectedValue(
    Object.assign(new Error('secret raw error'), { safeMessage: 'Executable unavailable' })
  )
  await expect(service.send(session.id, 'hello', '1')).rejects.toThrow(/Executable unavailable/)
  expect(service.snapshot(session.id).session.error).not.toContain('secret')
})

test('large list rejects explicitly rather than exceeding a UTF8 transport frame', async () => {
  const f = fixture()
  const service = new ConversationService(f.directory, f.factory)
  const value = '漢'.repeat(8192)
  const options = {
    ...f.options,
    cwd: value,
    title: value,
    workspaceId: value,
    windowKey: value,
    launchProfileId: value,
    claudeProfileId: value,
    configDir: value,
    model: value,
    piProvider: value,
    piThinking: value,
    resumeSessionId: value
  }
  for (let i = 0; i < 32; i++) await service.create(options, { ...f.launch, options })
  expect(() => service.list()).toThrow(/list exceeds transport limit/)
}, 15000)

test('timer flushes an unfinished burst durably and sequences remain contiguous', async () => {
  const f = fixture()
  const service = new ConversationService(f.directory, f.factory)
  const { session } = await service.create(f.options, f.launch)
  await service.send(session.id, 'hello', '1')
  const sequence = service.snapshot(session.id).sequence
  const events: number[] = []
  service.onEvent((event) => {
    const persisted = JSON.parse(readFileSync(join(f.directory, `${session.id}.json`), 'utf8'))
    expect(persisted.snapshot.sequence).toBe(event.sequence)
    events.push(event.sequence)
  })
  for (let i = 0; i < 100; i++) f.emit({ type: 'text-delta', messageId: 'a', text: 'x' })
  await new Promise((resolve) => setTimeout(resolve, 60))
  expect(events).toEqual([sequence + 1])
  expect(service.snapshot(session.id).entries.at(-1)).toMatchObject({ text: 'x'.repeat(100) })
})

test('closed archives do not consume the active session limit', async () => {
  const f = fixture()
  const seed = await new ConversationService(f.directory, f.factory).create(f.options, f.launch)
  for (let i = 0; i < 1000; i++) {
    const id = `conversation-${i.toString(16)}`
    writeFileSync(
      join(f.directory, `${id}.json`),
      JSON.stringify({
        snapshot: { ...seed, session: { ...seed.session, id, status: 'closed' } },
        commands: [],
        events: []
      })
    )
  }
  const service = new ConversationService(f.directory, f.factory)
  await expect(service.create(f.options, f.launch)).resolves.toBeDefined()
  expect(service.list()).toHaveLength(2)
})

// Inferred fixture shape keeps the fake adapter spies available to assertions.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'clave-conversation-'))
  directories.push(directory)
  let emit: EmitConversationEvent = () => {}
  const adapter = {
    capabilities: { permissions: true, questions: true, resume: true },
    start: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    respond: vi.fn(async () => {}),
    dispose: vi.fn(async () => {})
  }
  const factory: AdapterFactory = (_launch, callback) => {
    emit = callback
    return adapter
  }
  const options = { provider: 'claude' as const, cwd: '/tmp' }
  const launch: AdapterLaunch = {
    options,
    command: ['fake'],
    additionalArgs: [],
    env: { SECRET: 'never-store-this' },
    sessionDirectory: directory
  }
  return {
    directory,
    adapter,
    factory,
    options,
    launch,
    emit: (event: Parameters<EmitConversationEvent>[0]) => emit(event)
  }
}

test('persists the concrete resolved launch profile on creation and first restart launch', async () => {
  const f = fixture()
  const service = new ConversationService(f.directory, f.factory)
  const launch = {
    ...f.launch,
    options: { ...f.options, launchProfileId: 'resolved-default' }
  }
  const created = await service.create(f.options, launch)
  expect(created.session.launchProfileId).toBe('resolved-default')
  const legacy = await service.create(f.options, f.launch)
  const restored = new ConversationService(f.directory, f.factory)
  expect(restored.snapshot(created.session.id).session.launchProfileId).toBe('resolved-default')
  await restored.send(legacy.session.id, 'hello', 'first', launch)
  const restarted = new ConversationService(f.directory, f.factory)
  expect(restarted.snapshot(legacy.session.id).session.launchProfileId).toBe('resolved-default')
})

test('does not complete a closed legacy import through a transient archived record', async () => {
  const f = fixture()
  const service = new ConversationService(f.directory, f.factory)
  const sourceId = '11111111-1111-1111-1111-111111111111'
  const { session } = await service.prepareLegacyImport(f.options, f.launch, {
    sourceId,
    recordKey: sourceId,
    complete: false
  })
  await service.close(session.id)
  expect(() => service.completeLegacyImport(session.id)).toThrow('closed')
  const restored = new ConversationService(f.directory, f.factory)
  expect(() => restored.completeLegacyImport(session.id)).toThrow('closed')
  expect(restored.snapshot(session.id).session.legacyImport?.complete).toBe(false)
})

test('durable idempotency, concurrent send rejection and restart without command replay', async () => {
  const f = fixture()
  const service = new ConversationService(f.directory, f.factory)
  const created = await service.create(f.options, f.launch)
  expect(created.session.id).toMatch(/^conversation-/)
  await service.send(created.session.id, 'hello', 'command-1')
  await service.send(created.session.id, 'hello', 'command-1')
  expect(f.adapter.send).toHaveBeenCalledTimes(1)
  await expect(service.send(created.session.id, 'other', 'command-2')).rejects.toThrow(/running/)
  f.emit({ type: 'provider-session', providerSessionId: 'remote-123' })
  f.emit({ type: 'request', request: { id: 'permission', kind: 'permission', title: 'Read?' } })
  const restored = new ConversationService(f.directory, f.factory)
  expect(restored.snapshot(created.session.id).session.status).toBe('stopped')
  expect(restored.snapshot(created.session.id).requests).toEqual([])
  await restored.send(created.session.id, 'hello', 'command-1', f.launch)
  expect(f.adapter.send).toHaveBeenCalledTimes(1)
  await restored.send(created.session.id, 'continue', 'command-3', f.launch)
  expect(f.adapter.send).toHaveBeenCalledTimes(2)
  expect(readFileSync(join(f.directory, `${created.session.id}.json`), 'utf8')).not.toContain(
    'never-store-this'
  )
})

test('permission responses are gated by pending request and kind; close disposes', async () => {
  const f = fixture()
  const service = new ConversationService(f.directory, f.factory)
  const { session } = await service.create(f.options, f.launch)
  await service.send(session.id, 'hello', '1')
  f.emit({ type: 'request', request: { id: 'p', kind: 'permission', title: 'Read?' } })
  await expect(service.respond(session.id, { requestId: 'p', answer: 'yes' })).rejects.toThrow()
  await expect(
    service.respond(session.id, { requestId: 'missing', decision: 'allow' })
  ).rejects.toThrow()
  await service.respond(session.id, { requestId: 'p', decision: 'deny' })
  await expect(service.respond(session.id, { requestId: 'p', decision: 'allow' })).rejects.toThrow()
  expect(f.adapter.respond).toHaveBeenCalledTimes(1)
  await service.close(session.id)
  expect(f.adapter.dispose).toHaveBeenCalledTimes(1)
  expect(service.snapshot(session.id).session.status).toBe('closed')
})

test('subscribers disconnect without disposing sessions and sequence snapshots deduplicate', async () => {
  const f = fixture()
  const service = new ConversationService(f.directory, f.factory)
  const seen: number[] = []
  const off = service.onEvent((event) => seen.push(event.sequence))
  const { session } = await service.create(f.options, f.launch)
  await service.send(session.id, 'hello', '1')
  off()
  const sequence = service.snapshot(session.id).sequence
  f.emit({ type: 'text-delta', messageId: 'a', text: 'still alive' })
  expect(service.snapshot(session.id).sequence).toBe(sequence + 1)
  expect(new Set(seen).size).toBe(seen.length)
  expect(f.adapter.dispose).not.toHaveBeenCalled()
})

test('creation is lazy; fresh launch and durable metadata preserve the fixed provider', async () => {
  const f = fixture()
  const factory = vi.fn(f.factory)
  const service = new ConversationService(f.directory, factory)
  const { session } = await service.create(f.options, f.launch)
  expect(factory).not.toHaveBeenCalled()
  service.updateMetadata(session.id, { title: 'Renamed', windowKey: 'window-2' })
  const fresh = { ...f.launch, env: { FRESH: 'value' } }
  await service.send(session.id, 'hello', '1', fresh)
  expect(factory.mock.calls[0][0].env).toEqual({ FRESH: 'value' })
  const restored = new ConversationService(f.directory, f.factory)
  expect(restored.snapshot(session.id).session).toMatchObject({
    title: 'Renamed',
    windowKey: 'window-2',
    provider: 'claude'
  })
  await expect(
    restored.send(session.id, 'wrong', '2', {
      ...fresh,
      options: { ...f.options, provider: 'codex' }
    })
  ).rejects.toThrow()
})

test('storage failure prevents provider execution and is not silently acknowledged', async () => {
  const f = fixture()
  const service = new ConversationService(f.directory, f.factory)
  const { session } = await service.create(f.options, f.launch)
  rmSync(f.directory, { recursive: true, force: true })
  await expect(service.send(session.id, 'hello', '1')).rejects.toThrow(/storage failed/)
  expect(f.adapter.send).not.toHaveBeenCalled()
  expect(() => service.snapshot(session.id)).toThrow(/storage failed/)
})
