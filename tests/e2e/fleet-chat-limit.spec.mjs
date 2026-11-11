/**
 * A chat on a Clave server whose account is out shows the limit card, not
 * the "server ended" pane (PRDCT-4329). One daemon, one Mac; the chat runs
 * the real Claude chat adapter on the daemon over a stand-in CLI
 * (`fixtures/claude-limit-stub.mjs`) that answers the first message with the
 * CLI's synthetic "out of usage credits" reply and ends. The daemon reports
 * the limit on its push channel (`session.limit_reported`); the Mac's
 * window must hear it for the server's key and draw `data-chat-ended="limit"`.
 *
 * Fails if: the window does not relay the server's limit report (only this
 * Mac's transports heard it until PRDCT-4329), so the pane draws the server's
 * plain ended state (`data-chat-ended="server"`) instead.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { REPO } from './harness.mjs'
import {
  fleetWorld,
  connectMac,
  eventually,
  owned,
  request,
  showServer
} from './fixtures/fleet-world.mjs'

export async function run(t) {
  const world = await fleetWorld('chat-limit', { count: 1 })
  try {
    const [server] = world.servers
    const processes = () => {
      const file = path.join(server.root, 'claude-limit-stub-processes.jsonl')
      return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : []
    }
    await request(server, '/launch-profiles', {
      profile: {
        id: 'chat-limit-stub',
        name: 'Chat limit stream stub',
        family: 'claude',
        command: [process.execPath, path.join(REPO, 'tests/e2e/fixtures/claude-limit-stub.mjs')],
        additionalArgs: []
      }
    })
    const started = await request(server, '/sessions/start', {
      cwd: server.root,
      options: { claudeMode: true, launchProfileId: 'chat:claude:chat-limit-stub' }
    })

    const mac = await world.mac('limit')
    await connectMac(mac, world.servers, { ui: false })
    const owner = mac.owners[0].id
    const key = owned('session', owner, started.id)
    const { win } = mac
    await showServer(mac, 0)
    await win.locator(`[data-sidebar-item-id="${key}"]`).click()
    const pane = win.locator(`[data-session-id="${key}"]`)
    const chat = pane.locator('[data-testid="chat-view"]')
    const composer = chat.getByRole('textbox', { name: 'Message', exact: true })
    await chat.waitFor()
    await eventually(() => composer.isEnabled(), 'the live chat’s composer is enabled')

    await composer.fill(`hello ${world.run.slice(-8)}`)
    await composer.press('Enter')
    await eventually(() => processes().length >= 1, 'the stub CLI started')
    await eventually(
      async () => (await pane.locator('[data-chat-ended]').count()) > 0,
      'the pane reads the chat as ended once the CLI stops at its limit'
    )
    // The ended state settles once the report and the exit are both in.
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const ended = await pane.locator('[data-chat-ended]').first().getAttribute('data-chat-ended')
    t.equal('a server tab stopped at its limit draws the limit card', ended, 'limit')
    assert.deepEqual(mac.errors, [])
  } finally {
    await world.close()
  }
}
