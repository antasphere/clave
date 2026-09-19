import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchApp, seedWorkspaces, until, stubFolderDialog, callMcp } from './harness.mjs'

export async function run(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'clave-lane2-plugins-'))
  const dir = path.join(root, 'profile')
  seedWorkspaces(dir, { workspaces: [], activeWorkspaceId: null })
  const tmuxDir = path.join(root, 'tmux')
  mkdirSync(tmuxDir)
  // Unique profile gives MCP an ephemeral port; tmux gets its own socket directory.
  const { app, win } = await launchApp(dir, { env: { TMUX_TMPDIR: tmuxDir } })
  let targetId
  try {
    const terminal = await callMcp(app, 'openSession', {
      cwd: root,
      mode: 'terminal',
      name: 'Plugin permission target'
    })
    targetId = terminal.sessionId
    const terminalText = async () =>
      (
        await callMcp(app, 'readSession', {
          sessionId: targetId,
          callerSessionId: targetId,
          lines: 200
        })
      ).text ?? ''
    await win.evaluate(
      (id) => window.electronAPI.writeSession(id, "printf 'PLUGIN_TARGET_%s\\n' READY\r"),
      targetId
    )
    if (!(await until(async () => (await terminalText()).includes('PLUGIN_TARGET_READY')))) {
      throw new Error('Permission target terminal did not become ready')
    }
    const marker = 'PLUGIN_FORBIDDEN_INPUT'
    await win.click('.sidebar-footer-btn[aria-label="Settings"]')
    await win.click('[data-settings-nav-row="plugins"]')
    const hello = await until(async () =>
      (await win.evaluate(() => window.electronAPI.pluginsList())).find(
        (p) => p.id === 'clave.hello' && p.status === 'active'
      )
    )
    t.check('bundled hello activates', !!hello, hello)
    const utility = await app.evaluate(({ app }) =>
      app.getAppMetrics().filter((m) => m.name === 'Clave plugin: clave.hello')
    )
    t.equal('hello runs in one utility process', utility.length, 1)
    // A deliberately broken boundary proves these assertions can fail.
    if (process.env.CLAVE_PLUGIN_MUTATE_TOKENS === '1') {
      await win.evaluate(() => {
        Object.getPrototypeOf(document.createElement('webview')).insertCSS = async () => ''
      })
    }
    await win.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    await win.getByRole('button', { name: 'Open Hello panel', exact: true }).click()
    await win.waitForSelector('[data-plugin-panel="hello"] webview')
    const guestSurface = () =>
      win.evaluate(async () => {
        const view = document.querySelector('[data-plugin-panel="hello"] webview')
        try {
          return await view.executeJavaScript(
            'getComputedStyle(document.documentElement).getPropertyValue("--surface-0").trim()'
          )
        } catch {
          return null
        }
      })
    const hostSurface = await win.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--surface-0').trim()
    )
    t.check(
      'guest receives the app surface token',
      await until(async () => (await guestSurface()) === hostSurface),
      { hostSurface, guestSurface: await guestSurface() }
    )
    const guestGuard = await win.evaluate(async () =>
      document
        .querySelector('webview')
        .executeJavaScript('({node:typeof require,bridge:typeof window.electronAPI})')
    )
    t.equal('surface has no Node require', guestGuard.node, 'undefined')
    t.equal('surface has no app preload', guestGuard.bridge, 'undefined')
    await win.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
    const lightSurface = await win.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--surface-0').trim()
    )
    t.check(
      'live theme changes reach the guest',
      await until(async () => (await guestSurface()) === lightSurface),
      { lightSurface, guestSurface: await guestSurface() }
    )
    await win.getByRole('button', { name: 'Run Say hello', exact: true }).click()
    t.check(
      'command traverses host bridge and notifies renderer',
      await until(async () => await win.getByText('Hello from Clave', { exact: true }).isVisible())
    )
    const url = await win.evaluate(() => document.querySelector('webview').getURL())
    await win.getByRole('switch', { name: 'Enable Hello Clave', exact: true }).click()
    t.check(
      'disabling removes panel',
      await until(async () => (await win.locator('[data-plugin-panel]').count()) === 0)
    )
    const disabled = await win.evaluate(() => window.electronAPI.pluginsList())
    t.equal(
      'disabled plugin contributions are removed',
      disabled.find((p) => p.id === 'clave.hello').panels.length,
      0
    )
    const revoked = await app.evaluate(
      async ({ session }, url) => (await session.fromPartition('persist:view').fetch(url)).status,
      url
    )
    t.equal('disabled surface URL is revoked', revoked, 404)
    const installed = JSON.parse(
      readFileSync(path.join(dir, 'clave-plugins', 'installed.json'), 'utf8')
    )
    t.equal(
      'disable persists in isolated installed.json',
      installed.find((p) => p.id === 'clave.hello').enabled,
      false
    )
    await win.getByRole('switch', { name: 'Enable Hello Clave', exact: true }).click()
    await win.getByRole('button', { name: 'Enable plugin', exact: true }).click()
    t.check(
      'enable reactivates utility process',
      !!(await until(async () =>
        (await win.evaluate(() => window.electronAPI.pluginsList())).find(
          (p) => p.id === 'clave.hello' && p.status === 'active'
        )
      ))
    )

    // Developer loop proves schema failures surface and no implicit permission grants.
    const linked = path.join(root, 'linked')
    mkdirSync(linked)
    const manifest = {
      id: 'test.bridge',
      name: 'Bridge fixture',
      version: '1.0.0',
      kind: 'plugin',
      engines: { clave: '*' },
      ui: 'none',
      main: 'main.mjs',
      permissions: ['secrets'],
      contributes: {
        commands: [
          { id: 'probe', title: 'Permission probe' },
          { id: 'secret', title: 'Secret probe' }
        ]
      }
    }
    writeFileSync(path.join(linked, 'clave-plugin.json'), JSON.stringify(manifest))
    writeFileSync(
      path.join(linked, 'main.mjs'),
      `export default { async activate(api) { await api.ui.registerCommand('probe', async () => { try { await api.sessions.send(${JSON.stringify(targetId)}, ${JSON.stringify(marker)}); await api.notify({title:'PERMISSION BYPASS'}) } catch (error) { await api.notify({title:'Bridge error',body:JSON.stringify({code:error.code,permission:error.data?.permission})}) } }); await api.ui.registerCommand('secret', async () => { const value = await api.secrets.request({title: 'Fixture secret'}); await api.notify({title: value === 'fixture-only-secret' ? 'Secret received' : 'Secret missing'}) }) } }`
    )
    await stubFolderDialog(app, { returns: linked })
    await win.getByRole('button', { name: 'Link folder…', exact: true }).click()
    t.check(
      'link folder discovers plugin',
      await until(
        async () => (await win.getByRole('switch', { name: 'Enable Bridge fixture' }).count()) === 1
      )
    )
    t.equal(
      'linked plugin is disabled until reviewed',
      await win.getByRole('switch', { name: 'Enable Bridge fixture' }).getAttribute('aria-checked'),
      'false'
    )
    await win.getByRole('switch', { name: 'Enable Bridge fixture' }).click()
    t.check(
      'enable review explains host API permissions and process isolation',
      await win
        .getByText(
          'Host API permissions: secrets. The plugin runs as a separate process with a trimmed environment. These permissions govern Clave host APIs, not OS access.',
          { exact: true }
        )
        .isVisible()
    )
    await win.getByRole('button', { name: 'Enable plugin', exact: true }).click()
    await win.evaluate((id) => {
      window.__pluginProbeOutput = ''
      window.__stopPluginProbe = window.electronAPI.onSessionData(id, (data) => {
        window.__pluginProbeOutput += data
      })
    }, targetId)
    await win.getByRole('button', { name: 'Run Permission probe' }).click()
    const denial = await until(
      async () =>
        (await win.evaluate(() => window.electronAPI.pluginsList())).find(
          (p) => p.id === 'test.bridge'
        )?.lastNotification
    )
    // A subsequent shell round-trip drains any earlier plugin input before checking.
    // Ctrl-U clears unsubmitted text; an illicit write still appears in captured output.
    await win.evaluate(
      (id) => window.electronAPI.writeSession(id, "\u0015printf 'PLUGIN_PROBE_%s\\n' DRAINED\r"),
      targetId
    )
    const drained = await until(async () => {
      const text = await terminalText()
      return text.includes('PLUGIN_PROBE_DRAINED') ? text : null
    })
    const received = await win.evaluate(() => {
      window.__stopPluginProbe()
      return window.__pluginProbeOutput
    })
    const refusal = denial?.body ? JSON.parse(denial.body) : null
    t.check(
      'real utility bridge rejects missing sessions.write',
      denial?.title === 'Bridge error' &&
        refusal?.code === -32001 &&
        refusal?.permission === 'sessions.write' &&
        !!drained &&
        !drained.includes(marker) &&
        !received.includes(marker),
      { denial, terminal: drained, received }
    )
    await win.getByRole('button', { name: 'Run Secret probe', exact: true }).click()
    await win.getByLabel('Fixture secret', { exact: true }).fill('fixture-only-secret')
    await win.getByRole('button', { name: 'Share with plugin', exact: true }).click()
    t.check(
      'a command can request a secret without blocking its prompt',
      await until(
        async () => (await win.getByText('Secret received', { exact: true }).count()) === 1
      )
    )
    t.check(
      'secret value is not written into installed state',
      !readFileSync(path.join(dir, 'clave-plugins', 'installed.json'), 'utf8').includes(
        'fixture-only-secret'
      )
    )

    const crashedPid = await app.evaluate(({ app }) => {
      const plugin = app.getAppMetrics().find((entry) => entry.name === 'Clave plugin: test.bridge')
      if (!plugin) throw new Error('Missing fixture utility process')
      process.kill(plugin.pid, 'SIGKILL')
      return plugin.pid
    })
    t.check(
      'utility crash is reported to Settings',
      await until(
        async () => (await win.getByText(/Plugin exited.*restarting with backoff/).count()) === 1,
        { tries: 20, gapMs: 50 }
      )
    )
    t.check(
      'crashed utility restarts with a new process',
      await until(async () =>
        app.evaluate(
          ({ app }, previous) =>
            app
              .getAppMetrics()
              .some(
                (entry) => entry.name === 'Clave plugin: test.bridge' && entry.pid !== previous
              ),
          crashedPid
        )
      )
    )
    writeFileSync(
      path.join(linked, 'main.mjs'),
      `export default { async activate(api) { await api.ui.registerCommand('probe', async () => { await api.notify({title:'Hot reload works'}) }) } }`
    )
    t.check(
      'linked change reactivates runtime',
      await until(async () =>
        (await win.evaluate(() => window.electronAPI.pluginsList())).find(
          (p) => p.id === 'test.bridge' && p.status === 'active' && !p.lastNotification
        )
      )
    )
    await win.getByRole('button', { name: 'Run Permission probe' }).click()
    t.check(
      'reloaded command uses new code',
      await until(
        async () => (await win.getByText('Hot reload works', { exact: true }).count()) === 1
      )
    )
    writeFileSync(
      path.join(linked, 'clave-plugin.json'),
      JSON.stringify({ ...manifest, engines: { clave: '>=999.0.0' } })
    )
    t.check(
      'engine refusal surfaces in Settings',
      await until(
        async () => (await win.getByText(/Requires Clave >=999\.0\.0; running /).count()) === 1
      )
    )
    await win.getByRole('button', { name: 'Remove Bridge fixture', exact: true }).click()
    t.check(
      'remove unlinks without deleting source',
      readFileSync(path.join(linked, 'main.mjs'), 'utf8').includes('Hot reload works')
    )
  } finally {
    try {
      if (targetId) await win.evaluate((id) => window.electronAPI.killSession(id), targetId)
    } finally {
      await app.close()
    }
    rmSync(root, { recursive: true, force: true })
  }
}
