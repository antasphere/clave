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
  const server = createServer((incoming, outgoing) => {
    const target = new URL(incoming.url, url)
    const upstream = request(
      target,
      { method: incoming.method, headers: incoming.headers },
      (reply) => {
        entries.push({ method: incoming.method, path: target.pathname, status: reply.statusCode })
        outgoing.writeHead(reply.statusCode, reply.headers)
        reply.pipe(outgoing)
        reply.on('error', () => outgoing.destroy())
      }
    )
    upstream.on('error', () => {
      if (!outgoing.headersSent) outgoing.writeHead(502)
      outgoing.end()
    })
    incoming.on('aborted', () => upstream.destroy())
    outgoing.on('close', () => upstream.destroy())
    incoming.pipe(upstream)
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
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    entries,
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
