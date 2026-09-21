import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'
import { REPO, seedWorkspaces, seedTrustedRoots, until } from './harness.mjs'

/**
 * The bundled `plugins/echo-provider` drives a real session end to end: the
 * launcher offers it only once enabled, its answers reach the chat view, the
 * events it is not allowed to send are dropped, and a second plugin sees the
 * session it created through the host's `sessions` service.
 *
 * Whether a bundled plugin starts enabled is the host's rule, not this lane's
 * (`BUNDLED_ON_FIRST_INSTALL` in `plugin-store.ts`, owned by PRDCT-2611), so
 * this spec puts the plugin into the disabled state it is entitled to expect and
 * then walks the Settings review a user walks. What it asserts is its own
 * contract: a disabled adapter plugin is not in the launcher, and enabling it
 * puts it there with the command its manifest declares.
 *
 * Every check asserts. The mutations run to prove they can fail are in the PR.
 */
const PLUGIN_ID = 'clave.echo-provider'
const ADAPTER_ID = 'echo-provider'

async function open(dir) {
  const root = `${dir}-root`
  mkdirSync(root, { recursive: true })
  seedWorkspaces(dir, {
    workspaces: [{ id: 'pp', name: 'Providers', rootDir: root, profileFile: null, createdAt: 1 }],
    activeWorkspaceId: 'pp',
    fresh: true
  })
  seedTrustedRoots(dir, [root])
  const app = await electron.launch({
    executablePath: path.join(
      REPO,
      'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
    ),
    args: ['.', `--user-data-dir=${dir}`, '--test-no-activate'],
    cwd: REPO,
    env: { ...process.env }
  })
  // Record the raw stream before any session exists: what the plugin emits is
  // only assertable here, ahead of whatever the view chooses to render.
  await app.evaluate(({ BrowserWindow }) => {
    globalThis.__providerStream = []
    const contents = BrowserWindow.getAllWindows()[0].webContents
    const send = contents.send.bind(contents)
    contents.send = (channel, ...args) => {
      if (channel.startsWith('sessions:stream:')) globalThis.__providerStream.push(args[0])
      return send(channel, ...args)
    }
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  return { app, win, root }
}

const profileIds = (win) =>
  win.evaluate(async () =>
    (await window.electronAPI.launchProfilesList()).customProfiles.map((profile) => profile.id)
  )

const streamEvents = (app) =>
  app.evaluate(() =>
    globalThis.__providerStream
      .filter((entry) => entry && entry.kind === 'event')
      .map((entry) => entry.event)
  )

/** The conversation view's own container. A session can have SEVERAL views
 *  mounted at once since PRDCT-2610 — the one on screen and the ones kept alive
 *  behind it — so a conversation's text is in the document more than once, and a
 *  window-wide text query resolves to every copy. Scope to the view under test,
 *  the way this spec already does for the composer. */
const chatView = (win) => win.locator('[data-testid="chat-view"]')

export async function run(t) {
  // Per run, not shared: a fixed path here collided with another lane's suite and
  // cost the verifier a red round on a check that passes alone.
  const dir = `/tmp/clave-e2e-plugin-provider-${process.pid}`
  const { app, win, root } = await open(dir)
  try {
    await win.click('.sidebar-footer-btn[aria-label="Settings"]')
    await win.click('[data-settings-nav-row="plugins"]')
    const pluginRecord = async () =>
      (await win.evaluate(() => window.electronAPI.pluginsList())).find((p) => p.id === PLUGIN_ID)
    assert.ok(await until(pluginRecord), 'the bundled example was discovered')
    const toggle = win.getByRole('switch', { name: 'Enable Echo provider', exact: true })
    await toggle.waitFor()
    // Asserted, never normalised: a fresh profile must SHIP it disabled, with
    // nothing granted. Repairing the state here would make the check below true
    // by construction while the shipped default was the opposite.
    const fresh = await pluginRecord()
    assert.equal(fresh.enabled, false, 'a bundled adapter plugin ships disabled')
    assert.deepEqual(fresh.permissionsGranted, [], 'and is granted nothing until asked')
    assert.equal(await toggle.getAttribute('aria-checked'), 'false')
    assert.ok(
      !(await profileIds(win)).includes(ADAPTER_ID),
      'a disabled adapter plugin is not in the launcher'
    )
    t.check('a fresh profile ships the provider plugin disabled and does not offer it', true)

    // The review a user walks: the switch, the disclosure, the confirmation.
    await toggle.click()
    // An agent from a plugin runs inside Clave, and the dialog must say so before
    // the grant. Without this the wording can be reverted and every gate stays green.
    const review = win
      .locator('.settings-callout[data-tone="danger"]')
      .filter({ hasText: 'Enable Echo provider?' })
    await review.waitFor()
    const consent = await review.innerText()
    assert.match(consent, /runs INSIDE Clave/)
    assert.match(consent, /full environment including any credentials in it/)
    assert.match(consent, /trust its author as much as you trust Clave/)
    assert.doesNotMatch(consent, /separate process with a trimmed environment/)
    await win.getByRole('button', { name: 'Enable plugin', exact: true }).click()
    assert.ok(await until(async () => (await pluginRecord()).enabled === true))
    assert.deepEqual((await pluginRecord()).permissionsGranted, ['sessions.write'])
    assert.ok(await until(async () => (await profileIds(win)).includes(ADAPTER_ID)))
    const profile = (
      await win.evaluate(() => window.electronAPI.launchProfilesList())
    ).customProfiles.find((p) => p.id === ADAPTER_ID)
    assert.deepEqual(profile.command, ['echo', '--from-manifest'])
    assert.equal(profile.name, 'Echo (plugin)')
    t.check(
      'the review names the privilege an agent plugin gets, then enabling it adds the manifest command',
      true
    )

    await win.evaluate((id) => window.electronAPI.launchProfileSetGlobal('claude', id), ADAPTER_ID)
    await win.reload()
    await win.locator('.launcher-split .launcher-btn').click()
    await win.locator('[data-testid="chat-view"] textarea:not(:disabled)').waitFor()
    const session = await until(async () =>
      (await win.evaluate(() => window.electronAPI.sessionsList())).find(
        (s) => s.adapterId === ADAPTER_ID
      )
    )
    assert.ok(session)
    assert.equal(session.transport, 'events')
    assert.equal(session.provider, ADAPTER_ID)
    const notice = (await streamEvents(app)).find((event) => event.type === 'provider_event')
    assert.deepEqual(notice, {
      type: 'provider_event',
      provider: ADAPTER_ID,
      payload: { notice: 'A local demonstration provider. No model, no network, no process.' }
    })
    t.check('the plugin adapter runs the session and announces its declared notice', true)

    const input = win.getByRole('textbox', { name: 'Message', exact: true })
    await input.fill('hello there')
    await input.press('Enter')
    await win.locator('.chat-turn[data-role="assistant"]').waitFor()
    assert.match(
      await win.locator('.chat-turn[data-role="assistant"]').first().innerText(),
      /Echo from echo --from-manifest: hello there/
    )
    const calls = (await streamEvents(app)).filter((event) => event.type === 'tool_call')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].id, `${PLUGIN_ID}:call-1`)
    t.check('the manifest command reaches the adapter; plugin ids arrive namespaced', true)

    await input.fill('!invalid')
    await input.press('Enter')
    await chatView(win).getByText('The invalid event was dropped.', { exact: true }).waitFor()
    const texts = (await streamEvents(app)).filter((event) => event.type === 'assistant_text')
    assert.ok(
      texts.every((event) => typeof event.delta === 'string' && typeof event.final === 'boolean'),
      'no malformed event crossed the boundary'
    )
    t.check('an event failing the schema is dropped and the next one still arrives', true)

    await input.fill('!permission')
    await input.press('Enter')
    const allow = win.getByRole('button', { name: 'Allow once', exact: true })
    await allow.waitFor()
    const request = (await streamEvents(app)).find((event) => event.type === 'permission_request')
    assert.equal(request.id, `${PLUGIN_ID}:ask-2`)
    await allow.click()
    // The plugin threw if the prefix had not been stripped on the way back in.
    await chatView(win).getByText('Allowed, and echoed.', { exact: true }).waitFor()
    assert.equal(
      (await streamEvents(app)).filter((e) => e.type === 'error').length,
      0,
      'the permission round trip raised no error event'
    )
    t.check('a permission answer crosses the real IPC and the prefix is stripped again', true)

    // A second plugin reads the session through the host service, which now
    // reports the registry rather than the PTY manager alone.
    const linked = path.join(root, 'reader-plugin')
    mkdirSync(linked, { recursive: true })
    writeFileSync(
      path.join(linked, 'clave-plugin.json'),
      JSON.stringify({
        id: 'test.session-reader',
        name: 'Session reader',
        version: '1.0.0',
        kind: 'plugin',
        engines: { clave: '*' },
        ui: 'none',
        main: 'main.mjs',
        permissions: ['sessions.read', 'sessions.write'],
        contributes: { commands: [{ id: 'read', title: 'Read sessions' }] }
      })
    )
    writeFileSync(
      path.join(linked, 'main.mjs'),
      `export default { async activate(api) { await api.ui.registerCommand('read', async () => {
        const sessions = await api.sessions.list()
        await api.notify({ title: 'Sessions', body: JSON.stringify(sessions) })
        await api.sessions.send(${JSON.stringify(session.id)}, 'from the reader plugin')
      }) } }`
    )
    await win.evaluate((folder) => window.electronAPI.pluginsLink(folder), linked)
    await until(async () =>
      (await win.evaluate(() => window.electronAPI.pluginsList())).find(
        (p) => p.id === 'test.session-reader'
      )
    )
    await win.evaluate(() =>
      window.electronAPI.pluginsEnable('test.session-reader', ['sessions.read', 'sessions.write'])
    )
    // The utility process registers its command on activation; wait for it.
    assert.ok(
      await until(async () =>
        (await win.evaluate(() => window.electronAPI.pluginsList()))
          .find((p) => p.id === 'test.session-reader')
          ?.commands.includes('read')
      )
    )
    await win.evaluate(() => window.electronAPI.pluginsCommand('test.session-reader', 'read'))
    const seen = await until(async () => {
      const reader = (await win.evaluate(() => window.electronAPI.pluginsList())).find(
        (p) => p.id === 'test.session-reader'
      )
      return reader?.lastNotification?.body ? JSON.parse(reader.lastNotification.body) : null
    })
    const listed = seen.find((s) => s.id === session.id)
    assert.ok(listed, 'the events session is in the host service listing')
    assert.equal(listed.alive, true)
    assert.equal(listed.folderName, path.basename(root))
    await chatView(win)
      .getByText('Echo from echo --from-manifest: from the reader plugin')
      .waitFor()
    t.check('a plugin lists the events session and its send reaches the provider', true)

    await win.evaluate((id) => window.electronAPI.pluginsDisable(id), PLUGIN_ID)
    assert.ok(await until(async () => !(await profileIds(win)).includes(ADAPTER_ID)))
    assert.ok(
      (await win.evaluate(() => window.electronAPI.sessionsList())).some(
        (s) => s.id === session.id
      ),
      'disabling the plugin left the running session alone'
    )
    // Disabling broadcasts a plugin change and the composer can remount under the
    // keystroke, dropping the draft — a view-side race, not the behaviour under
    // test here, which is that the SESSION survives. So the send is retried until
    // the user's turn appears, and only then is the answer awaited: a lost
    // keystroke reads as a lost keystroke rather than as a dead provider.
    const sent = win.locator('.chat-turn[data-role="user"]').filter({ hasText: 'still running' })
    assert.ok(
      await until(
        async () => {
          const composer = win.locator('[data-testid="chat-view"] textarea:not(:disabled)')
          await composer.waitFor()
          await composer.fill('still running')
          await composer.press('Enter')
          return (await sent.count()) > 0
        },
        { tries: 6, gapMs: 500 }
      ),
      'the composer accepted a message after the plugin was disabled'
    )
    await chatView(win).getByText('Echo from echo --from-manifest: still running').first().waitFor()
    t.check('disabling hides new launches without touching the session already running', true)
  } finally {
    await app.close()
    rmSync(dir, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
}
