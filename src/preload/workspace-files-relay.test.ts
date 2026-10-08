import { describe, expect, it } from 'vitest'
import type { ServerEventEnvelope } from '@clave/contract/events'
import { createReviewRelay, createWatchLedger } from './workspace-files-relay'

const envelope = (event: ServerEventEnvelope['event']): ServerEventEnvelope => ({
  id: 'e',
  seq: 1,
  at: 0,
  event
})
const review = (requestId: string | null, reviewId = 'r1'): ServerEventEnvelope =>
  envelope({
    _tag: 'workspace_files.review_needed',
    reviewId,
    requestId,
    path: '/w/x.clave',
    folder: '/w',
    autoCommands: [],
    prompts: ['P'],
    dangerous: false
  })
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('the review relay', () => {
  it('answers the server for its own read only, with the dialog’s word', async () => {
    const shown: string[] = []
    const answered: Array<{ reviewId: string; response: number; checkboxChecked: boolean }> = []
    let n = 0
    const relay = createReviewRelay({
      mintId: () => `req-${++n}`,
      showDialog: async (event) => {
        shown.push(event.reviewId)
        return { response: 1, checkboxChecked: true }
      },
      answer: async (reviewId, answer) => {
        answered.push({ reviewId, ...answer })
      }
    })
    const read = relay.begin()
    expect(read.requestId).toBe('req-1')
    relay.onEvent(review('somebody-else', 'other'))
    relay.onEvent(review(null, 'anon'))
    relay.onEvent(review('req-1', 'mine'))
    await tick()
    expect(shown).toEqual(['mine'])
    expect(answered).toEqual([{ reviewId: 'mine', response: 1, checkboxChecked: true }])
    read.done()
    expect(relay.pending()).toBe(0)
    relay.onEvent(review('req-1', 'late'))
    await tick()
    expect(shown).toEqual(['mine'])
  })

  it('ignores an event that is not a review, and logs an answer the server refused', async () => {
    const logged: string[] = []
    const relay = createReviewRelay({
      mintId: () => 'req',
      showDialog: async () => ({ response: 0, checkboxChecked: false }),
      answer: async () => {
        throw new Error('ReviewNotFound')
      },
      log: (message) => logged.push(message)
    })
    relay.begin()
    relay.onEvent(envelope({ _tag: 'workspace_files.changed', path: '/w/x.clave' }))
    relay.onEvent(review('req'))
    await tick()
    expect(logged).toEqual(['[clave] workspace file review not answered'])
  })
})

describe('the watch ledger', () => {
  const fakeTransports = (): {
    calls: string[]
    transports: Parameters<typeof createWatchLedger>[0]
  } => {
    const calls: string[] = []
    const side = (
      name: string
    ): { watch: (path: string) => Promise<void>; unwatch: (path: string) => Promise<void> } => ({
      watch: async (path: string) => {
        calls.push(`${name}.watch ${path}`)
      },
      unwatch: async (path: string) => {
        calls.push(`${name}.unwatch ${path}`)
      }
    })
    return { calls, transports: { ipc: side('ipc'), server: side('server') } }
  }

  it('moves an IPC watch to the server once it is there, and releases where it is held', async () => {
    const { calls, transports } = fakeTransports()
    const ledger = createWatchLedger(transports)
    await ledger.watch('/a', 'ipc')
    expect(ledger.heldOn('/a')).toBe('ipc')
    await ledger.moveToServer()
    expect(ledger.heldOn('/a')).toBe('server')
    expect(calls).toEqual(['ipc.watch /a', 'server.watch /a', 'ipc.unwatch /a'])
    // After the server is known, a watch asked over IPC goes to the server.
    await ledger.watch('/b', 'ipc')
    expect(ledger.heldOn('/b')).toBe('server')
    await ledger.unwatch('/a')
    await ledger.unwatch('/b')
    await ledger.unwatch('/never')
    expect(calls.slice(3)).toEqual(['server.watch /b', 'server.unwatch /a', 'server.unwatch /b'])
    expect(ledger.heldOn('/a')).toBeNull()
  })

  it('moves a watch whose IPC call was still in flight when the server came', async () => {
    const calls: string[] = []
    let release: () => void = () => {}
    const slowIpcWatch = new Promise<void>((r) => {
      release = r
    })
    const ledger = createWatchLedger({
      ipc: {
        watch: async (p) => {
          calls.push(`ipc.watch ${p}`)
          await slowIpcWatch
        },
        unwatch: async (p) => {
          calls.push(`ipc.unwatch ${p}`)
        }
      },
      server: {
        watch: async (p) => {
          calls.push(`server.watch ${p}`)
        },
        unwatch: async (p) => {
          calls.push(`server.unwatch ${p}`)
        }
      }
    })
    const watching = ledger.watch('/a', 'ipc')
    await ledger.moveToServer()
    release()
    await watching
    expect(ledger.heldOn('/a')).toBe('server')
    expect(calls).toEqual(['ipc.watch /a', 'server.watch /a', 'ipc.unwatch /a'])
  })
})
