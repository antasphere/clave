import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import ts from 'typescript'
import { assertFileEndpoint, observeDaemon } from './fleet-http-observer.mjs'

describe('file endpoint completion', () => {
  it('waits for the actual response when the filesystem changes first', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'clave-file-response-'))
    let release, written
    const held = new Promise((resolve) => (release = resolve))
    const saved = new Promise((resolve) => (written = resolve))
    const server = createServer(async (_request, response) => {
      writeFileSync(path.join(directory, 'file'), 'edited')
      written()
      await held
      response.writeHead(200)
      response.end('ok')
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const observer = await observeDaemon(`http://127.0.0.1:${server.address().port}`)
    const request = fetch(observer.url + '/files/write', { method: 'POST' })
    let completion
    try {
      await saved
      expect(readFileSync(path.join(directory, 'file'), 'utf8')).toBe('edited')
      let settled = false
      completion = Promise.resolve()
        .then(() => assertFileEndpoint([observer, { entries: [] }], [0, 0], 0, '/files/write'))
        .finally(() => (settled = true))
      completion.catch(() => {})
      await new Promise(setImmediate)
      expect(settled).toBe(false)
      release()
      await (await request).text()
      await completion
    } finally {
      release()
      await completion?.catch(() => {})
      await request.catch(() => {})
      await observer.close()
      await new Promise((resolve) => server.close(resolve))
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('still refuses a failed response and a response on the wrong owner', async () => {
    await expect(
      Promise.resolve().then(() =>
        assertFileEndpoint(
          [{ entries: [{ path: '/files/write', status: 500 }] }, { entries: [] }],
          [0, 0],
          0,
          '/files/write'
        )
      )
    ).rejects.toThrow('must complete on owner 1')
    await expect(
      Promise.resolve().then(() =>
        assertFileEndpoint(
          [
            { entries: [{ path: '/files/write', status: 200 }] },
            { entries: [{ path: '/files/write', status: 200 }] }
          ],
          [0, 0],
          0,
          '/files/write'
        )
      )
    ).rejects.toThrow('must not reach the other daemon')
  })

  it('fails within its bound when no matching response arrives', async () => {
    await expect(
      Promise.resolve().then(() =>
        assertFileEndpoint([{ entries: [] }, { entries: [] }], [0, 0], 0, '/files/write', {
          timeoutMs: 25
        })
      )
    ).rejects.toThrow('must complete on owner 1')
  })

  it('the default wait expires at ten seconds', async () => {
    vi.useFakeTimers()
    try {
      let failure
      const completion = assertFileEndpoint(
        [{ entries: [] }, { entries: [] }],
        [0, 0],
        0,
        '/files/write'
      ).catch((error) => (failure = error.message))
      await vi.advanceTimersByTimeAsync(10_000)
      expect(failure).toContain('/files/write must complete on owner 1')
      await completion
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('does not schedule a wait when the matching response is already present', async () => {
    vi.useFakeTimers()
    try {
      const completion = assertFileEndpoint(
        [{ entries: [{ path: '/files/write', status: 204 }] }, { entries: [] }],
        [0, 0],
        0,
        '/files/write'
      )
      expect(vi.getTimerCount()).toBe(0)
      await completion
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('every spec awaits the endpoint observation before continuing', () => {
    const directory = new URL('../', import.meta.url)
    const missing = []
    let calls = 0
    for (const name of readdirSync(directory).filter((name) => name.endsWith('.spec.mjs'))) {
      const source = ts.createSourceFile(
        name,
        readFileSync(new URL(name, directory), 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS
      )
      const visit = (node) => {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'assertFileEndpoint'
        ) {
          calls++
          if (!ts.isAwaitExpression(node.parent)) missing.push(name)
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
    expect(calls).toBeGreaterThan(0)
    expect(missing).toEqual([])
  })
})
