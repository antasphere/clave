import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installTerminalPorts, resetTerminalPorts } from '../../ports/terminals'
import { PiRpcAdapter, piRequestLeftConnection } from './pi-rpc-adapter'
import type { SessionHandle } from '../adapter'
import type { SessionEvent } from '../../../shared/session-model'

/**
 * A Pi chat on a stored connection sends nothing off it (PRDCT-4540): Clave's
 * extension, loaded by the stand-in Pi as Pi loads it, checks each provider
 * request and ends one that would leave the connection; the chat ends the
 * turn with one sentence naming where Pi was, and says "put it back" only
 * once a request has gone on the connection again.
 */

const PI = resolve(__dirname, '../../../../tests/e2e/fixtures/pi-rpc-agent.mjs')
const RESOURCES = resolve(__dirname, '../../../../resources')
const KEY = 'made-up-stand-in-key-4540'

const dirs: string[] = []
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-watch-'))
  dirs.push(dir)
  return dir
}
const live: { kill: () => Promise<void> }[] = []
beforeEach(() => installTerminalPorts({ resourcesDir: RESOURCES }))
afterEach(async () => {
  for (const s of live.splice(0)) await s.kill().catch(() => {})
  resetTerminalPorts()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function open(env: Record<string, string> = {}): Promise<{
  adapter: PiRpcAdapter
  handle: SessionHandle
  events: SessionEvent[]
  report: string
  say: (text: string) => Promise<void>
}> {
  const state = tmp()
  const report = join(state, 'tab.connection')
  const adapter = new PiRpcAdapter({ id: 'pi-chat', provider: 'pi', label: 'Pi' })
  const id = `pi-watch-${randomUUID()}`
  adapter.configure(id, {
    command: [
      process.execPath,
      PI,
      '--provider',
      'stand-in',
      '--model',
      'one',
      '--mode',
      'rpc',
      '--session-id',
      randomUUID(),
      '--session-dir',
      state
    ],
    env: { ...process.env, STAND_IN_API_KEY: KEY, ...env },
    connection: { provider: 'stand-in', variables: ['STAND_IN_API_KEY'] },
    connectionReportFile: report
  })
  const handle = await adapter.spawn({
    id,
    provider: 'pi',
    transport: 'events',
    cwd: state,
    windowKey: 'w',
    state: 'idle',
    createdAt: 0,
    adapterId: 'pi-chat',
    title: 'Pi',
    options: {}
  })
  live.push({ kill: () => adapter.kill(handle) })
  const events: SessionEvent[] = []
  adapter.on(handle, 'stream', (stream) => {
    if (stream.kind === 'event') events.push(stream.event)
  })
  adapter.ready(handle)
  const say = async (text: string): Promise<void> => {
    const before = events.filter((e) => e.type === 'state_change' && e.state === 'done').length
    adapter.write(handle, { type: 'user_message', text })
    await expect
      .poll(() => events.filter((e) => e.type === 'state_change' && e.state === 'done').length, {
        timeout: 8000
      })
      .toBeGreaterThan(before)
  }
  return { adapter, handle, events, report, say }
}

const notices = (events: SessionEvent[]): string[] =>
  events.flatMap((e) => (e.type === 'error' ? [e.message] : []))
const texts = (events: SessionEvent[]): string =>
  events.map((e) => (e.type === 'assistant_text' ? e.delta : '')).join('')

describe('a Pi chat on a connection sends nothing off it (PRDCT-4540)', () => {
  it('a request on the connection goes, and the report says on', async () => {
    const chat = await open()
    await chat.say('hello on it')
    expect(texts(chat.events)).toContain('You said: hello on it')
    expect(readFileSync(chat.report, 'utf8')).toBe('on\n')
    expect(notices(chat.events)).toEqual([])
  })

  it('an extension that moves Pi before each run (R3-1): nothing sent, the turn ends with the sentence', async () => {
    const chat = await open({ PI_STAND_IN_MOVE_BEFORE_RUN: 'anthropic/claude-stand-in' })
    await chat.say('hello moved')
    expect(texts(chat.events)).not.toContain('You said: hello moved')
    expect(readFileSync(chat.report, 'utf8')).toBe('off anthropic\n')
    expect(notices(chat.events)).toContain(piRequestLeftConnection('Pi', 'anthropic', 'stand-in'))
    expect(notices(chat.events).join(' ')).not.toMatch(/put it back/)
    expect(chat.events.some((e) => e.type === 'turn_interrupted')).toBe(true)
  })

  it('a /login in the tab (the same provider, another credential): nothing sent either', async () => {
    const chat = await open({ PI_STAND_IN_LOGIN_KEY: 'made-up-login-key' })
    await chat.say('hello login')
    expect(texts(chat.events)).not.toContain('You said: hello login')
    expect(readFileSync(chat.report, 'utf8')).toBe('off stand-in credential\n')
    expect(notices(chat.events)).toContain(
      "Pi was about to send this turn to stand-in with another credential than this chat's connection: nothing was sent, and the turn ended."
    )
    expect(readFileSync(chat.report, 'utf8')).not.toContain('made-up-login-key')
  })

  it('"put it back" only once a request has gone on the connection again', async () => {
    const chat = await open({ PI_STAND_IN_ENV_PROVIDERS: '1', ANTHROPIC_API_KEY: 'made-up-a' })
    // Moved to Anthropic by something typed: that turn's request is ended.
    await chat.say('please use anthropic')
    expect(notices(chat.events)).toContain(piRequestLeftConnection('Pi', 'anthropic', 'stand-in'))
    expect(notices(chat.events).join(' ')).not.toMatch(/put it back/)
    // The next message: the chat puts Pi back, the request goes on it, and
    // only then the sentence, after the turn's own text.
    const from = chat.events.length
    await chat.say('back again')
    const after = chat.events.slice(from)
    expect(texts(after)).toContain('You said: back again')
    expect(readFileSync(chat.report, 'utf8')).toBe('on\n')
    const back = after.findIndex((e) => e.type === 'error' && /put it back/.test(e.message))
    const said = after.findIndex((e) => e.type === 'assistant_text')
    expect(said).toBeGreaterThanOrEqual(0)
    expect(back).toBeGreaterThan(said)
  })

  it('a chat on no connection is told nothing: no report is written', async () => {
    const state = tmp()
    const adapter = new PiRpcAdapter({ id: 'pi-chat', provider: 'pi', label: 'Pi' })
    adapter.configure('plain', {
      command: [process.execPath, PI, '--mode', 'rpc', '--session-dir', state],
      env: { ...process.env, PI_STAND_IN_MOVE_BEFORE_RUN: 'anthropic/claude-stand-in' }
    })
    const handle = await adapter.spawn({
      id: 'plain',
      provider: 'pi',
      transport: 'events',
      cwd: state,
      windowKey: 'w',
      state: 'idle',
      createdAt: 0,
      adapterId: 'pi-chat',
      title: 'Pi',
      options: {}
    })
    live.push({ kill: () => adapter.kill(handle) })
    const events: SessionEvent[] = []
    adapter.on(handle, 'stream', (s) => {
      if (s.kind === 'event') events.push(s.event)
    })
    adapter.ready(handle)
    adapter.write(handle, { type: 'user_message', text: 'free' })
    await expect.poll(() => texts(events), { timeout: 8000 }).toContain('You said: free')
    expect(existsSync(join(state, 'tab.connection'))).toBe(false)
  })
})
