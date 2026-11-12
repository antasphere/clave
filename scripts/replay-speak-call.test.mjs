/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS test of a TypeScript script */
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { replaySpeakCall } from './replay-speak-call.ts'

/* The hand check's throwaway folder holds a sealed key and its master key:
   every way out removes it (verifier round 3). The service here is a local
   port nobody listens on, so the check fails, and nothing real is spent;
   the key is invented. */

let root
let lines
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'replay-speak-test-'))
  lines = []
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** A local port with nothing listening on it. */
const closedPort = async () => {
  const server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

describe('replay-speak-call (verifier round 3)', () => {
  it('a failed check exits 1 and leaves no folder, no sealed key, behind', async () => {
    const text = path.join(root, 'page.txt')
    writeFileSync(text, 'Hello.')
    const code = await replaySpeakCall(
      [text],
      { ELEVENLABS_API_KEY: 'xi-invented-key' },
      {
        baseUrl: `http://127.0.0.1:${await closedPort()}`,
        tmpRoot: root,
        log: (line) => lines.push(line),
        error: (line) => lines.push(line)
      }
    )
    expect(code).toBe(1)
    expect(lines.join('\n')).toMatch(/^check failed: /m)
    expect(lines.join('\n')).not.toContain('xi-invented-key')
    expect(readdirSync(root).filter((name) => name.startsWith('clave-speak-'))).toEqual([])
  })

  it('a missing key or file is the usage line and exit 2, with no folder made', async () => {
    const code = await replaySpeakCall([], {}, { tmpRoot: root, error: (l) => lines.push(l) })
    expect(code).toBe(2)
    expect(lines[0]).toMatch(/^usage: /)
    expect(readdirSync(root)).toEqual([])
  })
})
