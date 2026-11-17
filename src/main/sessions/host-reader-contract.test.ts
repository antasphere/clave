import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HistoryPage, Session, SessionEvent, SessionStream } from '../../shared/session-model'
import type { SessionAdapter, SessionAdapterEvents } from './adapter'
import { SessionManager } from './session-manager'

/**
 * What the hosts tell a view when it binds, read by the reader that loads the
 * conversation (PRDCT-4664).
 *
 * The two sides live in different places and were changed apart: the hosts
 * (`host.ts`, `server-owned-host.ts`, `request-aware-host.ts`) decide what a
 * late view is told without a position, and the chat views' reader
 * (`plugins/chat-view/src/conversation-reader.ts`) decides what to make of it.
 * On 14 and 15 November 2026 the host started telling the model and the
 * waiting messages; on 16 November the reader arrived with a list of types
 * that named neither, and every Claude chat of v3.0.0-beta.25 stayed empty.
 * Nothing ran the two together. This does: the real manager, the real hosts
 * in the order the server stacks them, a session made ready before any view
 * binds (the separate server's order, and the one a Claude chat breaks on),
 * and the real reader on the other end.
 */
vi.mock('electron', () => {
  throw new Error('the host imported electron')
})
vi.mock('../pty-manager', () => ({ ptyManager: {} }))
vi.mock('./lifecycle', () => ({
  readScreen: vi.fn(),
  restartSession: vi.fn(),
  typeIntoSession: vi.fn(),
  resizeSession: vi.fn(),
  spawnSession: vi.fn(),
  stopSession: vi.fn(),
  writeTerminal: vi.fn()
}))
vi.mock('../title-generator', () => ({ notifyChatMessage: vi.fn() }))
vi.mock('./attachments', () => ({ preparePrompt: vi.fn() }))
vi.mock('./chat-model-default', () => ({ rememberChatEffort: vi.fn(), rememberChatModel: vi.fn() }))
vi.mock('./chat-view-default', () => ({ rememberChatView: vi.fn() }))
vi.mock('./records', () => ({ sessionRecords: {} }))
import { PendingRequests } from '../../../packages/server/src/requests/service'
import { conversationReader } from '../../../plugins/chat-view/src/conversation-reader'
import { standaloneSidebar } from '../server/standalone-sidebar'
import { createSessionHost } from './host'
import { requestAwareSessionHost } from './request-aware-host'
import { serverOwnedSessionHost } from './server-owned-host'

const ID = 'a'
const record: Session = {
  id: ID,
  provider: 'claude',
  adapterId: 'stand-in-chat',
  transport: 'events',
  cwd: '/tmp',
  windowKey: 'w',
  state: 'idle',
  createdAt: 1,
  title: 'Stand-in'
}
const BRIEF = 'the brief its opener gave it'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

/** The hosts as the server stacks them (`server-entry.ts`), over a session
 *  whose agent speaks the moment it is made ready, as a Claude chat does: its
 *  model, the launch's prompt as the first message, the start of an answer,
 *  what runs in the background and what waits. */
function stack(): {
  host: ReturnType<typeof requestAwareSessionHost>['host']
  manager: SessionManager
  say: (event: SessionEvent) => void
  ask: () => void
} {
  const manager = new SessionManager()
  const emitter = new EventEmitter()
  const say = (event: SessionEvent): void => {
    emitter.emit('stream', { kind: 'event', event })
  }
  const adapter: SessionAdapter = {
    id: 'stand-in-chat',
    provider: 'claude',
    transports: ['events'],
    spawn: vi.fn(),
    attach: vi.fn(async (id: string) => ({ id })),
    write: vi.fn(),
    kill: vi.fn(),
    ready: () => {
      say({ type: 'session_meta', model: 'stand-in-1', providerSessionId: null })
      say({ type: 'user_message', text: BRIEF })
      say({ type: 'state_change', state: 'working' })
      say({ type: 'assistant_text', delta: 'On it', final: false })
      say({
        type: 'background_tasks',
        tasks: [{ id: 't1', kind: 'shell', description: 'a build', startedAt: 1 }]
      })
      say({
        type: 'waiting_messages',
        messages: [{ id: 'w1', text: 'one more thing' }],
        takes: 'turn'
      } as SessionEvent)
    },
    on: <K extends keyof SessionAdapterEvents>(
      _handle: { id: string },
      event: K,
      cb: (value: SessionAdapterEvents[K]) => void
    ) => {
      emitter.on(event, cb)
      return () => {
        emitter.off(event, cb)
      }
    }
  }
  manager.adopt(record, { id: ID }, adapter)
  const dataDir = mkdtempSync(join(tmpdir(), 'clave-host-reader-'))
  dirs.push(dataDir)
  const base = createSessionHost({
    manager,
    lifecycle: { spawn: vi.fn(), stop: vi.fn(), resize: vi.fn(), writeTerminal: vi.fn() }
  })
  const owned = serverOwnedSessionHost({
    host: base,
    dataDir,
    sidebar: standaloneSidebar(dataDir),
    ready: (id) => manager.ready(id),
    currentState: (id) => manager.currentState(id),
    subscribeAll: (listener) => manager.subscribeAll(listener)
  })
  const aware = requestAwareSessionHost({
    host: owned.host,
    requests: new PendingRequests(),
    subscribeAll: (listener) => manager.subscribeAll(listener),
    subscribeRemoved: (listener) => manager.subscribeRemoved(listener),
    publish: (id, event) => manager.publishHostEvent(id, event),
    setState: (id, state) => manager.setState(id, state)
  })
  // A host that tells a late view one thing more than today's do, of a type
  // no list ever named: the reader must read it as it reads the others. With
  // a list of types back in the reader, this is the frame that stops it.
  const host: typeof aware.host = {
    ...aware.host,
    subscribe: (id, listener) => {
      const off = aware.host.subscribe(id, listener)
      listener({ kind: 'event', event: { type: 'effort', effort: 'high' } })
      return off
    }
  }
  return {
    host,
    manager,
    say,
    ask: () => {
      aware.createHosted({
        sessionId: ID,
        description: 'Before it goes on.',
        questions: [{ id: 'name', question: 'A name for it', kind: 'text' as const, options: [] }]
      })
    }
  }
}

/** A chat view on the host: the reader, fed by the subscription, reading its
 *  snapshot through the host's own ports. */
function view(host: ReturnType<typeof stack>['host']): {
  told: SessionEvent[]
  shown: SessionEvent[]
  failed: ReturnType<typeof vi.fn>
  pages: () => number
  stop: () => void
} {
  const told: SessionEvent[] = []
  const shown: SessionEvent[] = []
  const failed = vi.fn()
  let pages = 0
  const reader = conversationReader(
    {
      timeline: async (before, limit) => host.timeline?.(ID, before, limit) ?? null,
      // The wire's page is the view's, read-only.
      history: async (before, limit) => host.history(ID, before, limit) as unknown as HistoryPage
    },
    {
      page: (page) => {
        pages += 1
        shown.length = 0
        shown.push(...page.items.map((item) => item.event as SessionEvent))
      },
      event: (item) => {
        shown.push(item.event as SessionEvent)
      },
      reading: () => {},
      failed
    }
  )
  const off = host.subscribe(ID, (frame) => {
    if (frame.kind !== 'event') return
    if (!frame.position) told.push(frame.event as SessionEvent)
    reader.stream(frame as unknown as SessionStream)
  })
  reader.start()
  return {
    told,
    shown,
    failed,
    pages: () => pages,
    stop: () => {
      reader.stop()
      off()
    }
  }
}

const types = (events: SessionEvent[]): string[] => [...new Set(events.map((e) => e.type))].sort()

describe('what the hosts tell a view that binds, read by the conversation reader', () => {
  it('a view that binds after the session spoke reads the whole conversation, the first message included', async () => {
    const s = stack()
    // The separate server makes a session ready at its start: everything
    // below is said before any view exists.
    s.manager.ready(ID)
    s.ask()
    const pane = view(s.host)
    await settle()
    expect(pane.failed).not.toHaveBeenCalled()
    expect(pane.pages()).toBe(1)
    expect(pane.shown).toContainEqual({ type: 'user_message', text: BRIEF })
    expect(pane.shown).toContainEqual({ type: 'assistant_text', delta: 'On it', final: false })
    // The roads this pins: every one of these reached the view with no
    // position at the bind. A host that tells one more is read the same way.
    expect(types(pane.told)).toEqual([
      'background_tasks',
      'effort',
      'permission_request',
      'session_meta',
      'state_change',
      'waiting_messages'
    ])
    // The one thing more reached the view itself, not only its listener: a
    // reader that held a list of types would have let it go in silence.
    expect(pane.shown).toContainEqual({ type: 'effort', effort: 'high' })
    // And the conversation goes on in it.
    s.say({ type: 'assistant_text', delta: ', done.', final: true })
    expect(pane.shown.at(-1)).toEqual({ type: 'assistant_text', delta: ', done.', final: true })
    expect(pane.failed).not.toHaveBeenCalled()
    pane.stop()
  })

  it('a second view, bound later still, reads the same conversation', async () => {
    const s = stack()
    s.manager.ready(ID)
    const first = view(s.host)
    await settle()
    s.say({ type: 'assistant_text', delta: ' and more', final: true })
    const second = view(s.host)
    await settle()
    for (const pane of [first, second]) {
      expect(pane.failed).not.toHaveBeenCalled()
      expect(pane.shown.filter((e) => e.type === 'user_message')).toEqual([
        { type: 'user_message', text: BRIEF }
      ])
      expect(pane.shown.filter((e) => e.type === 'assistant_text')).toHaveLength(2)
    }
    first.stop()
    second.stop()
  })
})
