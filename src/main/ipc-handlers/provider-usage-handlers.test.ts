/**
 * A stored connection's usage line over IPC (PRDCT-4496): the handler
 * normalises what a window sends before the settings source reads it. A
 * `connectionId` that is not a string answers the unknown line without a
 * throw and without a read; `force` goes on only as `true`. The settings
 * source is a fake here: what is under test is the handler's own road.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn)
  }
}))

const fake = vi.hoisted(() => {
  const reads: unknown[] = []
  return {
    reads,
    source: {
      providerUsage: {
        read: async (input: unknown) => {
          reads.push(input)
          return { kind: 'line', text: 'made-up usage' }
        }
      }
    }
  }
})

vi.mock('../settings/shell-source', () => ({ shellSettingsSource: fake.source }))

import { registerProviderUsageHandlers } from './provider-usage-handlers'

const call = (...args: unknown[]): Promise<unknown> => {
  const handler = handlers.get('provider-usage:read')
  if (!handler) throw new Error('no handler for provider-usage:read')
  return Promise.resolve().then(() => handler({}, ...args))
}

beforeEach(() => {
  handlers.clear()
  fake.reads.length = 0
  registerProviderUsageHandlers()
})

describe('provider-usage:read normalises what a window sends (PRDCT-4496)', () => {
  it('reads a string connection id, with force when it is true', async () => {
    await call({ connectionId: 'conn-7', force: true })
    expect(fake.reads).toEqual([{ connectionId: 'conn-7', force: true }])
  })

  it('answers the unknown line for a connection id that is not a string, never throwing', async () => {
    for (const input of [
      { connectionId: 7 },
      { connectionId: null },
      { connectionId: ['conn-7'] },
      {},
      null,
      undefined,
      'conn-7'
    ]) {
      await expect(call(input), JSON.stringify(input)).resolves.toMatchObject({
        kind: 'unknown'
      })
    }
    expect(fake.reads).toEqual([])
  })

  it('passes force only when it is true', async () => {
    for (const force of [false, 'true', 1, null, {}]) {
      fake.reads.length = 0
      await call({ connectionId: 'conn-7', force })
      expect(fake.reads, JSON.stringify(force)).toEqual([{ connectionId: 'conn-7' }])
    }
  })
})
