// Test-owned legacy peer. It runs no providers, tools, or user commands.
import { createServer } from 'node:net'
import { writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const userData = process.argv[3]
const socketPath = process.env.TEST_CONVERSATION_SOCKET
const token = 'test-only-token'
const sockets = new Set()
const election = createServer((socket) => socket.destroy())
const port = 49152 + (createHash('sha256').update(socketPath).digest().readUInt16BE(0) % 16384)
const owner = join(userData, 'conversation-service', 'owner.json')

// Plain Node fixture, not TypeScript.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function send(socket, message) {
  const body = Buffer.from(JSON.stringify(message))
  const length = Buffer.alloc(4)
  length.writeUInt32BE(body.length)
  socket.write(Buffer.concat([length, body]))
}

const server = createServer((socket) => {
  sockets.add(socket)
  socket.on('close', () => sockets.delete(socket))
  socket.on('error', () => {})
  let buffer = Buffer.alloc(0)
  let authenticated = false
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32BE(0)) {
      const length = buffer.readUInt32BE(0)
      const message = JSON.parse(buffer.subarray(4, 4 + length).toString())
      buffer = buffer.subarray(4 + length)
      if (!authenticated) {
        if (message.hello !== 1 || message.token !== token) return socket.destroy()
        authenticated = true
        send(socket, { ready: 1 })
      } else if (message.command.type === 'list') {
        send(socket, { id: message.id, result: [{ status: 'idle' }] })
      }
    }
  })
})

election.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
  writeFileSync(owner, JSON.stringify({ pid: process.pid, port, protocolVersion: 1 }), {
    mode: 0o600
  })
  server.listen(socketPath, () => process.send('ready'))
})

process.on('SIGTERM', () => {
  for (const socket of sockets) socket.destroy()
  server.close(() => election.close(() => process.exit(0)))
})
