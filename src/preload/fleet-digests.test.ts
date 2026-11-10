/**
 * The digests on the fleet road (PRDCT-4327): a server tab's exchange digest
 * and work-card titles are asked of the server the tab runs on, under its
 * wire id, with no launch (the server reads its own record); this Mac's tabs
 * stay on this Mac's bridge with the request as it came.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Backing } from '@clave/client/router'
import { sessionKey } from '@clave/contract/fleet'
import { createFleetDesktop } from './fleet-desktop'
import type { ElectronAPI } from './index.d'

function fixture(): {
  api: ElectronAPI
  server: Record<string, ReturnType<typeof vi.fn>>
  mac: Record<string, ReturnType<typeof vi.fn>>
} {
  const server = {
    exchange: vi.fn(async () => ({ ok: true, needsYou: false, summary: 'From x.', message: null })),
    exchangesOf: vi.fn(async () => ({
      k: { ok: true, needsYou: false, summary: 'Filed on x.', message: null }
    })),
    work: vi.fn(async () => ({ ok: false, error: 'limit', reason: 'limit' })),
    workOf: vi.fn(async () => ({}))
  }
  const mac = {
    exchangeDigest: vi.fn(async () => ({
      ok: true,
      needsYou: false,
      summary: 'Here.',
      message: null
    })),
    exchangeDigestsOf: vi.fn(async () => ({})),
    workDigest: vi.fn(async () => ({ ok: true, title: 'Here', needsYou: false, note: null })),
    workDigestsOf: vi.fn(async () => ({}))
  }
  const api = createFleetDesktop(mac as unknown as ElectronAPI, {
    invoke: vi.fn(async (channel: string, ...args: unknown[]) => {
      if (channel === 'server:fleet:list')
        return [{ id: 'x', name: 'Server x', enabled: true, url: 'http://x' }]
      if (channel === 'window:identity') return { windowKey: 'win-7' }
      return { url: `http://${args[0]}`, token: 'test-only' }
    }),
    changed: () => () => {},
    connect: async () =>
      ({
        api: {
          dispose: async () => {},
          sessions: { list: async () => [], listAdoptable: async () => [] },
          sidebar: {
            getLayout: async () => ({
              windowKey: 'server',
              revision: 0,
              groups: [],
              displayOrder: []
            })
          },
          requests: { watch: () => () => {} },
          digests: server
        },
        push: {
          status: 'open',
          connect: () => {},
          close: () => {},
          onRequest: () => () => {},
          whenOpen: () => Promise.resolve(),
          onStatus: () => () => {},
          onEvent: () => () => {}
        }
      }) as unknown as Backing
  })
  return { api, server, mac }
}

const launch = { claudeProfileId: 'the-server-account-as-the-tab-says', configDir: '/x/home' }

describe('the digests on the fleet road', () => {
  it("a server tab's digests go to its server under the wire id, without the launch", async () => {
    const h = fixture()
    await h.api.fleetList()
    const id = sessionKey({ serverId: 'x', sessionId: 's1' })
    const messages = [{ from: 'Lane A', text: 'done' }]
    await expect(
      h.api.exchangeDigest({ sessionId: id, key: 'k', launch, messages })
    ).resolves.toMatchObject({
      summary: 'From x.'
    })
    expect(h.server.exchange).toHaveBeenCalledWith({ sessionId: 's1', key: 'k', messages })
    await expect(h.api.exchangeDigestsOf(id)).resolves.toMatchObject({
      k: { summary: 'Filed on x.' }
    })
    expect(h.server.exchangesOf).toHaveBeenCalledWith('s1')
    await expect(
      h.api.workDigest({ sessionId: id, key: 'w', launch, notes: ['a'], tools: 3 })
    ).resolves.toEqual({ ok: false, error: 'limit', reason: 'limit' })
    expect(h.server.work).toHaveBeenCalledWith({
      sessionId: 's1',
      key: 'w',
      notes: ['a'],
      tools: 3
    })
    await h.api.workDigestsOf(id)
    expect(h.server.workOf).toHaveBeenCalledWith('s1')
    for (const fn of Object.values(h.mac)) expect(fn).not.toHaveBeenCalled()
    await h.api.fleetDisconnect('x')
  })

  it("this Mac's tabs stay on this Mac's bridge, the request as it came", async () => {
    const h = fixture()
    const request = { sessionId: 'local-1', key: 'k', launch, messages: [{ from: 'a', text: 'b' }] }
    await expect(h.api.exchangeDigest(request)).resolves.toMatchObject({ summary: 'Here.' })
    expect(h.mac.exchangeDigest).toHaveBeenCalledWith(request)
    await h.api.exchangeDigestsOf('local-1')
    expect(h.mac.exchangeDigestsOf).toHaveBeenCalledWith('local-1')
    const work = { sessionId: 'local-1', key: 'w', launch, notes: ['n'], tools: 0 }
    await h.api.workDigest(work)
    expect(h.mac.workDigest).toHaveBeenCalledWith(work)
    await h.api.workDigestsOf('local-1')
    expect(h.mac.workDigestsOf).toHaveBeenCalledWith('local-1')
    for (const fn of Object.values(h.server)) expect(fn).not.toHaveBeenCalled()
  })
})
