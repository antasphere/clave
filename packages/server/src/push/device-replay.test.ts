import { describe, expect, it, vi } from 'vitest'
import { Effect } from 'effect'
import type { ServerFrame } from '@clave/contract/push'
import { FakeSource, aSession } from '../test-support'
import { PushHub } from './hub'

describe('device push replay', () => {
  it('keeps pending desktop requests and private events out of a phone welcome', () => {
    const touch = vi.fn()
    const hub = new PushHub({
      token: 'owner',
      serverId: 'test',
      source: new FakeSource(aSession('s1')),
      events: {
        stream: 'test',
        publish: () => Effect.die('unused'),
        subscribe: () => () => {}
      },
      devices: {
        authenticate: (token) => (token === 'phone' ? { deviceId: 'd1' } : null),
        touch,
        onRevoked: () => () => {}
      }
    })
    const request: ServerFrame = {
      _tag: 'request',
      requestId: 'r1',
      windowKey: 'w1',
      command: 'open_side_panel',
      payload: { url: 'https://example.test/document' }
    }
    const privateEvent: ServerFrame = {
      _tag: 'event',
      id: 'e1',
      seq: 1,
      at: 1,
      event: { _tag: 'plugins.changed' }
    }
    const sessionEvent: ServerFrame = {
      _tag: 'event',
      id: 'e2',
      seq: 2,
      at: 2,
      event: { _tag: 'session.state_changed', id: 's1', state: 'working' }
    }
    hub.onWelcome((send) => {
      send(request)
      send(privateEvent)
      send(sessionEvent)
    })
    const connect = (token: string): ServerFrame[] => {
      const frames: ServerFrame[] = []
      const peer = hub.attach({ send: (text) => frames.push(JSON.parse(text)), close: () => {} })
      peer.onMessage(JSON.stringify({ _tag: 'hello', token }))
      return frames
    }
    try {
      const phone = connect('phone')
      const owner = connect('owner')
      expect(touch.mock.calls).toEqual([['d1']])
      expect(phone.map((frame) => frame._tag)).toEqual(['welcome', 'event'])
      expect(phone[1]).toEqual(sessionEvent)
      expect(owner.slice(1)).toEqual([request, privateEvent, sessionEvent])
      hub.publishFrame(request)
      expect(phone).toHaveLength(2)
      expect(owner.at(-1)).toEqual(request)
    } finally {
      hub.dispose()
    }
  })
})
