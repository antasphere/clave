import { describe, it, expect } from 'vitest'
import * as http from 'http'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { startServer, readDiscovery, ServerBootError, type InProcessServer } from './server-boot'

const identity = { kind: 'shell' as const, name: 'clave-shell 2.0.0', pid: 777 }

/** A server that answers every request with one status. */
function answering(status: number): Promise<{ url: string; stop: () => Promise<void> }> {
  const server = http.createServer((_req, res) => res.writeHead(status).end())
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      resolve({
        url: `http://127.0.0.1:${port}`,
        stop: () => new Promise((r) => server.close(() => r()))
      })
    })
  })
}

describe('startServer, the attach error paths', () => {
  it('a server that answers /health/live with a 503 is reported as that, not as "nothing answers"', async () => {
    const userData = mkdtempSync(path.join(tmpdir(), 'clave-server-boot-503-'))
    const sick = await answering(503)
    const starter = async (): Promise<InProcessServer> => {
      throw new Error('must not be called: the url was given')
    }
    try {
      await expect(
        startServer({
          env: { CLAVE_SERVER_URL: sick.url, CLAVE_SERVER_TOKEN: 'x' },
          userData,
          identity,
          startInProcess: starter
        })
      ).rejects.toThrow(/answered 503 on \/health\/live/)
      expect(readDiscovery(userData)).toMatchObject({ ok: false, url: sick.url })
      expect(readDiscovery(userData)?.error).toMatch(/503/)
      expect(readDiscovery(userData)?.error).not.toMatch(/nothing answers/)
    } finally {
      await sick.stop()
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('in-process: a server of our own that answers 503 is stopped exactly once', async () => {
    const userData = mkdtempSync(path.join(tmpdir(), 'clave-server-boot-503-own-'))
    const sick = await answering(503)
    let stops = 0
    const starter = async (): Promise<InProcessServer> => ({
      url: sick.url,
      token: 'x',
      stop: async () => {
        stops++
      }
    })
    try {
      const err = await startServer({ env: {}, userData, identity, startInProcess: starter }).catch(
        (e) => e
      )
      expect(err).toBeInstanceOf(ServerBootError)
      expect((err as ServerBootError).mode).toBe('in-process')
      expect(stops).toBe(1)
    } finally {
      await sick.stop()
      rmSync(userData, { recursive: true, force: true })
    }
  })
})
