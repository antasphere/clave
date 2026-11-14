/**
 * The models catalogue over IPC (PRDCT-4496): the handler normalises what a
 * window sends before the settings source reads it. `providerIds` goes on
 * only as an array of strings, `force` only as `true`, and an input that is
 * not an object reads as `{}`. The settings source is a fake here: what is
 * under test is the handler's own road.
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
      modelsCatalog: {
        read: async (input: unknown) => {
          reads.push(input)
          return { providers: [] }
        }
      }
    }
  }
})

vi.mock('../settings/shell-source', () => ({ shellSettingsSource: fake.source }))

import { registerModelsCatalogHandlers } from './models-catalog-handlers'

const call = (...args: unknown[]): Promise<unknown> => {
  const handler = handlers.get('models-catalog:read')
  if (!handler) throw new Error('no handler for models-catalog:read')
  return Promise.resolve().then(() => handler({}, ...args))
}

beforeEach(() => {
  handlers.clear()
  fake.reads.length = 0
  registerModelsCatalogHandlers()
})

describe('models-catalog:read normalises what a window sends (PRDCT-4496)', () => {
  it('passes an array of strings and a force of true as they are', async () => {
    await call({ providerIds: ['deepseek', 'moonshot'], force: true })
    expect(fake.reads).toEqual([{ providerIds: ['deepseek', 'moonshot'], force: true }])
  })

  it('drops providerIds that is not an array of strings, whole', async () => {
    for (const providerIds of ['deepseek', null, 7, ['deepseek', 7], [null], { 0: 'x' }]) {
      fake.reads.length = 0
      await call({ providerIds })
      expect(fake.reads, JSON.stringify(providerIds)).toEqual([{}])
    }
  })

  it('passes force only when it is true', async () => {
    for (const force of [false, 'true', 1, null, {}]) {
      fake.reads.length = 0
      await call({ force })
      expect(fake.reads, JSON.stringify(force)).toEqual([{}])
    }
  })

  it('reads {} for an input that is null, absent or not an object', async () => {
    for (const input of [null, undefined, 'deepseek', 42, true]) {
      fake.reads.length = 0
      await call(input)
      expect(fake.reads, String(input)).toEqual([{}])
    }
  })

  it('never passes an unknown field on', async () => {
    await call({ providerIds: ['deepseek'], extra: 'x', force: true })
    expect(fake.reads).toEqual([{ providerIds: ['deepseek'], force: true }])
  })
})
