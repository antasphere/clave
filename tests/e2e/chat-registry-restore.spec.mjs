// The tab placeholder arrives before its delayed backend session. A successful
// empty registry response must be refreshed when that restore finishes.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  fixturePath,
  launchApp,
  seedWorkspaces,
  startE2eServer,
  serverFixture,
  until
} from './harness.mjs'

export async function run(t) {
  const dir = fixturePath('registry-delayed-restore')
  const root = `${dir}-root`
  const id = randomUUID()
  const key = 'registry-delayed-window'
  mkdirSync(root, { recursive: true })
  seedWorkspaces(dir, {
    workspaces: [
      { id: 'chat', name: 'Delayed restore', rootDir: root, profileFile: null, createdAt: 1 }
    ],
    activeWorkspaceId: 'chat',
    fresh: true
  })
  writeFileSync(
    path.join(dir, 'windows.json'),
    JSON.stringify({ version: 1, windows: [{ key, workspaceId: 'chat' }] })
  )
  const server = await startE2eServer('registry-delayed-restore', {
    seedFrom: dir,
    args: ['--test-no-activate', '--dev-echo-adapter']
  })
  const fixture = serverFixture(server.url, server.token)
  let app
  try {
    const records = path.join(server.dataDir, 'session-records')
    mkdirSync(records, { recursive: true })
    writeFileSync(
      path.join(records, `${id}.json`),
      JSON.stringify({
        id,
        adapterId: 'echo',
        transport: 'events',
        cwd: root,
        folderName: 'Delayed restore',
        claudeMode: true,
        antigravityMode: false,
        codexMode: false,
        piMode: false,
        claudeAgentsMode: false,
        dangerousMode: false,
        launchProfileId: 'dev-echo-adapter',
        workspaceId: 'chat',
        windowKey: key
      })
    )
    await fixture.evaluate((id) => {
      const host = globalThis.__claveE2E.sessionHost
      const start = host.start
      const list = host.list
      globalThis.__registryEmptyReads = 0
      host.start = async (input) => {
        if (input.options?.adoptSessionId === id) {
          globalThis.__registryStartWaiting = true
          await new Promise((resolve) => {
            globalThis.__registryReleaseStart = resolve
          })
        }
        return start.call(host, input)
      }
      host.list = (key) => {
        const records = list.call(host, key)
        if (globalThis.__registryStartWaiting && !records.some((s) => s.id === id))
          globalThis.__registryEmptyReads++
        return records
      }
    }, id)
    assert.ok(
      await until(() =>
        fixture.evaluate(() =>
          globalThis.__claveE2E.plugins
            .list()
            .filter((p) => p.enabled)
            .every((p) => p.status === 'active')
        )
      )
    )
    const launched = await launchApp(dir, {
      server: { url: server.url, token: server.token },
      args: ['--dev-echo-adapter']
    })
    app = launched.app
    const { win } = launched
    assert.ok(
      await until(() => fixture.evaluate(() => globalThis.__registryEmptyReads > 0)),
      'the registry successfully reads before the delayed backend exists'
    )
    assert.equal(await win.locator(`[data-terminal-tile="${id}"]`).count(), 1)
    // Let the successful empty read and any connection catch-up settle before
    // releasing the backend. Its arrival must cause a new registry read.
    await win.waitForTimeout(600)
    await fixture.evaluate(() => globalThis.__registryReleaseStart())
    const input = win.locator(`[data-session-id="${id}"] [data-testid="chat-view"] textarea`)
    assert.ok(
      await until(async () => (await input.count()) === 1 && (await input.isEnabled()), {
        tries: 40,
        gapMs: 100
      }),
      'the restored chat acquires its composer after the backend arrives'
    )
    await input.fill('restored after the empty registry response')
    await input.press('Enter')
    const reply = win.locator(
      `[data-session-id="${id}"] [data-testid="chat-view"] .chat-turn[data-role="assistant"]`
    )
    await reply.waitFor()
    assert.match(await reply.innerText(), /restored after the empty registry response/)
    t.check('a delayed restore refreshes the empty registry and gets a usable composer', true)
  } finally {
    await fixture.evaluate(() => globalThis.__registryReleaseStart?.()).catch(() => {})
    await app?.close()
    await server.stop()
    rmSync(dir, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
}
