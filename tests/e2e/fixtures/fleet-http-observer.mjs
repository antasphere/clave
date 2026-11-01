import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { connect } from 'node:net'

// Forward every byte to a real daemon. Only method, route and response status
// are observed: headers, queries, credentials, file contents and answers stay
// out of the record. Each listener owns its OS-assigned port and connections.
export async function observeDaemon(url) {
  const entries = []
  const sockets = new Set()
  const track = (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    return socket
  }
  // Holds (lane C, #242): a spec may park the next matching request before it
  // reaches the daemon (`holdRequest`), or the daemon's reply to the next
  // matching request before it reaches the Mac (`holdReply`), to put the Mac
  // and the daemon in an order the network would only produce by accident.
  // Each hold takes exactly one exchange; `release()` lets it through. The
  // record keeps the request's actual status either way.
  const holds = []
  const takeHold = (kind, incoming, pathname) =>
    holds.find((hold) => hold.kind === kind && !hold.taken && hold.match(incoming.method, pathname))
  const server = createServer((incoming, outgoing) => {
    const target = new URL(incoming.url, url)
    const forward = () => {
      const upstream = request(
        target,
        { method: incoming.method, headers: incoming.headers },
        (reply) => {
          entries.push({ method: incoming.method, path: target.pathname, status: reply.statusCode })
          const held = takeHold('reply', incoming, target.pathname)
          if (!held) {
            outgoing.writeHead(reply.statusCode, reply.headers)
            reply.pipe(outgoing)
            reply.on('error', () => outgoing.destroy())
            return
          }
          held.taken = true
          const chunks = []
          reply.on('data', (chunk) => chunks.push(chunk))
          reply.on('error', () => outgoing.destroy())
          reply.on('end', () => {
            const body = Buffer.concat(chunks)
            held.released.then(() => {
              if (outgoing.destroyed) return
              outgoing.writeHead(reply.statusCode, reply.headers)
              outgoing.end(body)
            })
          })
        }
      )
      upstream.on('error', () => {
        if (!outgoing.headersSent) outgoing.writeHead(502)
        outgoing.end()
      })
      incoming.on('aborted', () => upstream.destroy())
      outgoing.on('close', () => upstream.destroy())
      incoming.pipe(upstream)
    }
    const held = takeHold('request', incoming, target.pathname)
    if (!held) return forward()
    held.taken = true
    // The body is kept flowing into memory while the request waits.
    incoming.pause()
    held.released.then(() => {
      if (outgoing.destroyed) return
      incoming.resume()
      forward()
    })
  })
  server.on('connection', track)
  // The real push protocol upgrades to WebSocket. Tunnel the original
  // handshake and bytes unchanged; the observer is not a push adapter.
  server.on('upgrade', (incoming, client, head) => {
    const target = new URL(url)
    const upstream = track(
      connect(Number(target.port), target.hostname, () => {
        const headers = incoming.rawHeaders.reduce(
          (lines, value, index, values) =>
            index % 2 === 0 ? lines + `${value}: ${values[index + 1]}\r\n` : lines,
          ''
        )
        upstream.write(
          `${incoming.method} ${incoming.url} HTTP/${incoming.httpVersion}\r\n${headers}\r\n`
        )
        if (head.length) upstream.write(head)
        client.pipe(upstream)
        upstream.pipe(client)
      })
    )
    upstream.on('error', () => client.destroy())
    client.on('error', () => upstream.destroy())
    client.on('close', () => upstream.destroy())
    upstream.on('close', () => client.destroy())
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const hold = (kind, match) => {
    let release = () => {}
    const released = new Promise((resolve) => {
      release = resolve
    })
    const entry = { kind, match, taken: false, released }
    holds.push(entry)
    return {
      release,
      /** Whether the exchange this hold waits for has arrived. */
      get taken() {
        return entry.taken
      }
    }
  }
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    entries,
    /** Park the next request matching `match(method, pathname)` before the daemon sees it. */
    holdRequest: (match) => hold('request', match),
    /** Park the daemon's reply to the next request matching `match` before the Mac sees it. */
    holdReply: (match) => hold('reply', match),
    async close() {
      const closed = new Promise((resolve) => server.close(resolve))
      server.closeAllConnections()
      for (const socket of sockets) socket.destroy()
      await closed
    }
  }
}

export function assertFileEndpoint(observers, marks, owner, route) {
  const seen = observers.map((observer, index) =>
    observer.entries.slice(marks[index]).filter((entry) => entry.path === route)
  )
  assert.ok(
    seen[owner].some((entry) => entry.status === 200 || entry.status === 204),
    `${route} must complete on owner ${owner + 1}: ${JSON.stringify(seen)}`
  )
  assert.deepEqual(seen[1 - owner], [], `${route} must not reach the other daemon`)
  console.log(JSON.stringify({ fileEndpoint: route, owner: owner + 1, observed: seen }))
}
