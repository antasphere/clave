import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionHost, type SessionHostService, type StartInput } from '@clave/server'
import type {
  Session,
  SessionRecord,
  SessionInfo,
  SessionStream as WireStream
} from '@clave/contract/sessions'
import type { HistoryItem, SessionStream } from '../../shared/session-model'
import { standaloneSidebar } from '../server/standalone-sidebar'
import { OBSERVE_EVERY_MS, serverOwnedSessionHost, stoppedSession } from './server-owned-host'
import { JournalTimeline } from './journal-timeline'
import type { Timeline } from './timeline'
import { readTimelineFile, removeTimelineFile, writeTimelineFile } from './timeline-store'
import { resumeOptions } from './resume-options'
import type { ServerConversations } from '../session-history/server-conversations'

type WireStateFrame = Extract<SessionStream, { kind: 'event' }>['event']
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
  launchProfile: {
    id: 'saved-profile',
    name: 'Mac profile',
    family: 'codex',
    command: ['mac-wrapper', 'codex'],
    additionalArgs: ['--profile', 'mac']
  },
  codexAccountId: 'saved-account',
  codexThreadId: 'saved-thread',
  windowKey: 'mac-a',
  displayName: 'Kept title',
  startedAt: 123,
  spawnedBy: '9e3a0b11-0000-4000-8000-0000000000aa',
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

function fixture(
  dataDir = directory(),
  extra: {
    currentState?: (id: string) => WireStateFrame | undefined
    conversations?: ServerConversations
    timelines?: { stopped(id: string): Timeline | undefined; forget(id: string): void }
  } = {}
): {
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
    discardRecord: vi.fn((id: string) => {
      records.delete(id)
    }),
    keepOnRecord: vi.fn(),
    history: () => ({ items: [], before: null })
  }
  const sidebar = standaloneSidebar(dataDir)
  const ready = vi.fn()
  const owned = serverOwnedSessionHost({
    host: base,
    dataDir,
    sidebar,
    ready,
    ...(extra.currentState ? { currentState: extra.currentState } : {}),
    ...(extra.conversations ? { conversations: extra.conversations } : {}),
    ...(extra.timelines ? { timelines: extra.timelines } : {}),
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

/** Where the server keeps each chat's run (PRDCT-4666), as `server-entry.ts` wires it. */
const journals = (
  dataDir: string
): {
  dir: string
  stopped(id: string): Timeline | undefined
  forget: ReturnType<typeof vi.fn<(id: string) => void>>
} => {
  const dir = join(dataDir, 'session-timelines')
  return {
    dir,
    stopped: (id) => {
      const file = readTimelineFile(dir, id)
      return file && JournalTimeline.stopped(file)
    },
    forget: vi.fn((id: string) => removeTimelineFile(dir, id))
  }
}
/** A finished run of a chat, as the manager leaves it on disk. */
const finishedRun = (dir: string, id: string, items: HistoryItem[]): void => {
  const file = writeTimelineFile(dir, id)
  for (const item of items) file.append(item)
  file.close()
}
/** A chat checkpoint as a server before PRDCT-4666 wrote it. */
const legacyCheckpoint = (dataDir: string, id: string, items: HistoryItem[]): void => {
  const dir = join(dataDir, 'server-history')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ items, terminal: '' }), { mode: 0o600 })
}

describe('server-owned stopped recovery', () => {
  it('adds only the current optional workspace stamp to the curated stopped descriptor', () => {
    const bare = stoppedSession(record)
    expect(bare).toEqual({ ...session, state: 'ended' })
    const rich = {
      ...record,
      workspaceId: 'opaque-workspace',
      configDir: '/private/config',
      initialCommand: 'private-command',
      view: { url: 'https://private.example', title: 'Private' }
    }
    expect(stoppedSession(rich)).toEqual({ ...bare, workspaceId: 'opaque-workspace' })
    expect(stoppedSession({ ...rich, workspaceId: '' })).toEqual({ ...bare, workspaceId: '' })
    const cleared = { ...rich, workspaceId: undefined }
    expect(stoppedSession(cleared)).toEqual(bare)
    expect(stoppedSession(cleared)).not.toHaveProperty('workspaceId')
  })

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
        model: 'saved-model',
        // The tab that opened it, so the resumed tab folds and reports back (#259, V1-F2).
        spawnedBy: record.spawnedBy
      }
    })
    expect(input.options?.launchProfile).toEqual(record.launchProfile)
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
    // The chat's run, as the manager keeps it (PRDCT-4666); the screen, as the host does.
    finishedRun(journals(f.dataDir).dir, record.id, [
      { event: { type: 'assistant_text', delta: 'persisted answer', final: true } }
    ])
    f.emit(record.id, { kind: 'pty', data: Buffer.from('terminal scrollback') })
    f.close()
    const restarted = fixture(f.dataDir, { timelines: journals(f.dataDir) })
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

describe('live server-retained history', () => {
  it('writes no checkpoint for a chat event, and still keeps a terminal screen (PRDCT-4666)', () => {
    const f = fixture()
    f.live.set(record.id, session)
    const checkpoint = join(f.dataDir, 'server-history', `${record.id}.json`)
    try {
      f.emit(record.id, {
        kind: 'event',
        event: { type: 'assistant_text', delta: 'real live reply', final: true }
      })
      expect(existsSync(checkpoint)).toBe(false)
      f.emit(record.id, { kind: 'pty', data: Buffer.from('a screen') })
      expect(existsSync(checkpoint)).toBe(true)
      expect(readFileSync(checkpoint, 'utf8')).not.toContain('real live reply')
    } finally {
      f.close()
    }
  })

  it('answers a live session from its host alone, an empty page included (PRDCT-4666)', () => {
    const f = fixture()
    f.live.set(record.id, session)
    legacyCheckpoint(f.dataDir, record.id, [
      { event: { type: 'assistant_text', delta: 'checkpoint only', final: true } }
    ])
    const empty = { items: [], before: null }
    const history = vi.spyOn(f.base, 'history').mockReturnValue(empty)
    try {
      expect(f.host.history(record.id, 4, 2)).toBe(empty)
      expect(f.host.history(record.id)).toBe(empty)
      expect(history.mock.calls).toEqual([
        [record.id, 4, 2],
        [record.id, undefined, undefined]
      ])
    } finally {
      f.close()
    }
  })

  it('returns adapter pages unchanged with the exact requested cursor and limit', () => {
    const f = fixture()
    f.live.set(record.id, session)
    const page = {
      items: [
        {
          event: {
            type: 'assistant_text' as const,
            delta: 'provider transcript',
            final: true
          },
          at: 42
        }
      ],
      before: 7
    }
    const history = vi.spyOn(f.base, 'history').mockReturnValue(page)
    try {
      f.emit(record.id, {
        kind: 'event',
        event: {
          type: 'assistant_text',
          delta: 'checkpoint only',
          final: true
        }
      })
      expect(f.host.history(record.id, 9, 2)).toBe(page)
      expect(history).toHaveBeenCalledExactlyOnceWith(record.id, 9, 2)
    } finally {
      f.close()
    }
  })

  it('keeps an empty adapter boundary page when the latest adapter page has history', () => {
    const f = fixture()
    f.live.set(record.id, session)
    const empty = { items: [], before: null }
    const history = vi
      .spyOn(f.base, 'history')
      .mockImplementation((_id: string, before?: number) =>
        before === 0
          ? empty
          : {
              items: [
                { event: { type: 'assistant_text' as const, delta: 'provider', final: true } }
              ],
              before: null
            }
      )
    try {
      f.emit(record.id, {
        kind: 'event',
        event: {
          type: 'assistant_text',
          delta: 'checkpoint only',
          final: true
        }
      })
      expect(f.host.history(record.id, 0, 2)).toBe(empty)
      expect(history.mock.calls[0]).toEqual([record.id, 0, 2])
    } finally {
      f.close()
    }
  })

  it('preserves an empty adapter page with a continuation cursor', () => {
    const f = fixture()
    f.live.set(record.id, session)
    const page = { items: [], before: 3 }
    vi.spyOn(f.base, 'history').mockReturnValue(page)
    try {
      expect(f.host.history(record.id, 6, 2)).toBe(page)
    } finally {
      f.close()
    }
  })

  it('propagates adapter history errors and rejects checkpoint-only unknown sessions', () => {
    const f = fixture()
    f.live.set(record.id, session)
    vi.spyOn(f.base, 'history').mockImplementation(() => {
      throw new Error('provider history failed')
    })
    try {
      expect(() => f.host.history(record.id)).toThrow('provider history failed')
      f.emit('unowned', {
        kind: 'event',
        event: {
          type: 'assistant_text',
          delta: 'unowned checkpoint',
          final: true
        }
      })
      expect(() => f.host.history('unowned')).toThrow('Unknown session')
    } finally {
      f.close()
    }
  })
})

describe('the state a subscriber binds to (PRDCT-4191)', () => {
  // A server chat tab stayed "Session ended" after the server resumed it: the
  // pane seeds its state from the list it read at mount, and a resumed chat
  // starts idle, a state nothing publishes. The host now tells it at bind.
  const frames = (received: WireStream[]): unknown[] =>
    received.flatMap((value) =>
      value.kind === 'event' && value.event.type === 'state_change' ? [value.event] : []
    )

  it('tells a subscriber of a live session its current state, with the run', async () => {
    const currentState = vi.fn(
      (): WireStateFrame => ({ type: 'state_change', state: 'working', run: 3 })
    )
    const f = fixture(directory(), { currentState })
    const started = await f.host.start({ cwd: '/repo' })
    const received: WireStream[] = []
    const off = f.host.subscribe(started.id, (value) => received.push(value))
    expect(currentState).toHaveBeenCalledWith(started.id)
    expect(frames(received)).toEqual([{ type: 'state_change', state: 'working', run: 3 }])
    off()
    f.close()
  })

  it('tells a stopped record ended, with no run, after its saved terminal', () => {
    const currentState = vi.fn()
    const f = fixture(directory(), { currentState })
    f.emit(record.id, { kind: 'pty', data: Buffer.from('saved screen') })
    const received: WireStream[] = []
    const off = f.host.subscribe(record.id, (value) => received.push(value))
    expect(received).toHaveLength(2)
    expect(received[0].kind).toBe('pty')
    expect(received[1]).toEqual({ kind: 'event', event: { type: 'state_change', state: 'ended' } })
    // Nothing runs, so there is no live state to ask for.
    expect(currentState).not.toHaveBeenCalled()
    off()
    f.close()
  })

  it('tells the already-bound subscriber the new process state when a Resume binds it', async () => {
    const f = fixture(directory(), {
      currentState: (id) =>
        f.live.has(id) ? { type: 'state_change', state: 'idle', run: 2 } : undefined
    })
    const received: WireStream[] = []
    const off = f.host.subscribe(record.id, (value) => received.push(value))
    expect(frames(received)).toEqual([{ type: 'state_change', state: 'ended' }])
    await f.host.restart(record.id, {}, false)
    // The pane learns the chat is idle again, under the run that resumed it.
    expect(frames(received)).toEqual([
      { type: 'state_change', state: 'ended' },
      { type: 'state_change', state: 'idle', run: 2 }
    ])
    off()
    f.close()
  })

  it('tells nothing of a live session when no currentState is given, as before', async () => {
    const f = fixture()
    const started = await f.host.start({ cwd: '/repo' })
    const received: WireStream[] = []
    const off = f.host.subscribe(started.id, (value) => received.push(value))
    expect(frames(received)).toEqual([])
    off()
    f.close()
  })
})

describe('resumeOptions carries what the chat was running on (PRDCT-4191, PRDCT-4192)', () => {
  it('carries the opener, so "parent" and the reach rule survive a Resume', () => {
    const opener = '9e3a0b11-0000-4000-8000-0000000000bb'
    expect(resumeOptions({ ...record, openedBy: opener }).openedBy).toBe(opener)
  })

  it('turns a reported bypass into dangerousMode with no permissionMode', () => {
    const options = resumeOptions({ ...record, permissionMode: 'bypassPermissions' })
    expect(options.dangerousMode).toBe(true)
    expect(options.permissionMode).toBeUndefined()
  })

  it('passes a reported plan mode and leaves the launch bypass off', () => {
    const options = resumeOptions({ ...record, dangerousMode: true, permissionMode: 'plan' })
    expect(options).toMatchObject({ dangerousMode: false, permissionMode: 'plan' })
  })

  it('keeps the record dangerousMode when no mode was reported', () => {
    expect(resumeOptions({ ...record, dangerousMode: true }).dangerousMode).toBe(true)
    expect(resumeOptions(record).dangerousMode).toBe(false)
    expect(resumeOptions(record).permissionMode).toBeUndefined()
  })

  it('resumes a Pi session through its session id, as the launch wants it (round 2, N-F3)', () => {
    const options = resumeOptions({
      ...record,
      claudeMode: false,
      piMode: true,
      claudeSessionId: undefined,
      codexThreadId: undefined,
      piSessionId: 'pi-77'
    })
    expect(options.resumeSessionId).toBe('pi-77')
  })

  it('passes a well-formed effort and drops one that is not', () => {
    expect(resumeOptions({ ...record, effort: 'high' }).effort).toBe('high')
    expect(resumeOptions({ ...record, effort: 'HIGH; rm' }).effort).toBeUndefined()
    expect('effort' in resumeOptions({ ...record, effort: 'HIGH; rm' })).toBe(false)
  })
})

describe('a Resume of a running session is refused on the server (round 3, C2)', () => {
  it('rejects with onlyIfStopped and restarts nothing; a move without it still restarts', async () => {
    const f = fixture()
    const started = await f.host.start({ cwd: '/repo' })
    const restart = vi.fn(async () => ({
      id: started.id,
      cwd: '/repo',
      folderName: 'repo',
      alive: true,
      claudeSessionId: null,
      piSessionId: null,
      resumed: true
    }))
    ;(f.base as unknown as { restart: typeof restart }).restart = restart
    await expect(f.host.restart(started.id, {}, false, true)).rejects.toThrow(
      'This session is running; there is nothing to resume.'
    )
    expect(restart).not.toHaveBeenCalled()
    await f.host.restart(started.id, {}, false)
    expect(restart).toHaveBeenCalledTimes(1)
    // A stopped record resumes with the precondition as without it.
    const resumed = await f.host.restart(record.id, {}, false, true)
    expect(resumed.id).toBe(record.id)
    f.close()
  })
})

describe('a chat whose CLI exited on its own resumes (round 5, major 1)', () => {
  it('is held by the manager in state ended, and a Resume with onlyIfStopped goes through', async () => {
    const f = fixture()
    const started = await f.host.start({ cwd: '/repo' })
    // The process ended by itself: the entry stays, in state ended.
    f.live.set(started.id, { ...f.live.get(started.id)!, state: 'ended' })
    const restart = vi.fn(async () => ({
      id: started.id,
      cwd: '/repo',
      folderName: 'repo',
      alive: true,
      claudeSessionId: null,
      piSessionId: null,
      resumed: true
    }))
    ;(f.base as unknown as { restart: typeof restart }).restart = restart
    await expect(f.host.restart(started.id, {}, false, true)).resolves.toMatchObject({
      id: started.id
    })
    expect(restart).toHaveBeenCalledTimes(1)
    f.close()
  })
  it('joins a Resume already in flight instead of refusing it', async () => {
    const f = fixture()
    const first = f.host.restart(record.id, {}, false, true)
    const second = f.host.restart(record.id, {}, false, true)
    expect(second).toBe(first)
    await first
    f.close()
  })
})

describe('a Resume of a chat the host still holds binds and readies the new process (round 6)', () => {
  it('rebinds the subscribers and makes the new process ready, as the record road does', async () => {
    // The state told at bind is the LIVE entry's at that moment: a bind made
    // before the restart would tell the held entry's `ended` and bind the
    // subscribers to a process the restart then replaces (round 7, R4).
    const f = fixture(directory(), {
      currentState: (id) => {
        const live = f.live.get(id)
        return live ? { type: 'state_change', state: live.state, run: 2 } : undefined
      }
    })
    const started = await f.host.start({ cwd: '/repo' })
    const received: WireStream[] = []
    f.host.subscribe(started.id, (value) => received.push(value))
    f.live.set(started.id, { ...f.live.get(started.id)!, state: 'ended' })
    const restart = vi.fn(async () => {
      // The new process: a new entry under the same id.
      f.live.set(started.id, { ...session, id: started.id, state: 'idle' })
      return {
        id: started.id,
        cwd: '/repo',
        folderName: 'repo',
        alive: true,
        claudeSessionId: null,
        piSessionId: null,
        resumed: true
      }
    })
    ;(f.base as unknown as { restart: typeof restart }).restart = restart
    const readyBefore = f.ready.mock.calls.length
    const subscribesBefore = (f.base.subscribe as ReturnType<typeof vi.fn>).mock.calls.length
    await f.host.restart(started.id, {}, false, true)
    expect(f.ready.mock.calls.length).toBe(readyBefore + 1)
    expect((f.base.subscribe as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      subscribesBefore + 1
    )
    // The already-bound subscriber hears the new process's state.
    expect(received.at(-1)).toEqual({
      kind: 'event',
      event: { type: 'state_change', state: 'idle', run: 2 }
    })
    f.close()
  })
})

describe('a move to another provider rides through the server-owned host (PRDCT-4300)', () => {
  it('forwards the provider override for a running session', async () => {
    const f = fixture()
    const started = await f.host.start({ cwd: '/repo' })
    const restart = vi.fn(async () => ({
      id: started.id,
      cwd: '/repo',
      folderName: 'repo',
      alive: true,
      claudeSessionId: null,
      piSessionId: null,
      resumed: true
    }))
    ;(f.base as unknown as { restart: typeof restart }).restart = restart
    const provider = { adapterId: 'codex-chat', model: 'gpt-5.5', resume: 'thread-7' }
    await f.host.restart(started.id, { codexAccountId: 'c1' }, false, undefined, provider)
    expect(restart).toHaveBeenCalledWith(
      started.id,
      { codexAccountId: 'c1' },
      false,
      undefined,
      provider
    )
    f.close()
  })
  it('rebuilds a stopped record’s spawn on the other adapter, resuming the converted thread', async () => {
    const f = fixture()
    await f.host.restart(
      record.id,
      { codexAccountId: 'c1', codexAccountLabel: 'Codex 1' },
      false,
      undefined,
      {
        adapterId: 'codex-chat',
        model: 'gpt-5.5',
        resume: 'thread-7',
        continuedFrom: { provider: 'claude', road: 'converted' }
      }
    )
    expect(f.start).toHaveBeenCalledTimes(1)
    expect(f.start.mock.calls[0][0]).toMatchObject({
      cwd: '/repo',
      options: {
        adoptSessionId: record.id,
        codexMode: true,
        claudeMode: false,
        launchProfileId: 'codex-chat',
        resumeSessionId: 'thread-7',
        model: 'gpt-5.5',
        codexAccountId: 'c1',
        continuedFrom: { provider: 'claude', road: 'converted' }
      }
    })
    f.close()
  })
})

describe('the server’s own History is told what its tabs run (PRDCT-4321)', () => {
  const fakeConversations = (): ServerConversations & {
    observe: ReturnType<typeof vi.fn<(id: string) => void>>
    closing: ReturnType<typeof vi.fn<(record: SessionRecord) => void>>
  } => ({
    observe: vi.fn<(id: string) => void>(),
    closing: vi.fn<(record: SessionRecord) => void>(),
    list: () => ({ conversations: [] }),
    search: async () => ({ hits: [], filesSearched: 0, truncated: false })
  })
  const discardSpy = (f: ReturnType<typeof fixture>): ReturnType<typeof vi.fn> =>
    f.base.discardRecord as unknown as ReturnType<typeof vi.fn>

  it('observes a tab it starts', async () => {
    const conversations = fakeConversations()
    const f = fixture(directory(), { conversations })
    const started = await f.host.start({ cwd: '/repo' })
    expect(conversations.observe).toHaveBeenCalledWith(started.id)
    f.close()
  })

  it('stamps a closed tab’s last word before its record is discarded', async () => {
    const conversations = fakeConversations()
    const f = fixture(directory(), { conversations })
    await f.host.stop(record.id)
    expect(conversations.closing).toHaveBeenCalledTimes(1)
    expect(conversations.closing.mock.calls[0][0]).toMatchObject({ id: record.id })
    const discard = discardSpy(f)
    expect(discard).toHaveBeenCalledWith(record.id)
    expect(conversations.closing.mock.invocationCallOrder[0]).toBeLessThan(
      discard.mock.invocationCallOrder[0]
    )
    f.close()
  })

  it('stamps a stopped record’s last word before a discard by key', () => {
    const conversations = fakeConversations()
    const f = fixture(directory(), { conversations })
    f.host.discardRecord(record.id)
    expect(conversations.closing).toHaveBeenCalledTimes(1)
    expect(conversations.closing.mock.calls[0][0]).toMatchObject({ id: record.id })
    const discard = discardSpy(f)
    expect(discard).toHaveBeenCalledWith(record.id)
    expect(conversations.closing.mock.invocationCallOrder[0]).toBeLessThan(
      discard.mock.invocationCallOrder[0]
    )
    expect(f.host.listAdoptableRecords()).toHaveLength(0)
    f.close()
  })

  it('observes a renamed tab after the rename', async () => {
    const conversations = fakeConversations()
    const f = fixture(directory(), { conversations })
    const started = await f.host.start({ cwd: '/repo' })
    conversations.observe.mockClear()
    const rename = vi.fn((id: string, name: string) => ({ ...f.live.get(id)!, title: name }))
    ;(f.base as unknown as { rename: typeof rename }).rename = rename
    f.host.rename(started.id, 'Invoices')
    expect(rename).toHaveBeenCalledWith(started.id, 'Invoices')
    expect(conversations.observe).toHaveBeenCalledWith(started.id)
    expect(conversations.observe.mock.invocationCallOrder[0]).toBeGreaterThan(
      rename.mock.invocationCallOrder[0]
    )
    f.close()
  })

  it('observes a tab at a state change that ends a turn, and at no other event', () => {
    const conversations = fakeConversations()
    const f = fixture(directory(), { conversations })
    f.emit(record.id, {
      kind: 'event',
      event: { type: 'assistant_text', delta: 'an answer', final: true }
    })
    f.emit(record.id, { kind: 'pty', data: Buffer.from('bytes') })
    expect(conversations.observe).not.toHaveBeenCalled()
    f.emit(record.id, { kind: 'event', event: { type: 'state_change', state: 'idle' } })
    expect(conversations.observe).toHaveBeenCalledTimes(1)
    expect(conversations.observe).toHaveBeenCalledWith(record.id)
    f.close()
  })

  it('observes at a turn’s end only, never as a turn starts or waits', () => {
    const conversations = fakeConversations()
    const f = fixture(directory(), { conversations })
    for (const state of ['working', 'blocked'] as const)
      f.emit(record.id, { kind: 'event', event: { type: 'state_change', state } })
    expect(conversations.observe).not.toHaveBeenCalled()
    f.emit(record.id, { kind: 'event', event: { type: 'state_change', state: 'idle' } })
    expect(conversations.observe).toHaveBeenCalledTimes(1)
    f.emit('another-tab', { kind: 'event', event: { type: 'state_change', state: 'ended' } })
    expect(conversations.observe).toHaveBeenCalledTimes(2)
    expect(conversations.observe).toHaveBeenLastCalledWith('another-tab')
    f.close()
  })

  it('takes a chat’s `done` as a turn’s end (the Claude and Codex adapters end a turn so)', () => {
    const conversations = fakeConversations()
    const f = fixture(directory(), { conversations })
    f.emit(record.id, { kind: 'event', event: { type: 'state_change', state: 'working' } })
    expect(conversations.observe).not.toHaveBeenCalled()
    f.emit(record.id, { kind: 'event', event: { type: 'state_change', state: 'done' } })
    expect(conversations.observe).toHaveBeenCalledTimes(1)
    expect(conversations.observe).toHaveBeenCalledWith(record.id)
    f.close()
  })

  it('observes a tab once a `/clear` is kept on its record, after the record names it', () => {
    const conversations = fakeConversations()
    const f = fixture(directory(), { conversations })
    const keep = f.base.keepOnRecord as unknown as ReturnType<typeof vi.fn>
    f.host.keepOnRecord(record.id, { claudeSessionId: 'new' })
    expect(keep).toHaveBeenCalledWith(record.id, { claudeSessionId: 'new' })
    expect(conversations.observe).toHaveBeenCalledTimes(1)
    expect(conversations.observe).toHaveBeenCalledWith(record.id)
    expect(conversations.observe.mock.invocationCallOrder[0]).toBeGreaterThan(
      keep.mock.invocationCallOrder[0]
    )
    f.close()
  })

  it('keeps a name, a page or a workspace on the record with no observe', () => {
    const conversations = fakeConversations()
    const f = fixture(directory(), { conversations })
    const keep = f.base.keepOnRecord as unknown as ReturnType<typeof vi.fn>
    const name = { displayName: 'Invoices', userRenamed: true }
    f.host.keepOnRecord(record.id, { name })
    f.host.keepOnRecord(record.id, { page: null })
    f.host.keepOnRecord(record.id, { workspaceId: 'ws-2' })
    expect(keep.mock.calls).toEqual([
      [record.id, { name }],
      [record.id, { page: null }],
      [record.id, { workspaceId: 'ws-2' }]
    ])
    expect(conversations.observe).not.toHaveBeenCalled()
    f.close()
  })

  it('observes a tab at most once per five seconds from its turns', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-11-10T12:00:00.000Z'))
      const conversations = fakeConversations()
      const f = fixture(directory(), { conversations })
      const idle = (): void =>
        f.emit(record.id, { kind: 'event', event: { type: 'state_change', state: 'idle' } })
      idle()
      vi.setSystemTime(Date.now() + OBSERVE_EVERY_MS - 1)
      idle()
      f.emit(record.id, { kind: 'event', event: { type: 'state_change', state: 'ended' } })
      expect(conversations.observe).toHaveBeenCalledTimes(1)
      vi.setSystemTime(Date.now() + 1)
      idle()
      expect(conversations.observe).toHaveBeenCalledTimes(2)
      expect(OBSERVE_EVERY_MS).toBe(5_000)
      f.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('observes a stopped record’s Resume once it resolved', async () => {
    const conversations = fakeConversations()
    const f = fixture(directory(), { conversations })
    const start = f.start.getMockImplementation()!
    let finish!: () => void
    f.start.mockImplementationOnce(async (input) => {
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      return start(input)
    })
    const resuming = f.host.restart(record.id, {}, false)
    await Promise.resolve()
    expect(f.start).toHaveBeenCalledTimes(1)
    expect(conversations.observe).not.toHaveBeenCalled()
    finish()
    await resuming
    expect(conversations.observe).toHaveBeenCalledTimes(1)
    expect(conversations.observe).toHaveBeenCalledWith(record.id)
    f.close()
  })
})

describe('stopped conversation timeline', () => {
  it('reads bounded checkpoints without starting a provider and resets generation across server restart', () => {
    const f = fixture()
    legacyCheckpoint(f.dataDir, record.id, [{ event: { type: 'user_message', text: 'kept' } }])
    const first = f.host.timeline!(record.id)
    expect(first.items.map(({ event }) => event.type)).toEqual(['user_message'])
    expect(first.truncated).toBe(true)
    expect(f.host.timeline!(record.id)).toEqual(first)
    expect(f.start).not.toHaveBeenCalled()
    expect(f.ready).not.toHaveBeenCalled()
    f.close()
    const restarted = fixture(f.dataDir)
    expect(restarted.host.timeline!(record.id).cursor.generation).not.toBe(first.cursor.generation)
    expect(restarted.host.timeline!(record.id).items[0].event).toEqual(first.items[0].event)
    expect(() => restarted.host.timeline!('unknown')).toThrow('Unknown session')
    restarted.close()
  })
  const run = Array.from({ length: 1000 }, (_, n) => ({
    event:
      n % 2 === 0
        ? { type: 'user_message' as const, text: `q${n}` }
        : { type: 'assistant_text' as const, delta: `a${n}`, final: true }
  }))
  it('reads a stopped tab whole from its last run’s file (PRDCT-4666)', () => {
    const dataDir = directory()
    const timelines = journals(dataDir)
    finishedRun(timelines.dir, record.id, run)
    // An older checkpoint is there too: the run's file wins.
    legacyCheckpoint(dataDir, record.id, [{ event: { type: 'user_message', text: 'old' } }])
    const f = fixture(dataDir, { timelines })
    const timelineItems: unknown[] = []
    let before: number | null | undefined
    do {
      const page = f.host.timeline!(record.id, before ?? undefined, 200)
      expect(page.truncated).toBe(false)
      timelineItems.unshift(...page.items.map(({ event }) => ({ event })))
      before = page.before
    } while (before !== null)
    expect(timelineItems).toEqual(run)
    const historyItems: unknown[] = []
    let older: number | null | undefined
    do {
      const page = f.host.history(record.id, older ?? undefined, 200)
      historyItems.unshift(...page.items)
      older = page.before
    } while (older !== null)
    expect(historyItems).toEqual(run)
    expect(f.start).not.toHaveBeenCalled()
    f.close()
  })
  it('falls back to the legacy checkpoint when a stopped tab has no run file', () => {
    const dataDir = directory()
    legacyCheckpoint(dataDir, record.id, [{ event: { type: 'user_message', text: 'kept' } }])
    const f = fixture(dataDir, { timelines: journals(dataDir) })
    const page = f.host.timeline!(record.id)
    expect(page.items.map(({ event }) => event)).toEqual([{ type: 'user_message', text: 'kept' }])
    expect(page.truncated).toBe(true)
    expect(f.host.history(record.id).items.map(({ event }) => event)).toEqual([
      { type: 'user_message', text: 'kept' }
    ])
    f.close()
  })
  it('answers the checkpoint when a stopped tab’s run file cannot be read', () => {
    const dataDir = directory()
    legacyCheckpoint(dataDir, record.id, [{ event: { type: 'user_message', text: 'kept' } }])
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const stopped = vi.fn((): Timeline | undefined => {
      throw new Error('A timeline file must be owned by this user with mode 0600')
    })
    try {
      const f = fixture(dataDir, { timelines: { stopped, forget: vi.fn() } })
      const page = f.host.timeline!(record.id)
      expect(page.truncated).toBe(true)
      expect(page.items.map(({ event }) => event)).toEqual([{ type: 'user_message', text: 'kept' }])
      expect(f.host.history(record.id).items.map(({ event }) => event)).toEqual([
        { type: 'user_message', text: 'kept' }
      ])
      expect(error).toHaveBeenCalledTimes(1)
      f.close()
    } finally {
      error.mockRestore()
    }
  })
  it('keeps 32 stopped tabs’ timelines at most, letting the oldest go', () => {
    const dataDir = directory()
    const files = journals(dataDir)
    const ids = Array.from({ length: 33 }, (_, n) => `stopped-${n}`)
    for (const id of ids) finishedRun(files.dir, id, run)
    const closed: string[] = []
    const opened: string[] = []
    const f = fixture(dataDir, {
      timelines: {
        stopped: (id) => {
          const timeline = files.stopped(id)!
          opened.push(id)
          return {
            ...timeline,
            close: () => {
              closed.push(id)
              timeline.close()
            }
          }
        },
        forget: files.forget
      }
    })
    Object.assign(f.base, { listAdoptableRecords: () => ids.map((id) => ({ ...record, id })) })
    for (const id of ids.slice(0, 32)) f.host.timeline!(id)
    // A hit makes the first the newest: the second is now the oldest.
    f.host.timeline!(ids[0])
    expect(closed).toEqual([])
    f.host.timeline!(ids[32])
    expect(closed).toEqual([ids[1]])
    f.host.timeline!(ids[1])
    expect(closed).toEqual([ids[1], ids[2]])
    // Read again, it is whole.
    const items: unknown[] = []
    let before: number | null | undefined
    do {
      const page = f.host.timeline!(ids[1], before ?? undefined, 200)
      items.unshift(...page.items.map(({ event }) => ({ event })))
      before = page.before
    } while (before !== null)
    expect(items).toEqual(run)
    expect(opened.filter((id) => id === ids[1])).toHaveLength(2)
    f.close()
  })
  it('answers an evicted stopped tab with the generation it had, so a reader pages on', () => {
    const dataDir = directory()
    const files = journals(dataDir)
    const ids = Array.from({ length: 33 }, (_, n) => `paged-${n}`)
    for (const id of ids) finishedRun(files.dir, id, run)
    const f = fixture(dataDir, { timelines: files })
    Object.assign(f.base, {
      listAdoptableRecords: () => ids.map((id) => ({ ...record, id }))
    })
    const newest = f.host.timeline!(ids[0], undefined, 200)
    expect(newest.before).not.toBeNull()
    // 32 other stopped tabs are read: the first one's timeline is let go.
    for (const id of ids.slice(1)) f.host.timeline!(id)
    const older = f.host.timeline!(ids[0], newest.before!, 200)
    expect(older.cursor.generation).toBe(newest.cursor.generation)
    expect(older.items.at(-1)!.position.sequence).toBe(newest.items[0].position.sequence - 1)
    f.close()
  })
  it('forgets a discarded or closed tab’s run file', async () => {
    const dataDir = directory()
    const timelines = journals(dataDir)
    finishedRun(timelines.dir, record.id, run)
    const f = fixture(dataDir, { timelines })
    f.host.timeline!(record.id)
    f.host.discardRecord(record.id)
    expect(timelines.forget).toHaveBeenCalledWith(record.id)
    expect(existsSync(join(timelines.dir, `${record.id}.jsonl`))).toBe(false)
    f.close()
    const g = fixture(directory(), { timelines })
    finishedRun(timelines.dir, record.id, run)
    await g.host.stop(record.id)
    expect(timelines.forget).toHaveBeenCalledTimes(2)
    expect(existsSync(join(timelines.dir, `${record.id}.jsonl`))).toBe(false)
    g.close()
  })
  it('delegates live timeline reads and rebinds subscriptions after a live restart', async () => {
    const f = fixture()
    f.live.set(record.id, session)
    const page = {
      items: [],
      before: null,
      cursor: { generation: 'live', sequence: 0 },
      truncated: false
    } as const
    Object.assign(f.base, { timeline: vi.fn(() => page) })
    Object.assign(f.base, {
      restart: vi.fn(async () => ({
        id: record.id,
        cwd: '/repo',
        folderName: 'repo',
        alive: true,
        claudeSessionId: null,
        piSessionId: null,
        resumed: true
      }))
    })
    const off = f.host.subscribe(record.id, () => {})
    expect(f.host.timeline!(record.id)).toBe(page)
    await f.host.restart(record.id, {}, false)
    expect(f.base.subscribe).toHaveBeenCalledTimes(2)
    off()
    f.close()
  })
})
