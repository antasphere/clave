import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { freePorts, startE2eServer } from './harness.mjs'

// A saved remote endpoint has to keep its address across a daemon restart.
// Both daemons are ours; no desktop or installed Clave process is stopped.
export async function run(t) {
  const [port] = await freePorts()
  const name = `fleet-restart-${randomUUID()}`
  const options = {
    port,
    env: { SHELL: '/bin/sh' },
    args: ['--daemon', '--host', '127.0.0.1', '--test-no-activate', '--dev-echo-adapter']
  }
  let server = await startE2eServer(name, options)
  try {
    const url = server.url
    const token = server.token
    await server.stop()
    server = await startE2eServer(name, { ...options, keep: true })
    assert.equal(server.url, url, 'restart must preserve the address saved by both Macs')
    assert.ok(
      server.token === token,
      'restart must preserve the credential already saved by both Macs'
    )
    assert.equal(new URL(server.url).port, String(port), 'the allocated endpoint is used')
    t.check('standalone fleet restart keeps the saved address and credential', true)
  } finally {
    await server.stop()
  }
}
