/**
 * The heartbeat on a real `ws` socket and real timers (PRDCT-4668): a server
 * that welcomes the client, answers its subscription and then goes silent
 * without closing is found dead by the beat, and the client terminates that
 * socket, connects again and subscribes again. A server that answers keeps
 * its socket. The fake-socket tests prove the logic; this one proves the
 * real socket's `terminate` and the real timers work together.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { decodeClientFrame, encodeServerFrame } from '@clave/contract/push'
import { aSession, sleep } from '@clave/server/test-support'
import { Either } from 'effect'
import { PushClient, type PushSocketConstructor } from './push-client'

const until = async (check: () => boolean, ms = 8000): Promise<void> => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('Condition not met in time')
    await sleep(10)
  }
}

describe('the heartbeat on a real socket', () => {
  let wss: WebSocketServer | null = null
  let client: PushClient | null = null
  afterEach(async () => {
    client?.close()
    if (wss) {
      for (const ws of wss.clients) ws.terminate()
      await new Promise((resolve) => wss!.close(resolve))
    }
    wss = null
    client = null
  })

  it('drops a server gone silent, comes back, and keeps a server that answers', async () => {
    wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise((resolve) => wss!.once('listening', resolve))
    const port = (wss.address() as { port: number }).port
    // What each connection received, in order of connection.
    const received: string[][] = []
    wss.on('connection', (ws) => {
      const index = received.length
      const frames: string[] = []
      received.push(frames)
      // The first connection answers the hello and the subscribe, then hears
      // nothing more and answers nothing, without ever closing.
      let silent = false
      ws.on('message', (data) => {
        if (silent) return
        const decoded = decodeClientFrame(data.toString())
        if (Either.isLeft(decoded)) return
        const frame = decoded.right
        frames.push(frame._tag)
        switch (frame._tag) {
          case 'hello':
            ws.send(encodeServerFrame({ _tag: 'welcome', serverId: 'fake', protocol: 1 }))
            return
          case 'subscribe':
            ws.send(
              encodeServerFrame({
                _tag: 'subscribed',
                sessionId: frame.sessionId,
                session: aSession(frame.sessionId)
              })
            )
            if (index === 0) silent = true
            return
          case 'ping':
            ws.send(encodeServerFrame({ _tag: 'pong' }))
            return
          default:
            return
        }
      })
    })

    client = new PushClient({
      url: `http://127.0.0.1:${port}`,
      token: 't',
      WebSocket: WebSocket as unknown as PushSocketConstructor,
      backoff: { baseMs: 10, maxMs: 50 },
      // The limit is a second, far above a loaded machine's stalls: at a
      // tenth of one, a pong held up by a busy worker read as a dead server
      // and the last check below saw a third connection.
      heartbeat: { intervalMs: 50, timeoutMs: 1000, wakeTimeoutMs: 1000 }
    })
    client.subscribe('s1', () => {})
    client.connect()
    await client.whenOpen()

    await until(() => received.length >= 2)
    await until(() => received[1].includes('hello') && received[1].includes('subscribe'))
    expect(received[1].slice(0, 2)).toEqual(['hello', 'subscribe'])
    await until(() => client!.status === 'open')

    // Ten intervals on a server that answers: no third connection.
    await sleep(500)
    expect(received).toHaveLength(2)
    expect(received[1]).toContain('ping')
    expect(client.status).toBe('open')
  })
})
