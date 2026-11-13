import type { Session } from '../../../src/shared/session-model'
import { isRemoteKey } from '../../../src/renderer/src/lib/fleet-identity'
import { bindReconnectReset } from './reconnect'
import { endIsCurrent } from '../../../src/renderer/src/views/session-end'
import { conversationReader, type ConversationReader } from './conversation-reader'

/** All native conversation views take the same subscribe/snapshot handoff.
 * Connection notices invalidate old HTTP responses before the new stream. */
export function bindConversation(
  sessionId: string,
  handlers: Parameters<typeof conversationReader>[1] & {
    session(session: Session): void
    exit(code: number): void
    reconnected(): void
  }
): ConversationReader {
  let live = true
  let connection = 0
  let subscribed = false
  let subscribing = false
  const confirmed = (then: () => void): void => {
    const version = connection
    void endIsCurrent(sessionId)
      .then((current) => {
        if (current && live && version === connection) then()
      })
      .catch((error) => {
        if (live) handlers.failed(error)
      })
  }
  const reader = conversationReader(
    {
      timeline: (before, limit) => window.electronAPI.sessionsTimeline(sessionId, before, limit),
      history: (before, limit) => window.electronAPI.sessionsHistory(sessionId, before, limit)
    },
    {
      ...handlers,
      event: (item) => {
        if (item.event.type === 'state_change' && item.event.state === 'ended')
          confirmed(() => handlers.event(item))
        else handlers.event(item)
      }
    }
  )
  const connected = (): void => {
    if (!live) return
    connection++
    handlers.reconnected()
    const version = connection
    // Welcome notifies listeners before PushClient resets its subscription
    // acknowledgements. Enter on the next microtask, then await the fresh
    // reply and its complete pending forms before taking the HTTP snapshot.
    const ready = Promise.resolve().then(async () => {
      if (!live || connection !== version) return
      await window.electronAPI.sessionsSubscribe(sessionId)
      await window.electronAPI.sessionsUnsubscribe(sessionId)
    })
    reader.reconnect(ready)
  }
  const localOff = window.electronAPI.onServerConnected(() => {
    if (!isRemoteKey(sessionId)) connected()
  })
  const fleetOff = bindReconnectReset(sessionId, connected)
  const streamOff = window.electronAPI.onSessionStream(sessionId, reader.stream)
  const exitOff = window.electronAPI.onSessionStreamExit(sessionId, (code) =>
    confirmed(() => handlers.exit(code))
  )
  const subscribe = (): void => {
    if (!live || subscribing) return
    subscribing = true
    void Promise.resolve()
      .then(() => (live ? window.electronAPI.sessionsSubscribe(sessionId) : null))
      .then((session) => {
        if (!live || !session) return
        subscribed = true
        if (session.state === 'ended') confirmed(() => handlers.session(session))
        else handlers.session(session)
        reader.start()
      })
      .catch((error) => {
        if (live) handlers.failed(error)
      })
      .finally(() => {
        subscribing = false
      })
  }
  subscribe()
  return {
    ...reader,
    retry: () => (subscribed ? reader.retry() : subscribe()),
    stop: () => {
      if (!live) return
      live = false
      connection++
      reader.stop()
      localOff()
      fleetOff?.()
      streamOff()
      exitOff()
      void window.electronAPI.sessionsUnsubscribe(sessionId).catch(console.error)
    }
  }
}
