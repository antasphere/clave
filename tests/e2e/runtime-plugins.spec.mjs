import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { REPO, launchApp, seedWorkspaces, stubFolderDialog, callMcp, until } from './harness.mjs'

/** Real local plugin and daemon; no external providers, network, or installed app state. */
export async function run(t) {
  const root = mkdtempSync(join(REPO, '.runtime-plugin-e2e-'))
  const userData = join(root, 'profile')
  const folder = join(root, 'plugin')
  mkdirSync(folder)
  const manifest = {
    apiVersion: 1,
    id: 'fixture.runtime',
    name: 'Fixture runtime',
    version: '1.0.0',
    provider: {
      id: 'fixture.provider',
      name: 'Fixture provider',
      entry: 'provider.cjs',
      command: ['node'],
      capabilities: { permissions: false, questions: false, resume: false }
    },
    views: [
      {
        id: 'fixture-view',
        name: 'Fixture enhancer',
        entry: 'view.html',
        mimeTypes: ['text/html'],
        capabilities: ['conversation.read', 'composer.setDraft']
      },
      {
        id: 'operations',
        name: 'Workspace actions',
        entry: 'view.html',
        mimeTypes: ['text/html'],
        capabilities: ['workspace.readFile', 'workspace.execute', 'conversation.send']
      }
    ]
  }
  const saveManifest = () =>
    writeFileSync(join(folder, 'clave-plugin.json'), JSON.stringify(manifest))
  saveManifest()
  writeFileSync(join(root, 'note.txt'), 'Workspace file contents')
  writeFileSync(
    join(folder, 'provider.cjs'),
    `
exports.createAdapter = (_launch, emit) => ({
  capabilities: {permissions:false,questions:false,resume:false},
  async start() { emit({type:'status',status:'idle'}) },
  async send(text) { emit({type:'message',message:{kind:'message',id:'reply-'+Date.now(),role:'assistant',text}}); emit({type:'turn-end',outcome:'completed'}) },
  async interrupt() {}, async respond() {}, async dispose() {}
})`
  )
  writeFileSync(
    join(folder, 'view.html'),
    `<!doctype html><html><body>
<p id="ready">Waiting</p><script>
window.clave.ready.then(() => document.querySelector('#ready').textContent='Enhancer ready')
</script></body></html>`
  )
  seedWorkspaces(userData, {
    workspaces: [
      { id: 'runtime-test', name: 'Runtime test', rootDir: root, profileFile: null, createdAt: 1 }
    ],
    activeWorkspaceId: 'runtime-test'
  })
  let app
  try {
    const launched = await launchApp(userData)
    app = launched.app
    const win = launched.win
    await stubFolderDialog(app, { returns: folder })
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: true })
    })
    const installed = await win.evaluate(() => window.electronAPI.runtimePlugins.install())
    assert.equal(installed.manifest.id, manifest.id)
    t.check('installs local fixture through real preload and native picker', true)
    const providers = await win.evaluate(() => window.electronAPI.runtimePlugins.providers())
    assert(providers.some((p) => p.id === 'fixture.provider'))
    const created = await win.evaluate(
      (cwd) => window.electronAPI.conversations.create({ provider: 'fixture.provider', cwd }),
      root
    )
    const id = created.session.id
    const pin = created.session.pluginBindings.provider.revision
    await win.evaluate(async (sessionId) => {
      await window.electronAPI.conversations.publishArtifact(
        sessionId,
        {
          title: 'Fixture artifact',
          mimeType: 'text/html',
          content: '<h1>Generated HTML</h1>',
          fallback: 'Original safe fallback'
        },
        'artifact-fixture'
      )
    }, id)
    await win.reload()
    await win.waitForLoadState('domcontentloaded')
    await until(async () => (await win.locator(`[data-conversation-id="${id}"]`).count()) > 0)
    await callMcp(app, 'focus', { sessionId: id })
    const panel = win.locator(`[data-conversation-id="${id}"]`)
    await panel.getByText('Original safe fallback', { exact: true }).waitFor()
    t.check('artifact history survives renderer reload with core fallback', true)
    await assert.rejects(() =>
      callMcp(app, 'publishArtifact', {
        title: 'Rejected',
        mimeType: 'text/plain',
        content: 'Anonymous',
        fallback: 'Anonymous',
        commandId: 'anonymous'
      })
    )
    await callMcp(app, 'publishArtifact', {
      callerSessionId: id,
      title: 'Agent report',
      mimeType: 'text/markdown',
      content: '**Stored report**',
      fallback: 'Stored report',
      commandId: 'agent-report'
    })
    t.check('artifact publication requires a conversation caller and keeps original content', true)
    const originalArtifact = panel
      .locator('[data-artifact-id]')
      .filter({ hasText: 'Fixture artifact' })
    await originalArtifact
      .getByRole('button', { name: 'Preview HTML (no capabilities)', exact: true })
      .click()
    await originalArtifact
      .frameLocator('iframe')
      .getByText('Generated HTML', { exact: true })
      .waitFor()
    const rawFrame = win.frames().find((f) => f.url().startsWith('clave-plugin:'))
    assert(rawFrame)
    await assert.rejects(() =>
      rawFrame.evaluate(() => window.clave.request('conversation.read', {}))
    )
    await originalArtifact.getByRole('button', { name: 'View original', exact: true }).click()
    t.check('generated HTML has no privileged RPC access by default', true)
    await originalArtifact.getByRole('button', { name: 'Fixture enhancer', exact: true }).click()
    const frame = panel.frameLocator('iframe')
    await frame.locator('#ready').getByText('Enhancer ready').waitFor()
    const iframe = win.frames().find((f) => f.url().startsWith('clave-plugin:'))
    assert(iframe)
    const isolation = await iframe.evaluate(() => {
      let parentBlocked = false
      try {
        void parent.document.body
      } catch {
        parentBlocked = true
      }
      return { electron: typeof window.electronAPI, parentBlocked }
    })
    assert.deepEqual(isolation, { electron: 'undefined', parentBlocked: true })
    t.check('sandbox denies preload and parent DOM', true)
    const history = await iframe.evaluate(() => window.clave.request('conversation.read', {}))
    assert(history.entries.some((entry) => entry.kind === 'artifact'))
    await assert.rejects(() =>
      iframe.evaluate(() => window.clave.request('conversation.send', { text: 'forbidden' }))
    )
    await assert.rejects(() =>
      iframe.evaluate(() => window.clave.request('conversation.read', { sessionId: 'spoof' }))
    )
    t.check('scoped RPC permits read and rejects capability and scope spoof', true)
    await iframe.evaluate(() => window.clave.request('composer.setDraft', { text: 'Plugin draft' }))
    await assert.rejects(() =>
      iframe.evaluate(() => window.clave.request('composer.setDraft', { text: 'Overwrite' }))
    )
    t.check('plugin cannot overwrite a nonempty draft', true)
    await iframe.evaluate(() =>
      parent.postMessage(
        {
          type: 'clave:request',
          id: 'spoof',
          method: 'composer.setDraft',
          params: { text: 'Spoofed' }
        },
        '*'
      )
    )
    assert.equal(await panel.locator('textarea').inputValue(), 'Plugin draft')
    t.check('untrusted window messages are not RPC requests', true)
    await originalArtifact.getByRole('button', { name: 'Workspace actions', exact: true }).click()
    await panel.frameLocator('iframe').locator('#ready').getByText('Enhancer ready').waitFor()
    const operations = win.frames().find((f) => f.url().startsWith('clave-plugin:'))
    assert(operations)
    assert.equal(
      await operations.evaluate(() =>
        window.clave.request('workspace.readFile', { path: 'note.txt' })
      ),
      'Workspace file contents'
    )
    await assert.rejects(() =>
      operations.evaluate(() =>
        window.clave.request('workspace.readFile', { path: 'profile/conversation-service/token' })
      )
    )
    t.check('workspace reads cannot expose private Clave credentials inside the workspace', true)
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0 })
    })
    await assert.rejects(() =>
      operations.evaluate(() =>
        window.clave.request('conversation.send', { text: 'declined message' })
      )
    )
    const beforeSend = await win.evaluate(
      (sessionId) => window.electronAPI.conversations.snapshot(sessionId),
      id
    )
    assert(
      !beforeSend.entries.some(
        (entry) => entry.kind === 'message' && entry.text === 'declined message'
      )
    )
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await operations.evaluate(() =>
      window.clave.request('conversation.send', { text: 'approved plugin message' })
    )
    assert(
      await until(async () => {
        const snapshot = await win.evaluate(
          (sessionId) => window.electronAPI.conversations.snapshot(sessionId),
          id
        )
        return snapshot.entries.some(
          (entry) =>
            entry.kind === 'message' &&
            entry.role === 'assistant' &&
            entry.text === 'approved plugin message'
        )
      })
    )
    assert.equal(await panel.locator('textarea').inputValue(), 'Plugin draft')
    t.check('confirmed plugin send uses the provider without overwriting the composer', true)
    const job = await operations.evaluate(
      (node) =>
        window.clave.request('workspace.execute', {
          argv: [node, '-e', 'process.stdout.write("workspace-job")']
        }),
      process.execPath
    )
    const result = await until(async () => {
      const current = await operations.evaluate(
        (jobId) => window.clave.request('workspace.jobRead', { jobId }),
        job.id
      )
      return current.status !== 'running' ? current : null
    })
    assert.equal(result?.status, 'completed')
    assert.equal(result.output, 'workspace-job')
    const cancellable = await operations.evaluate(
      (node) =>
        window.clave.request('workspace.execute', {
          argv: [node, '-e', 'setInterval(() => {}, 1000)']
        }),
      process.execPath
    )
    await operations.evaluate(
      (jobId) => window.clave.request('workspace.cancelJob', { jobId }),
      cancellable.id
    )
    const cancelled = await operations.evaluate(
      (jobId) => window.clave.request('workspace.jobRead', { jobId }),
      cancellable.id
    )
    assert.equal(cancelled.status, 'cancelled')
    t.check('approved workspace jobs expose bounded output and cancellation through RPC', true)
    const broken = await win.evaluate(
      (sessionId) =>
        window.electronAPI.conversations.publishArtifact(
          sessionId,
          {
            title: 'Broken generated page',
            mimeType: 'text/html',
            content: '<script>throw new Error("fixture failure")</script>',
            fallback: 'Content survives a broken page'
          },
          'broken-page'
        ),
      id
    )
    const brokenView = panel.locator(`[data-artifact-id="${broken.id}"]`)
    await brokenView
      .getByRole('button', { name: 'Preview HTML (no capabilities)', exact: true })
      .click()
    await brokenView
      .getByRole('alert')
      .getByText('The view failed. Showing original content.', { exact: true })
      .waitFor()
    assert.equal(await brokenView.locator('iframe').count(), 0)
    await brokenView.getByText('Content survives a broken page', { exact: true }).waitFor()
    t.check('a page script failure falls back without breaking conversation history', true)
    manifest.version = '2.0.0'
    saveManifest()
    await win.evaluate(() => window.electronAPI.runtimePlugins.update('fixture.runtime'))
    const old = await win.evaluate(
      (sessionId) => window.electronAPI.conversations.snapshot(sessionId),
      id
    )
    assert.equal(old.session.pluginBindings.provider.revision, pin)
    const next = await win.evaluate(
      (cwd) => window.electronAPI.conversations.create({ provider: 'fixture.provider', cwd }),
      root
    )
    assert.notEqual(next.session.pluginBindings.provider.revision, pin)
    t.check('update retains old session revision and pins new sessions to new revision', true)
    await win.evaluate(() => window.electronAPI.runtimePlugins.setEnabled('fixture.runtime', false))
    await panel.getByText('Original safe fallback', { exact: true }).waitFor()
    assert.equal(await panel.locator('iframe').count(), 0)
    t.check('disable returns active enhancer to original without losing composer', true)
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.send(
        'menu:open-settings-section',
        'runtime-plugins'
      )
    )
    const settings = win.locator('[data-settings-page="runtime plugins"]')
    await settings.getByText('Fixture runtime · 2.0.0', { exact: true }).waitFor()
    await settings.getByRole('button', { name: 'Enable', exact: true }).click()
    assert(
      await until(
        async () =>
          (await win.evaluate(() => window.electronAPI.runtimePlugins.list())).find(
            (plugin) => plugin.manifest.id === 'fixture.runtime'
          )?.enabled
      )
    )
    t.check('runtime plugin settings show the installed revision and manage activation', true)
    await stubFolderDialog(app, { returns: join(REPO, 'examples/runtime-plugins/echo-report') })
    await settings.getByRole('button', { name: 'Install local folder', exact: true }).click()
    assert(
      await until(async () =>
        (await win.evaluate(() => window.electronAPI.runtimePlugins.providers())).some(
          (provider) => provider.id === 'example.echo'
        )
      )
    )
    const demo = await win.evaluate(
      (cwd) => window.electronAPI.conversations.create({ provider: 'example.echo', cwd }),
      root
    )
    await win.evaluate(
      (sessionId) =>
        window.electronAPI.conversations.send(sessionId, 'hello plugins', 'example-send'),
      demo.session.id
    )
    assert(
      await until(async () =>
        (
          await win.evaluate(
            (sessionId) => window.electronAPI.conversations.snapshot(sessionId),
            demo.session.id
          )
        ).entries.some(
          (entry) => entry.kind === 'artifact' && JSON.parse(entry.content).words === 2
        )
      )
    )
    await win.reload()
    await win.waitForLoadState('domcontentloaded')
    await until(
      async () => (await win.locator(`[data-conversation-id="${demo.session.id}"]`).count()) > 0
    )
    await callMcp(app, 'focus', { sessionId: demo.session.id })
    const demoPanel = win.locator(`[data-conversation-id="${demo.session.id}"]`)
    await demoPanel.getByRole('button', { name: 'Interactive report', exact: true }).click()
    await demoPanel
      .frameLocator('iframe')
      .getByRole('button', { name: 'Prepare a follow-up', exact: true })
      .click()
    assert(
      await until(
        async () =>
          (await demoPanel.locator('textarea').inputValue()) ===
          'Explain the report in more detail.'
      )
    )
    await demoPanel.getByRole('button', { name: 'Expand', exact: true }).click()
    const expanded = win.getByRole('dialog')
    await expanded
      .frameLocator('iframe')
      .getByRole('heading', { name: 'Message report', exact: true })
      .waitFor()
    await expanded.getByRole('button', { name: 'Close expanded view', exact: true }).click()
    await demoPanel
      .frameLocator('iframe')
      .getByRole('heading', { name: 'Message report', exact: true })
      .waitFor()
    t.check(
      'the documented example installs from settings, emits an artifact and runs inline or expanded',
      true
    )
    if (process.env.CLAVE_PLUGIN_SCREENSHOT_DIR) {
      mkdirSync(process.env.CLAVE_PLUGIN_SCREENSHOT_DIR, { recursive: true })
      await demoPanel.screenshot({
        path: join(process.env.CLAVE_PLUGIN_SCREENSHOT_DIR, 'runtime-plugin-example.png')
      })
    }
  } finally {
    await app?.close()
    const owner = join(userData, 'conversation-service/owner.json')
    if (existsSync(owner)) {
      const { pid } = JSON.parse(readFileSync(owner, 'utf8'))
      if (Number.isSafeInteger(pid) && pid > 1) {
        try {
          process.kill(pid, 'SIGTERM')
        } catch (e) {
          if (e.code !== 'ESRCH') t.check('test-owned daemon accepts cleanup signal', false, e.code)
        }
        await until(async () => {
          try {
            process.kill(pid, 0)
            return false
          } catch {
            return true
          }
        })
      }
    }
    rmSync(root, { recursive: true, force: true })
  }
}
