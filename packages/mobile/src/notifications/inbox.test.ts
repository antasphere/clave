import { expect, it } from 'vitest'
import { MemoryKeyValueStore } from '../chat/drafts'
import { NotificationInbox, PENDING_NOTIFICATION_KEY } from './inbox'
import type { DeepLink } from './deeplink'
import type { IncomingResponse } from './port'

const response: IncomingResponse = {
  actionIdentifier: 'default',
  notification: {
    date: 1,
    request: { identifier: 'one', content: { title: 'Fixture', body: 'Open chat' } }
  }
}
const link: DeepLink = { kind: 'chat', machineId: 'machine', sessionId: 'session', title: '' }
function setup(last: IncomingResponse | null = null): {
  inbox: NotificationInbox
  kv: MemoryKeyValueStore
  navigated: DeepLink[]
  handled: () => number
  cleared: () => number
} {
  const kv = new MemoryKeyValueStore()
  const navigated: DeepLink[] = []
  let handled = 0
  let cleared = 0
  const inbox = new NotificationInbox({
    kv,
    lastResponse: async () => last,
    clearLastResponse: async () => {
      cleared++
    },
    respond: async () => {
      handled++
      return link
    },
    navigate: (target) => {
      navigated.push(target)
    }
  })
  return { inbox, kv, navigated, handled: () => handled, cleared: () => cleared }
}

it('opens the notification conversation on cold launch instead of the last machine', async () => {
  const { inbox, navigated, kv, cleared } = setup(response)
  const state = await inbox.initialState('old-machine', null)
  expect(state.routes.at(-1)).toMatchObject({ name: 'Chat', params: { sessionId: 'session' } })
  inbox.ready()
  expect(navigated).toEqual([])
  expect(await kv.getItem(PENDING_NOTIFICATION_KEY)).toBeNull()
  expect(cleared()).toBe(1)
})

it('keeps an explicit URL ahead of a stored notification', async () => {
  const { inbox, kv } = setup()
  await kv.setItem(PENDING_NOTIFICATION_KEY, JSON.stringify(link))
  const state = await inbox.initialState('old', 'clave://chat/url-machine/url-session')
  expect(state.routes.at(-1)).toMatchObject({ params: { sessionId: 'url-session' } })
  expect(await kv.getItem(PENDING_NOTIFICATION_KEY)).toBeNull()
})

it('consumes the owner pending link from a headless task on cold launch', async () => {
  const { inbox, kv } = setup()
  await kv.setItem(
    PENDING_NOTIFICATION_KEY,
    JSON.stringify({ kind: 'requests', machineId: 'm', requestId: 'r' })
  )
  expect((await inbox.initialState('old', null)).routes.at(-1)).toMatchObject({
    name: 'Requests',
    params: { machineId: 'm', requestId: 'r' }
  })
})

it('queues a warm response until navigation is ready and handles a duplicated delivery once', async () => {
  const { inbox, navigated, handled } = setup()
  await inbox.initialState(null, null)
  await Promise.all([inbox.receive(response), inbox.receive(response)])
  expect(navigated).toEqual([])
  inbox.ready()
  await inbox.idle()
  expect(navigated).toEqual([link])
  expect(handled()).toBe(1)
})

it('does not navigate after its owner unmounts during a response', async () => {
  const { inbox, navigated } = setup()
  inbox.ready()
  const pending = inbox.receive(response)
  inbox.close()
  await pending
  expect(navigated).toEqual([])
})

it('ignores malformed pending data and never reads another owner store', async () => {
  const { inbox, kv } = setup()
  await kv.setItem(PENDING_NOTIFICATION_KEY, JSON.stringify({ kind: 'chat', machineId: 1 }))
  expect((await inbox.initialState('last', null)).routes.at(-1)).toMatchObject({
    name: 'Workspaces'
  })
  const other = setup()
  await kv.setItem(PENDING_NOTIFICATION_KEY, JSON.stringify(link))
  expect((await other.inbox.initialState(null, null)).routes.at(-1)).toMatchObject({
    name: 'Machines'
  })
})
