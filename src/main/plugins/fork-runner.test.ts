import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { forkRunner } from './fork-runner'
import type { RunnerProcess } from './plugin-host'

// The forked runner's wiring, against a child of this test's own that speaks
// the runner's first exchange: the first message names `main`, the child
// answers `plugin.ready`, echoes what it is sent and exits on
// `host.deactivate`. The real runner is bundled by electron-vite and proven
// end to end by the suite; this pins the spawner's side of the channel.
let temporary: string
const live: RunnerProcess[] = []
afterEach(() => {
  for (const process of live) process.kill()
  live.length = 0
  rmSync(temporary, { recursive: true, force: true })
})

function fixture(body: string): string {
  temporary = mkdtempSync(join(tmpdir(), 'clave-fork-runner-'))
  const file = join(temporary, 'child.cjs')
  writeFileSync(file, body)
  return file
}
const CHILD = `
process.once('message', (first) => {
  process.send({ jsonrpc: '2.0', method: 'plugin.ready', params: { main: first.main } })
  process.on('message', (message) => {
    if (message.method === 'host.deactivate') process.exit(0)
    process.send({ echo: message })
  })
})
process.stderr.write('child up\\n')
`
const waitFor = <T>(subscribe: (resolve: (value: T) => void) => void): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), 5_000)
    subscribe((value) => {
      clearTimeout(timer)
      resolve(value)
    })
  })

describe('the forked plugin runner', () => {
  it('hands the child its main, relays its messages and output, and ends on deactivate', async () => {
    const spawn = forkRunner({ runner: fixture(CHILD) })
    const messages: unknown[] = []
    const output: string[] = []
    const process = spawn({ id: 'x', main: '/plugins/x/main.mjs', cwd: temporary, env: {} })
    live.push(process)
    process.onMessage((m) => messages.push(m))
    process.onOutput((_stream, text) => output.push(text))
    const exit = waitFor<number | null>((resolve) => process.onExit(resolve))
    const first = await waitFor<unknown>((resolve) =>
      process.onMessage((m) => {
        if ((m as { method?: string }).method === 'plugin.ready') resolve(m)
      })
    )
    expect(first).toEqual({
      jsonrpc: '2.0',
      method: 'plugin.ready',
      params: { main: '/plugins/x/main.mjs' }
    })
    process.postMessage({ jsonrpc: '2.0', id: 1, method: 'commands.execute' })
    await waitFor<unknown>((resolve) =>
      process.onMessage((m) => {
        if ((m as { echo?: unknown }).echo) resolve(m)
      })
    )
    expect(messages).toContainEqual({
      echo: { jsonrpc: '2.0', id: 1, method: 'commands.execute' }
    })
    process.postMessage({ jsonrpc: '2.0', method: 'host.deactivate' })
    expect(await exit).toBe(0)
    expect(output.join('')).toContain('child up')
    expect(() => process.postMessage({})).toThrow('closed its channel')
  })
  it('reports a runner that could not start as an exit, once', async () => {
    const spawn = forkRunner({
      runner: fixture(CHILD),
      execPath: join(temporary, 'no-such-binary')
    })
    const process = spawn({ id: 'x', main: '/m', cwd: temporary, env: {} })
    live.push(process)
    let exits = 0
    const code = await waitFor<number | null>((resolve) =>
      process.onExit((c) => {
        exits += 1
        resolve(c)
      })
    )
    expect(code).toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(exits).toBe(1)
  })
  it('kills the child on kill', async () => {
    const spawn = forkRunner({ runner: fixture(CHILD) })
    const process = spawn({ id: 'x', main: '/m', cwd: temporary, env: {} })
    const exit = waitFor<number | null>((resolve) => process.onExit(resolve))
    await waitFor<unknown>((resolve) => process.onMessage(resolve))
    process.kill()
    expect(await exit).toBeNull()
  })
})
