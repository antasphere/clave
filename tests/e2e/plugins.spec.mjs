import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  existsSync
} from 'node:fs'
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
    // hello is the bundled DEMO: it ships disabled, because a demonstration has no
    // business contributing to the app's chrome until the user asks for it. Enabling it
    // goes through the same review the user sees for any other plugin.
    const dormant = await until(async () =>
      (await win.evaluate(() => window.electronAPI.pluginsList())).find(
        (p) => p.id === 'clave.hello'
      )
    )
    t.check(
      'the bundled demo ships disabled, with no permission granted',
      dormant?.enabled === false &&
        dormant?.status === 'disabled' &&
        dormant?.permissionsGranted.length === 0,
      dormant
    )
    await win.getByRole('switch', { name: 'Enable Hello Clave', exact: true }).click()
    await win.getByRole('button', { name: 'Enable plugin', exact: true }).click()
    const hello = await until(async () =>
      (await win.evaluate(() => window.electronAPI.pluginsList())).find(
        (p) => p.id === 'clave.hello' && p.status === 'active'
      )
    )
    t.check('bundled hello activates once enabled', !!hello, hello)
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
    t.equal(
      'deliberately disabled plugin has no review suffix',
      await win.getByText(/Needs review before enabling/).count(),
      0
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
      'enable review explains host API permissions and file access',
      await win
        .getByText(
          'Host API permissions: secrets. The plugin runs as a separate process with a trimmed environment. It can read and write your files. These permissions govern Clave host APIs, not OS access.',
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
    manifest.version = '2.0.0'
    writeFileSync(path.join(linked, 'clave-plugin.json'), JSON.stringify(manifest))
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
      JSON.stringify(manifest).replace(/}$/, ',}')
    )
    t.check(
      'transient malformed manifest becomes an error',
      await until(async () =>
        (await win.evaluate(() => window.electronAPI.pluginsList())).some(
          (p) => p.id === 'test.bridge' && p.status === 'error'
        )
      )
    )
    t.equal(
      'broken plugin toggle is off',
      await win
        .getByRole('switch', { name: 'Enable test.bridge', exact: true })
        .getAttribute('aria-checked'),
      'false'
    )
    t.check(
      'parse error retains persisted consent',
      JSON.parse(readFileSync(path.join(dir, 'clave-plugins', 'installed.json'), 'utf8')).some(
        (p) => p.id === 'test.bridge' && p.enabled && p.permissionsGranted.includes('secrets')
      )
    )
    writeFileSync(path.join(linked, 'clave-plugin.json'), JSON.stringify(manifest))
    t.check(
      'repair resumes linked plugin without re-consent',
      await until(async () =>
        (await win.evaluate(() => window.electronAPI.pluginsList())).some(
          (p) => p.id === 'test.bridge' && p.status === 'active'
        )
      )
    )
    writeFileSync(
      path.join(linked, 'clave-plugin.json'),
      JSON.stringify({ ...manifest, permissions: ['secrets', 'shell'] })
    )
    t.check(
      'permission growth disables the linked runtime and clears grants',
      await until(async () =>
        (await win.evaluate(() => window.electronAPI.pluginsList())).some(
          (p) =>
            p.id === 'test.bridge' &&
            !p.enabled &&
            p.status === 'disabled' &&
            p.permissionsGranted.length === 0 &&
            p.needsReview === 'permission-growth'
        )
      )
    )
    t.check(
      'permission growth shows the review suffix',
      await until(async () => (await win.getByText(/Needs review before enabling/).count()) === 1)
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
  await closedSwapChecks(t)
}

async function closedSwapChecks(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'clave-lane2-swaps-'))
  const dir = path.join(root, 'profile')
  const tmuxDir = path.join(root, 'tmux')
  mkdirSync(tmuxDir)
  seedWorkspaces(dir, { workspaces: [], activeWorkspaceId: null })
  const fixtures = ['module', 'link'].map((kind) => {
    const directory = path.join(dir, 'clave-plugins', 'plugins', kind)
    const marker = path.join(root, `${kind}-executed`)
    const manifest = {
      id: `test.${kind}`,
      name: `Swap ${kind}`,
      version: '1.0.0',
      kind: 'plugin',
      engines: { clave: '*' },
      ui: 'none',
      main: 'main.mjs',
      permissions: []
    }
    mkdirSync(directory, { recursive: true })
    writeFileSync(path.join(directory, 'clave-plugin.json'), JSON.stringify(manifest))
    writeFileSync(path.join(directory, 'main.mjs'), "export { default } from './helper.mjs'")
    const code = (label) =>
      `import { writeFileSync } from 'node:fs'; export default { activate() { writeFileSync(${JSON.stringify(marker)}, ${JSON.stringify(label)}) } }`
    writeFileSync(path.join(directory, 'helper.mjs'), code('original'))
    return { kind, directory, marker, manifest, code }
  })
  let app
  try {
    let launched = await launchApp(dir, { env: { TMUX_TMPDIR: tmuxDir } })
    app = launched.app
    for (const f of fixtures) {
      await launched.win.evaluate((id) => window.electronAPI.pluginsEnable(id, []), f.manifest.id)
      t.check(
        `${f.kind} original executes before closed swap`,
        await until(() => existsSync(f.marker))
      )
    }
    await app.close()
    app = null
    for (const f of fixtures) {
      rmSync(f.marker, { force: true })
      if (f.kind === 'module') {
        writeFileSync(path.join(f.directory, 'helper.mjs'), f.code('replacement'))
      } else {
        rmSync(f.directory, { recursive: true })
        const replacement = path.join(root, 'replacement')
        mkdirSync(replacement)
        writeFileSync(path.join(replacement, 'clave-plugin.json'), JSON.stringify(f.manifest))
        writeFileSync(path.join(replacement, 'main.mjs'), "export { default } from './helper.mjs'")
        writeFileSync(path.join(replacement, 'helper.mjs'), f.code('replacement'))
        symlinkSync(replacement, f.directory)
      }
    }
    launched = await launchApp(dir, { env: { TMUX_TMPDIR: tmuxDir } })
    app = launched.app
    const win = launched.win
    await win.click('.sidebar-footer-btn[aria-label="Settings"]')
    await win.click('[data-settings-nav-row="plugins"]')
    const records = await win.evaluate(() => window.electronAPI.pluginsList())
    for (const f of fixtures) {
      const record = records.find((p) => p.id === f.manifest.id)
      t.check(
        `${f.kind} closed swap requires review`,
        record &&
          !record.enabled &&
          record.status === 'disabled' &&
          record.needsReview === (f.kind === 'link' ? 'source-change' : 'digest-change'),
        record
      )
      t.equal(`${f.kind} replacement never executes`, existsSync(f.marker), false)
      t.equal(
        `${f.kind} swapped toggle is off`,
        await win
          .getByRole('switch', { name: `Enable Swap ${f.kind}`, exact: true })
          .getAttribute('aria-checked'),
        'false'
      )
    }
    t.equal(
      'both closed swaps show review suffix',
      await win.getByText(/Needs review before enabling/).count(),
      2
    )
  } finally {
    if (app) await app.close()
    rmSync(root, { recursive: true, force: true })
  }
}
