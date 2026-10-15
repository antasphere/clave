// A busy session must not keep cancelling the read that loads every chat's
// native views. Use the separate server and real preload, not mocked React.
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { openChat } from './chat-view.spec.mjs'
import { fixturePath, REPO, until } from './harness.mjs'

export async function run(t) {
  const modulePath = fixturePath('busy-chat-registry.mjs')
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
  const report = await loadBusyChatRegistry((runId) =>
    openChat(`busy-registry-${runId}`, [], undefined, {}, null, { server: 'separate' })
  )
  console.log(
    JSON.stringify({
      scenario: 'chat/busy-registry',
      runId: report.runId,
      ids: report.ids,
      sessionId: report.values.chat.record.id
    })
  )
  const chat = report.values.chat
  const { app, win, record } = chat
  try {
    const original = win.locator(`[data-session-id="${record.id}"]`)
    const input = original.locator('[data-testid="chat-view"] textarea')
    // Clear the loaded registry's eligibility, as at a boot before plugins
    // finish. Once enabled again the API is healthy throughout the assertion.
    await win.evaluate(() => window.electronAPI.pluginsDisable('clave.chat-view'))
    await win.locator('.xterm').waitFor()
    await app.evaluate(({ ipcMain, BrowserWindow }, id) => {
      const handlers = ipcMain._invokeHandlers
      const identity = handlers.get('window:identity')
      globalThis.__busyRegistryIdentity = identity
      handlers.set('window:identity', async (...args) => {
        await new Promise((resolve) => setTimeout(resolve, 200))
        return identity(...args)
      })
      let working = false
      globalThis.__busyRegistryChurn = setInterval(() => {
        working = !working
        for (const window of BrowserWindow.getAllWindows())
          window.webContents.send(`agent:state:${id}`, working ? 'working' : 'idle')
      }, 50)
    }, record.id)
    await win.evaluate(() =>
      window.electronAPI.pluginsEnable('clave.chat-view', ['sessions.read', 'sessions.write'])
    )
    assert.ok(
      await until(async () => (await input.count()) === 1 && (await input.isEnabled()), {
        tries: 40,
        gapMs: 100
      }),
      'the existing chat gets its composer while state changes continue'
    )
    t.check('native views return while another session stays busy', true)

    await win.locator('.launcher-split .launcher-btn').click()
    assert.ok(
      await until(
        async () => (await win.locator('[data-testid="chat-view"] textarea').count()) === 2
      ),
      'a new chat also receives a composer during activity'
    )
    const sessions = await win.evaluate(() => window.electronAPI.sessionsList())
    const added = sessions.find((s) => s.id !== record.id && s.adapterId === 'echo')
    assert.ok(added)
    const newChat = win.locator(`[data-session-id="${added.id}"] [data-testid="chat-view"]`)
    await newChat.locator('textarea').fill('registry new chat reply')
    await newChat.locator('textarea').press('Enter')
    await newChat.locator('.chat-turn[data-role="assistant"]').waitFor()
    assert.match(await newChat.innerText(), /registry new chat reply/)
    assert.equal(await win.locator('.xterm').count(), 0)
    t.check('a new event chat mounts and replies while activity continues', true)
  } finally {
    await app
      .evaluate(({ ipcMain }) => {
        clearInterval(globalThis.__busyRegistryChurn)
        if (globalThis.__busyRegistryIdentity)
          ipcMain._invokeHandlers.set('window:identity', globalThis.__busyRegistryIdentity)
      })
      .catch(() => {})
    await chat.close()
  }
}
