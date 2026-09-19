import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO, launchApp, seedWorkspaces, stubFolderDialog, until } from './harness.mjs'

export async function run(t) {
  const root = mkdtempSync(join(REPO, '.provider-profiles-e2e-'))
  const userData = join(root, 'profile')
  const folder = join(root, 'plugin')
  const recorded = join(root, 'argv.json')
  mkdirSync(folder)
  writeFileSync(
    join(folder, 'clave-plugin.json'),
    JSON.stringify({
      apiVersion: 1,
      id: 'fixture.profiles',
      name: 'Profiles fixture',
      version: '1.0.0',
      provider: {
        id: 'fixture.profiles-provider',
        name: 'Profiles provider',
        entry: 'provider.cjs',
        command: ['/bin/echo', 'registry-default'],
        capabilities: { permissions: false, questions: false, resume: true }
      },
      views: []
    })
  )
  writeFileSync(
    join(folder, 'provider.cjs'),
    `
exports.createAdapter = (launch, emit) => ({
  capabilities: { permissions: false, questions: false, resume: true },
  async start() {},
  async send() {
    const argv = [...launch.command.slice(1), ...launch.additionalArgs];
    const output = require('node:child_process').execFileSync(launch.command[0], argv, {encoding:'utf8'});
    require('node:fs').writeFileSync(${JSON.stringify(recorded)}, JSON.stringify({argv, output}));
    emit({type:'message',message:{kind:'message',id:'argv',role:'assistant',text:output}});
    emit({type:'turn-end',outcome:'completed'});
  },
  async respond() {}, async interrupt() {}, async dispose() {}
})`
  )
  seedWorkspaces(userData, {
    workspaces: [
      { id: 'profiles-test', name: 'Profiles', rootDir: root, profileFile: null, createdAt: 1 }
    ],
    activeWorkspaceId: 'profiles-test'
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
    await win.evaluate(() => window.electronAPI.runtimePlugins.install())
    await win.reload()
    await win.waitForLoadState('domcontentloaded')
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('menu:open-settings-section', 'agents')
    })
    await win.waitForSelector('[data-settings-page="agents"]')
    const headings = await win.locator('.settings-section-title').allTextContents()
    assert(headings.includes('OpenCode'))
    assert(headings.includes('Profiles provider'))
    t.check('Agents settings lists OpenCode and the installed provider', true)
    for (const label of ['OpenCode', 'Profiles provider']) {
      const section = win.locator('section').filter({
        has: win.locator('.settings-section-title', { hasText: new RegExp(`^${label}$`) })
      })
      await section.getByRole('button', { name: 'Add profile', exact: true }).click()
      const editor = section.locator('.settings-card').last()
      await editor
        .getByRole('textbox', { name: 'Profile name', exact: true })
        .fill(`${label} custom`)
      await editor.getByRole('textbox', { name: 'Command token 1', exact: true }).fill('/bin/echo')
      if (label === 'Profiles provider') {
        await editor
          .getByRole('textbox', { name: 'Command token 2', exact: true })
          .fill('selected-profile')
      }
      const argsRow = editor.locator('.settings-row').filter({ hasText: 'Additional arguments' })
      await argsRow.getByRole('button', { name: 'Add token', exact: true }).click()
      await editor
        .getByRole('textbox', { name: 'Additional arguments token 1', exact: true })
        .fill('space in one argument')
      await editor.getByRole('button', { name: 'Save profile', exact: true }).click()
      await section
        .getByRole('button', { name: 'Save profile', exact: true })
        .waitFor({ state: 'detached' })
    }
    const preferences = await win.evaluate(() => window.electronAPI.launchProfilesList())
    const custom = preferences.customProfiles.find(
      (profile) => profile.name === 'Profiles provider custom'
    )
    assert(custom)
    assert(preferences.customProfiles.some((profile) => profile.family === 'opencode'))
    assert(
      !JSON.parse(readFileSync(join(userData, 'agent-launch-profiles.json'), 'utf8'))
        .defaultProfiles
    )
    t.check(
      'custom profiles save through UI and derived defaults stay out of the preferences file',
      true
    )
    const section = win.locator('section').filter({
      has: win.locator('.settings-section-title', { hasText: /^Profiles provider$/ })
    })
    await section.locator('[data-settings-select="workspace-fixture.profiles-provider"]').click()
    await win.getByRole('menuitem', { name: 'Profiles provider custom', exact: true }).click()
    await win.getByRole('button', { name: 'Back to sessions', exact: true }).click()
    await win.click('.launcher-caret')
    await win.getByRole('menuitem', { name: 'Profiles provider', exact: true }).hover()
    await win.getByRole('menuitem', { name: 'Profiles provider custom', exact: true }).click()
    const session = await until(async () =>
      (await win.evaluate(() => window.electronAPI.conversations.list())).find(
        (item) => item.provider === 'fixture.profiles-provider'
      )
    )
    assert.equal(session.launchProfileId, custom.id)
    await win.evaluate(
      (id) => window.electronAPI.conversations.send(id, 'record argv', 'record'),
      session.id
    )
    await until(() => existsSync(recorded))
    assert.deepEqual(JSON.parse(readFileSync(recorded, 'utf8')), {
      argv: ['selected-profile', 'space in one argument'],
      output: 'selected-profile space in one argument\n'
    })
    t.check(
      'launcher profile selection reaches the real daemon, plugin adapter, and executable',
      true
    )
    await win.evaluate((id) => window.electronAPI.conversations.close(id), session.id)
  } finally {
    if (app) await app.close()
    const owner = join(userData, 'conversation-service/owner.json')
    if (existsSync(owner)) {
      const { pid } = JSON.parse(readFileSync(owner, 'utf8'))
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        /* already exited */
      }
    }
    rmSync(root, { recursive: true, force: true })
  }
}
