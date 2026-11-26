/**
 * The artefacts' IPC arm (PRDCT-4474): each channel reaches the server main
 * named through its typed client, with the arguments the window gave; with
 * no server named, every channel refuses with one sentence and asks nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaveApiClient } from '@clave/client'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn)
  }
}))
vi.mock('../mcp/server-client', () => ({ serverClient: { api: async () => null } }))

import { registerArtefactHandlers, SERVER_NOT_READY } from './artefact-handlers'

const calls: Array<{ method: string; args: unknown[] }> = []
const recorded =
  (method: string, answer: unknown) =>
  async (...args: unknown[]): Promise<unknown> => {
    calls.push({ method, args })
    return answer
  }
const api = {
  artefacts: {
    list: recorded('list', [{ sessionId: 's1' }]),
    hold: recorded('hold', { holdId: 'h1', lease: 'l', url: 'u', ttlMs: 90_000 }),
    release: recorded('release', undefined),
    saveVersion: recorded('saveVersion', { version: 2, created: true }),
    versions: recorded('versions', { versions: [] }),
    close: recorded('close', undefined),
    slidelessState: recorded('slidelessState', { phase: 'ready', version: '1', error: null }),
    installSlideless: recorded('installSlideless', {
      phase: 'installing',
      version: null,
      error: null
    }),
    // PRDCT-4266
    slidelessAccounts: recorded('slidelessAccounts', { profiles: [] }),
    checkSlidelessAccounts: recorded('checkSlidelessAccounts', { checked: true }),
    addSlidelessSite: recorded('addSlidelessSite', { profiles: [] }),
    setNewLinksSite: recorded('setNewLinksSite', { newLinksSite: null }),
    runSlidelessFix: recorded('runSlidelessFix', { profiles: [] }),
    startSlidelessSignIn: recorded('startSlidelessSignIn', { phase: 'code_asked' }),
    answerSlidelessSignIn: recorded('answerSlidelessSignIn', { phase: 'done' }),
    cancelSlidelessSignIn: recorded('cancelSlidelessSignIn', undefined),
    pasteSlidelessKey: recorded('pasteSlidelessKey', { profiles: [] }),
    artefactDeck: recorded('artefactDeck', { deckId: 'd1' }),
    shareArtefact: recorded('shareArtefact', { _tag: 'shared' }),
    revokeArtefactLink: recorded('revokeArtefactLink', { links: [] })
  }
} as unknown as ClaveApiClient

let named = true
const invoke = (channel: string, ...args: unknown[]): unknown =>
  handlers.get(channel)!({ sender: {} }, ...args)

beforeEach(() => {
  handlers.clear()
  calls.length = 0
  named = true
  registerArtefactHandlers({ named: () => named, api: async () => api })
})

describe('the artefacts over IPC', () => {
  it('registers one channel per member', () => {
    expect([...handlers.keys()].sort()).toEqual([
      'artefacts:addSlidelessSite',
      'artefacts:answerSlidelessSignIn',
      'artefacts:artefactDeck',
      'artefacts:cancelSlidelessSignIn',
      'artefacts:checkSlidelessAccounts',
      'artefacts:close',
      'artefacts:hold',
      'artefacts:installSlideless',
      'artefacts:list',
      'artefacts:pasteSlidelessKey',
      'artefacts:release',
      'artefacts:revokeArtefactLink',
      'artefacts:runSlidelessFix',
      'artefacts:saveVersion',
      'artefacts:setNewLinksSite',
      'artefacts:shareArtefact',
      'artefacts:slidelessAccounts',
      'artefacts:slidelessState',
      'artefacts:startSlidelessSignIn',
      'artefacts:versions'
    ])
  })

  it('reaches the Slideless accounts and an artefact’s links with the window’s arguments (PRDCT-4266)', async () => {
    const site = 'https://decks.example.test'
    const settings = {
      annotator: false,
      forms: true,
      download: true,
      bar: true,
      pdf: true,
      pinVersion: true,
      password: 'four'
    }
    await expect(invoke('artefacts:slidelessAccounts')).resolves.toEqual({ profiles: [] })
    await invoke('artefacts:checkSlidelessAccounts')
    await invoke('artefacts:addSlidelessSite', site)
    await invoke('artefacts:setNewLinksSite', site)
    await invoke('artefacts:setNewLinksSite', null)
    await invoke('artefacts:setNewLinksSite', '')
    await invoke('artefacts:runSlidelessFix', site, 'remove_profile')
    await invoke('artefacts:startSlidelessSignIn', site, { email: 'someone@example.test' })
    await invoke('artefacts:startSlidelessSignIn', site, { hub: 'https://hub.example.test' })
    await invoke('artefacts:startSlidelessSignIn', site, undefined)
    await invoke('artefacts:answerSlidelessSignIn', 'i1', '424242')
    await invoke('artefacts:cancelSlidelessSignIn', 'i1')
    await invoke('artefacts:pasteSlidelessKey', site, 'slk_pasted')
    await expect(invoke('artefacts:artefactDeck', 's1', '/work/deck')).resolves.toEqual({
      deckId: 'd1'
    })
    await invoke('artefacts:shareArtefact', 's1', '/work/deck', { site, link: settings })
    await invoke('artefacts:revokeArtefactLink', 's1', '/work/deck', 't1')
    expect(calls).toEqual([
      { method: 'slidelessAccounts', args: [] },
      { method: 'checkSlidelessAccounts', args: [] },
      { method: 'addSlidelessSite', args: [site] },
      { method: 'setNewLinksSite', args: [site] },
      { method: 'setNewLinksSite', args: [null] },
      { method: 'setNewLinksSite', args: [null] },
      { method: 'runSlidelessFix', args: [site, 'remove_profile'] },
      { method: 'startSlidelessSignIn', args: [site, { email: 'someone@example.test' }] },
      { method: 'startSlidelessSignIn', args: [site, { hub: 'https://hub.example.test' }] },
      { method: 'startSlidelessSignIn', args: [site, {}] },
      { method: 'answerSlidelessSignIn', args: ['i1', '424242'] },
      { method: 'cancelSlidelessSignIn', args: ['i1'] },
      { method: 'pasteSlidelessKey', args: [site, 'slk_pasted'] },
      { method: 'artefactDeck', args: ['s1', '/work/deck'] },
      { method: 'shareArtefact', args: ['s1', '/work/deck', { site, link: settings }] },
      { method: 'revokeArtefactLink', args: ['s1', '/work/deck', 't1'] }
    ])
  })

  it('each channel reaches the client with the window’s arguments', async () => {
    await expect(invoke('artefacts:list')).resolves.toEqual([{ sessionId: 's1' }])
    await expect(invoke('artefacts:hold', 's1')).resolves.toMatchObject({ holdId: 'h1' })
    await invoke('artefacts:hold', 's1', 'h1')
    await invoke('artefacts:release', 's1', 'h1')
    await expect(invoke('artefacts:saveVersion', 's1')).resolves.toEqual({
      version: 2,
      created: true
    })
    await expect(invoke('artefacts:versions', 's1')).resolves.toEqual({ versions: [] })
    await invoke('artefacts:close', 's1')
    await expect(invoke('artefacts:slidelessState')).resolves.toMatchObject({ phase: 'ready' })
    await expect(invoke('artefacts:installSlideless')).resolves.toMatchObject({
      phase: 'installing'
    })
    expect(calls).toEqual([
      { method: 'list', args: [] },
      { method: 'hold', args: ['s1', undefined] },
      { method: 'hold', args: ['s1', 'h1'] },
      { method: 'release', args: ['s1', 'h1'] },
      { method: 'saveVersion', args: ['s1'] },
      { method: 'versions', args: ['s1'] },
      { method: 'close', args: ['s1'] },
      { method: 'slidelessState', args: [] },
      { method: 'installSlideless', args: [] }
    ])
  })

  it('names one of the session’s artefacts when the window does, and nothing when it does not (PRDCT-5022)', async () => {
    await invoke('artefacts:hold', 's1', undefined, '/work/talk')
    await invoke('artefacts:hold', 's1', 'h1', '')
    await invoke('artefacts:saveVersion', 's1', '/work/talk')
    await invoke('artefacts:versions', 's1', '/work/talk')
    await invoke('artefacts:close', 's1', '/work/talk')
    await invoke('artefacts:close', 's1', 42)
    expect(calls).toEqual([
      { method: 'hold', args: ['s1', undefined, '/work/talk'] },
      { method: 'hold', args: ['s1', 'h1'] },
      { method: 'saveVersion', args: ['s1', '/work/talk'] },
      { method: 'versions', args: ['s1', '/work/talk'] },
      { method: 'close', args: ['s1', '/work/talk'] },
      { method: 'close', args: ['s1'] }
    ])
  })

  it('with no server named, every channel refuses with the sentence and asks nothing', async () => {
    named = false
    for (const channel of handlers.keys())
      await expect(invoke(channel, 's1', 'h1')).rejects.toThrow(SERVER_NOT_READY)
    expect(calls).toEqual([])
    expect(SERVER_NOT_READY).toBe("Clave's server is not ready yet.")
  })
})
