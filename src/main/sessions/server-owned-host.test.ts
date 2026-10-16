import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionHost, type SessionHostService, type StartInput } from '@clave/server'
import type {
  Session,
  SessionRecord,
  SessionInfo,
  SessionStream as WireStream
} from '@clave/contract/sessions'
import type { SessionStream } from '../../shared/session-model'
import { standaloneSidebar } from '../server/standalone-sidebar'
import { serverOwnedSessionHost } from './server-owned-host'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))
const directory = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'clave-vps-b-host-'))
  dirs.push(dir)
  return dir
}
const record: SessionRecord = {
  id: '9e3a0b11-0000-4000-8000-000000000001',
  cwd: '/repo',
  folderName: 'repo',
  adapterId: 'codex-chat',
  transport: 'events',
  claudeMode: false,
  antigravityMode: false,
  codexMode: true,
  piMode: false,
  claudeAgentsMode: false,
  dangerousMode: false,
  model: 'saved-model',
  launchProfileId: 'saved-profile',
  codexAccountId: 'saved-account',
  codexThreadId: 'saved-thread',
  windowKey: 'mac-a',
  displayName: 'Kept title',
  startedAt: 123,
  live: false
}
const session: Session = {
  id: record.id,
  cwd: record.cwd,
  provider: 'codex',
  transport: 'events',
  adapterId: 'codex-chat',
  windowKey: 'server',
  state: 'idle',
  createdAt: 123,
  title: 'Kept title'
}

function fixture(dataDir = directory()): {
  host: SessionHostService
  close: () => void
  dataDir: string
  base: SessionHostService
  live: Map<string, Session>
  start: ReturnType<typeof vi.fn<(input: StartInput) => Promise<SessionInfo>>>
  stop: ReturnType<typeof vi.fn<(id: string) => Promise<void>>>
  sidebar: ReturnType<typeof standaloneSidebar>
  ready: ReturnType<typeof vi.fn>
  emit: (id: string, value: SessionStream) => void
} {
  const live = new Map<string, Session>()
  const records = new Map([
    [
      record.id,
      structuredClone({
        ...record,
        initialCommand: 'never-replay-command',
        autoExecute: true,
        initialPrompt: 'never-replay-prompt'
      })
    ]
  ])
  let stream: ((id: string, value: SessionStream) => void) | undefined
  const start = vi.fn(async (input: StartInput) => {
    const id = input.options?.adoptSessionId ?? 'fresh-session'
    live.set(id, { ...session, id, windowKey: input.windowKey ?? '' })
    return {
      id,
      cwd: input.cwd,
      folderName: 'repo',
      alive: true,
      claudeSessionId: null,
      piSessionId: null
    }
  })
  const stop = vi.fn(async (id: string) => {
    live.delete(id)
    records.delete(id)
  })
  const base: SessionHostService = {
    ...SessionHost.none,
    list: () => [...live.values()],
    get: (id) => live.get(id),
    listAdoptableRecords: () => [...records.values()],
    start,
    stop,
    subscribe: vi.fn(() => () => {}),
    subscribeExit: vi.fn(() => () => {}),
    discardRecord: (id) => {
      records.delete(id)
    },
    keepOnRecord: vi.fn()
  }
  const sidebar = standaloneSidebar(dataDir)
  const ready = vi.fn()
  const owned = serverOwnedSessionHost({
    host: base,
    dataDir,
    sidebar,
    ready,
    subscribeAll: (fn) => {
      stream = fn
      return () => {
        stream = undefined
      }
    }
  })
  return {
    ...owned,
    dataDir,
    base,
    live,
    start,
    stop,
    sidebar,
    ready,
    emit: (id: string, value: SessionStream) => stream?.(id, value)
  }
}

describe('server-owned stopped recovery', () => {
  it('lists and subscribes to restored stopped sessions without spawning or making them ready', () => {
    const f = fixture()
    expect(f.host.list('another-mac')[0]).toMatchObject({
      id: record.id,
      state: 'ended',
      windowKey: 'server'
    })
    expect(f.host.get(record.id)?.title).toBe('Kept title')
    const off = f.host.subscribe(record.id, () => {})
    f.host.resize(record.id, 100, 30)
    off()
    expect(f.start).not.toHaveBeenCalled()
    expect(f.ready).not.toHaveBeenCalled()
    expect(f.base.subscribe).not.toHaveBeenCalled()
    f.close()
  })

  it('requires explicit Resume and resumes owned settings without replaying shell commands', async () => {
    const f = fixture()
    await expect(
      f.host.start({
        cwd: '/wrong',
        options: { adoptSessionId: record.id, initialCommand: 'danger', autoExecute: true }
      })
    ).rejects.toThrow('Resume')
    const [a, b] = await Promise.all([
      f.host.restart(record.id, {}, true),
      f.host.restart(record.id, {}, true)
    ])
    expect(a.id).toBe(record.id)
    expect(b.id).toBe(record.id)
    expect(f.start).toHaveBeenCalledTimes(1)
    const input = f.start.mock.calls[0][0]
    expect(input).toMatchObject({
      cwd: '/repo',
      windowKey: 'server',
      options: {
        adoptSessionId: record.id,
        resumeSessionId: 'saved-thread',
        launchProfileId: 'saved-profile',
        codexAccountId: 'saved-account',
        model: 'saved-model'
      }
    })
    expect(input.options?.initialCommand).toBeUndefined()
    expect(input.options?.autoExecute).toBeUndefined()
    expect(input.options?.initialPrompt).toBeUndefined()
    expect(input.options?.adoptTmuxName).toBeUndefined()
    f.close()
  })

  it('keeps sessions alive through client release/unsubscribe and closes placement everywhere', async () => {
    const f = fixture()
    const result = await f.host.start({ cwd: '/repo', windowKey: 'mac-a' })
    expect(f.sidebar.get('mac-b').displayOrder).toContain(result.id)
    const off = f.host.subscribe(result.id, () => {})
    off()
    f.host.release([result.id], 'mac-b')
    expect(f.stop).not.toHaveBeenCalled()
    expect(f.host.get(result.id)).toBeDefined()
    await f.host.stop(result.id)
    expect(f.sidebar.get('mac-a').displayOrder).not.toContain(result.id)
    expect(f.stop).toHaveBeenCalledWith(result.id)
    f.close()
  })

  it('retains chat history and terminal bytes across restart with no provider start', () => {
    const f = fixture()
    f.emit(record.id, {
      kind: 'event',
      event: { type: 'assistant_text', delta: 'persisted answer', final: true }
    })
    f.emit(record.id, { kind: 'pty', data: Buffer.from('terminal scrollback') })
    f.close()
    const restarted = fixture(f.dataDir)
    expect(restarted.host.history(record.id).items).toContainEqual(
      expect.objectContaining({
        event: { type: 'assistant_text', delta: 'persisted answer', final: true }
      })
    )
    const received: WireStream[] = []
    restarted.host.subscribe(record.id, (value) => received.push(value))
    expect(
      received.some(
        (value) =>
          value.kind === 'pty' && Buffer.from(value.data).toString() === 'terminal scrollback'
      )
    ).toBe(true)
    expect(restarted.start).not.toHaveBeenCalled()
    restarted.close()
  })
})

it('reattaches an existing stopped subscription when another client explicitly resumes it', async () => {
  const f = fixture()
  const off = f.host.subscribe(record.id, () => {})
  const offExit = f.host.subscribeExit(record.id, () => {})
  expect(f.base.subscribe).not.toHaveBeenCalled()
  await f.host.restart(record.id, {}, false)
  expect(f.base.subscribe).toHaveBeenCalledWith(record.id, expect.any(Function))
  expect(f.base.subscribeExit).toHaveBeenCalledWith(record.id, expect.any(Function))
  off()
  offExit()
  f.close()
})

it('refuses a Resume racing an already requested close instead of leaving an orphan', async () => {
  const f = fixture()
  const closing = f.host.stop(record.id)
  await expect(f.host.restart(record.id, {}, false)).rejects.toThrow('closing')
  await closing
  expect(f.start).not.toHaveBeenCalled()
  expect(f.host.get(record.id)).toBeUndefined()
  f.close()
})

it('closes the actual process when close arrives during an in-flight Resume', async () => {
  const f = fixture()
  const start = f.start.getMockImplementation()!
  let finish!: () => void
  f.start.mockImplementationOnce(async (input) => {
    await new Promise<void>((resolve) => {
      finish = resolve
    })
    return start(input)
  })
  const resuming = f.host.restart(record.id, {}, false)
  const closing = f.host.stop(record.id)
  try {
    await Promise.resolve()
    expect(f.stop).not.toHaveBeenCalled()
  } finally {
    finish()
    await Promise.all([resuming, closing])
    f.close()
  }
  expect(f.stop).toHaveBeenCalledWith(record.id)
  expect(f.live.has(record.id)).toBe(false)
  expect(f.host.get(record.id)).toBeUndefined()
  expect(f.host.listAdoptableRecords()).toHaveLength(0)
  expect(f.sidebar.get('another-client').displayOrder).not.toContain(record.id)
})
