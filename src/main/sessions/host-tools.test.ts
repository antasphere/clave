import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionManager } from './session-manager'

/**
 * What the host does for the served agent tools (wave 4): a rename kept on
 * the record as the sidebar's rename keeps it, the page on a tab's row, a
 * message typed into a chat tab as a user message. The manager and the PTY
 * manager are fakes; the lifecycle is mocked where the host only delegates.
 */
const mocks = vi.hoisted(() => ({
  setSessionDisplayName: vi.fn(),
  setSessionViewRecord: vi.fn(),
  folderName: 'app',
  typed: vi.fn(async () => ({ submitted: true, draftHandling: 'none' as const })),
  notifyChatMessage: vi.fn()
}))
vi.mock('electron', () => {
  throw new Error('the host imported electron')
})
vi.mock('../pty-manager', () => ({
  ptyManager: {
    setSessionDisplayName: mocks.setSessionDisplayName,
    setSessionViewRecord: mocks.setSessionViewRecord,
    getSession: (id: string) => (id === 'gone' ? undefined : { id, folderName: mocks.folderName })
  }
}))
vi.mock('./lifecycle', () => ({
  readScreen: vi.fn(),
  restartSession: vi.fn(),
  typeIntoSession: mocks.typed,
  resizeSession: vi.fn(),
  spawnSession: vi.fn(),
  stopSession: vi.fn(),
  writeTerminal: vi.fn()
}))
vi.mock('../title-generator', () => ({ notifyChatMessage: mocks.notifyChatMessage }))
vi.mock('./attachments', () => ({ preparePrompt: vi.fn() }))
vi.mock('./chat-model-default', () => ({ rememberChatEffort: vi.fn(), rememberChatModel: vi.fn() }))
vi.mock('./chat-view-default', () => ({ rememberChatView: vi.fn() }))
vi.mock('./records', () => ({ sessionRecords: () => ({}) }))
import { createSessionHost } from './host'

const sessions = new Map<string, { id: string; transport: string; title: string }>()
const writes: unknown[] = []
const manager = {
  get: (id: string) => sessions.get(id),
  write: (id: string, input: unknown) => void writes.push([id, input]),
  capabilities: () => ({ images: false })
} as unknown as SessionManager
const host = createSessionHost({
  manager,
  lifecycle: {
    spawn: vi.fn(),
    stop: vi.fn(),
    resize: vi.fn(),
    writeTerminal: vi.fn()
  }
})

beforeEach(() => {
  vi.clearAllMocks()
  sessions.clear()
  writes.length = 0
  sessions.set('t1', { id: 't1', transport: 'pty', title: 'app' })
  sessions.set('c1', { id: 'c1', transport: 'events', title: 'chat' })
})

describe('a rename through the host', () => {
  it('keeps the name on the record, protected from the auto-title', () => {
    host.rename('t1', ' Lane D ')
    expect(mocks.setSessionDisplayName).toHaveBeenCalledWith('t1', 'Lane D', true)
  })
  it('a name equal to the folder name, or empty, is "no name", still protected', () => {
    host.rename('t1', 'app')
    host.rename('t1', '   ')
    expect(mocks.setSessionDisplayName.mock.calls).toEqual([
      ['t1', null, true],
      ['t1', null, true]
    ])
  })
  it('refuses an unknown tab', () => {
    expect(() => host.rename('zz', 'x')).toThrow('Unknown session: zz')
    expect(mocks.setSessionDisplayName).not.toHaveBeenCalled()
  })
})

describe('the page on a tab, and a message typed in', () => {
  it('writes the page to the record, null to take it off', () => {
    host.setPage('t1', { url: 'http://x', title: 'X' })
    host.setPage('t1', null)
    expect(mocks.setSessionViewRecord.mock.calls).toEqual([
      ['t1', { url: 'http://x', title: 'X' }],
      ['t1', null]
    ])
    expect(() => host.setPage('zz', null)).toThrow('Unknown session: zz')
  })
  it('types into a terminal through the lifecycle, and into a chat as a user message', async () => {
    expect(await host.type('t1', 'hello')).toEqual({ submitted: true, draftHandling: 'none' })
    expect(mocks.typed).toHaveBeenCalledWith('t1', 'hello')
    expect(await host.type('c1', 'hello')).toEqual({ submitted: true, draftHandling: 'none' })
    expect(writes).toEqual([['c1', { type: 'user_message', text: 'hello' }]])
    expect(mocks.notifyChatMessage).toHaveBeenCalledWith('c1', 'hello', null)
    await expect(host.type('zz', 'x')).rejects.toThrow('Unknown session: zz')
  })
})
