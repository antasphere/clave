/**
 * The provider connections over IPC (PRDCT-4426): a key goes in through
 * `provider-connections:set-key` and never comes back out, neither in an
 * answer, nor in the `provider-connections:changed` event a window hears,
 * nor in anything main prints while it saves one. The settings source is a
 * fake here: what is under test is the handlers' own road.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const KEY = 'sk-test-ipc-0123456789abcdefghijklmnopqrstuvwxyz'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
const sent: Array<{ channel: string; args: unknown[] }> = []
const windows = [
  {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, ...args: unknown[]) => sent.push({ channel, args })
    }
  }
]

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn)
  },
  BrowserWindow: { getAllWindows: () => windows }
}))

const fake = vi.hoisted(() => {
  const view = (id: string, hasKey: boolean): Record<string, unknown> => ({
    id,
    label: 'Moonshot',
    company: 'moonshot',
    kind: 'key',
    pool: 'moonshot',
    endpoints: [{ wireFormat: 'openai-chat', baseUrl: 'https://api.kimi.ai/coding/v1' }],
    needsKey: true,
    hasKey,
    keySetAt: hasKey ? 1 : null,
    createdAt: 1
  })
  const listeners: Array<(event: { _tag: string; [k: string]: unknown }) => void> = []
  const calls: Array<{ method: string; args: unknown[] }> = []
  const record =
    <T>(method: string, answer: (...args: unknown[]) => T) =>
    async (...args: unknown[]): Promise<T> => {
      calls.push({ method, args })
      return answer(...args)
    }
  return {
    view,
    listeners,
    calls,
    source: {
      providerConnections: {
        list: record('list', () => [view('c1', false)]),
        add: record('add', () => view('c1', false)),
        rename: record('rename', (id) => ({ ...view(String(id), false), label: 'Renamed' })),
        remove: record('remove', () => true),
        setKey: record('setKey', (id) => view(String(id), true))
      },
      subscribe: (listener: (event: { _tag: string; [k: string]: unknown }) => void) => {
        listeners.push(listener)
        return () => {}
      }
    }
  }
})

vi.mock('../settings/shell-source', () => ({ shellSettingsSource: fake.source }))

import { registerProviderConnectionsHandlers } from './provider-connections-handlers'

const call = (channel: string, ...args: unknown[]): Promise<unknown> => {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`no handler for ${channel}`)
  return Promise.resolve().then(() => handler({}, ...args))
}

beforeEach(() => {
  handlers.clear()
  sent.length = 0
  fake.listeners.length = 0
  fake.calls.length = 0
  registerProviderConnectionsHandlers()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the provider connection handlers', () => {
  it('answers a key save with the view, never the key', async () => {
    const answer = await call('provider-connections:set-key', 'c1', KEY)
    expect(answer).toMatchObject({ id: 'c1', hasKey: true })
    expect(JSON.stringify(answer)).not.toContain(KEY)
    expect(fake.calls).toEqual([{ method: 'setKey', args: ['c1', KEY] }])
  })

  it('prints nothing that carries the key while it saves one', async () => {
    const spies = (['log', 'error', 'warn', 'info', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {})
    )
    // The process streams too: a direct write would pass the console spies.
    const streams = [
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true),
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    ]
    const written: unknown[] = []
    try {
      await call('provider-connections:set-key', 'c1', KEY)
    } finally {
      // Read before the restore, which clears the recorded calls.
      for (const stream of streams) {
        for (const [chunk] of stream.mock.calls) written.push(chunk)
        stream.mockRestore()
      }
    }
    for (const chunk of written) {
      const text = Buffer.isBuffer(chunk)
        ? chunk.toString('utf-8')
        : chunk instanceof Uint8Array
          ? Buffer.from(chunk).toString('utf-8')
          : String(chunk)
      // Compared as a boolean, so a failure never prints the key.
      expect(text.includes(KEY)).toBe(false)
    }
    for (const spy of spies) {
      for (const args of spy.mock.calls) {
        expect(
          args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
        ).not.toContain(KEY)
      }
    }
  })

  it('tells every window the new list, without the key', async () => {
    expect(fake.listeners).toHaveLength(1)
    const connections = [fake.view('c1', true)]
    fake.listeners[0]({ _tag: 'accounts.providers_changed', connections })
    fake.listeners[0]({ _tag: 'accounts.changed', accounts: [] })
    expect(sent).toEqual([{ channel: 'provider-connections:changed', args: [connections] }])
    expect(JSON.stringify(sent)).not.toContain(KEY)
  })

  it('refuses an add without a provider', async () => {
    await expect(call('provider-connections:add')).rejects.toThrow('Pick a provider first.')
    await expect(call('provider-connections:add', 'moonshot')).rejects.toThrow(
      'Pick a provider first.'
    )
    await expect(call('provider-connections:add', { company: 7 })).rejects.toThrow(
      'Pick a provider first.'
    )
    expect(fake.calls).toEqual([])
  })

  it('refuses a key save without a key', async () => {
    await expect(call('provider-connections:set-key', 'c1', '')).rejects.toThrow(
      'Paste the key first.'
    )
    await expect(call('provider-connections:set-key', 'c1', '   ')).rejects.toThrow(
      'Paste the key first.'
    )
    await expect(call('provider-connections:set-key', 'c1', 42)).rejects.toThrow(
      'Paste the key first.'
    )
    expect(fake.calls).toEqual([])
  })

  it('forwards an add, a rename, a remove and the list to the source', async () => {
    await call('provider-connections:add', { company: 'moonshot', label: 'Work', extra: 1 })
    expect(await call('provider-connections:rename', 'c1', 'Renamed')).toMatchObject({
      label: 'Renamed'
    })
    expect(await call('provider-connections:remove', 'c1')).toBe(true)
    expect(await call('provider-connections:list')).toEqual([fake.view('c1', false)])
    expect(fake.calls).toEqual([
      { method: 'add', args: [{ company: 'moonshot', label: 'Work' }] },
      { method: 'rename', args: ['c1', 'Renamed'] },
      { method: 'remove', args: ['c1'] },
      { method: 'list', args: [] }
    ])
  })
})
