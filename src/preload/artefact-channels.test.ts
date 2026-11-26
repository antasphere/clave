import { describe, expect, it, vi } from 'vitest'

/**
 * The window's road to main for a machine's Slideless accounts and an
 * artefact's links (PRDCT-4266), before a server is named: the preload is
 * loaded as the window loads it, and each new member asks main on a channel
 * main's IPC arm registers (`artefact-handlers.ts`), with the window's own
 * arguments, a code, a key and a password included as arguments only. A
 * name that drifts on either side fails here rather than in a window.
 */
const mocks = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  invoked: [] as Array<{ channel: string; args: unknown[] }>,
  handled: new Set<string>()
}))
vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, value: unknown) => mocks.exposed.set(key, value)
  },
  ipcRenderer: {
    invoke: vi.fn(async (channel: string, ...args: unknown[]) => {
      mocks.invoked.push({ channel, args })
      return null
    }),
    send: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn()
  },
  ipcMain: { handle: (channel: string) => mocks.handled.add(channel) },
  webUtils: {}
}))
vi.mock('../main/mcp/server-client', () => ({ serverClient: { api: async () => null } }))

await import('./index')
const { registerArtefactHandlers } = await import('../main/ipc-handlers/artefact-handlers')
registerArtefactHandlers({ named: () => true, api: async () => null as never })

type Member = (...args: unknown[]) => Promise<unknown>
const artefacts = (mocks.exposed.get('electronAPI') as { artefacts: Record<string, Member> })
  .artefacts

describe('the window asks main for the Slideless accounts and the links', () => {
  it('on a channel main answers, with the window’s arguments', async () => {
    const site = 'https://decks.example.test'
    const request = {
      site,
      link: {
        annotator: false,
        forms: true,
        download: true,
        bar: true,
        pdf: true,
        pinVersion: false,
        password: 'four'
      }
    }
    const cases: Array<[string, unknown[], unknown[]]> = [
      ['slidelessAccounts', [], []],
      ['checkSlidelessAccounts', [], []],
      ['addSlidelessSite', [site], [site]],
      ['setNewLinksSite', [null], [null]],
      ['runSlidelessFix', [site, 'check'], [site, 'check']],
      [
        'startSlidelessSignIn',
        [site, { email: 'someone@example.test' }],
        [site, { email: 'someone@example.test' }]
      ],
      ['answerSlidelessSignIn', ['i1', '424242'], ['i1', '424242']],
      ['cancelSlidelessSignIn', ['i1'], ['i1']],
      ['pasteSlidelessKey', [site, 'slk_pasted'], [site, 'slk_pasted']],
      ['artefactDeck', ['s1', '/work/deck'], ['s1', '/work/deck']],
      ['shareArtefact', ['s1', '/work/deck', request], ['s1', '/work/deck', request]],
      ['revokeArtefactLink', ['s1', '/work/deck', 't1'], ['s1', '/work/deck', 't1']]
    ]
    for (const [member, args, sent] of cases) {
      mocks.invoked.length = 0
      await artefacts[member]!(...args)
      const asked = mocks.invoked.filter((call) => call.channel.startsWith('artefacts:'))
      expect(asked).toEqual([{ channel: `artefacts:${member}`, args: sent }])
      expect(mocks.handled.has(`artefacts:${member}`)).toBe(true)
    }
  })
})
