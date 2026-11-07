// A transient registry failure must recover without requiring another user
// action, plugin notification, or unrelated session-state change.
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { openChat } from './chat-view.spec.mjs'
import { until, fixturePath, REPO } from './harness.mjs'

export async function run(t) {
  const modulePath = fixturePath('retry-chat-registry.mjs')
  await build({
    entryPoints: [path.join(REPO, 'tests/e2e/fixtures/busy-chat-registry.mjs')],
    outfile: modulePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"
    }
  })
  const { loadBusyChatRegistry } = await import(pathToFileURL(modulePath).href)
  const report = await loadBusyChatRegistry(
    (runId) => openChat(`registry-retry-${runId}`, [], undefined, {}, null, { server: 'separate' }),
    'chat/registry-retry'
  )
  console.log(
    JSON.stringify({
      scenario: 'chat/registry-retry',
      runId: report.runId,
      sessionId: report.values.chat.record.id
    })
  )
  const chat = report.values.chat
  const { win, fixture, record } = chat
  try {
    await fixture.evaluate(() => {
      const plugins = globalThis.__claveE2E.plugins
      globalThis.__registryList = plugins.list
      globalThis.__registryFailures = 0
      plugins.list = () => {
        globalThis.__registryFailures++
        throw new Error('temporary registry read failure')
      }
    })
    await win.locator('.launcher-split .launcher-btn').click()
    await win.locator('.xterm').waitFor()
    assert.ok(await fixture.evaluate(() => globalThis.__registryFailures > 0))
    await fixture.evaluate(() => {
      globalThis.__claveE2E.plugins.list = globalThis.__registryList
    })
    // No plugin event is published when the failing read becomes healthy.
    // The same tab must acquire its native view without another launcher click.
    assert.ok(
      await until(async () => (await win.locator('.xterm').count()) === 0, {
        tries: 40,
        gapMs: 100
      }),
      'an existing blank event tab recovers after a transient registry failure'
    )
    assert.equal(await win.locator('[data-testid="chat-view"] textarea').count(), 2)
    const added = (await win.evaluate(() => window.electronAPI.sessionsList())).find(
      (session) => session.id !== record.id && session.adapterId === 'echo'
    )
    assert.ok(added)
    const pane = win.locator(`[data-session-id="${added.id}"] [data-testid="chat-view"]`)
    const visible = pane.locator('textarea')
    await visible.fill('registry recovered without another action')
    await visible.press('Enter')
    const replies = pane.locator('.chat-turn[data-role="assistant"]')
    await replies.waitFor()
    assert.match(await replies.innerText(), /registry recovered without another action/)
    t.check(
      'a failed registry read recovers its existing tab and reply without another event',
      true
    )
  } finally {
    await fixture
      .evaluate(() => {
        if (globalThis.__registryList)
          globalThis.__claveE2E.plugins.list = globalThis.__registryList
      })
      .catch(() => {})
    await chat.close()
  }
}
