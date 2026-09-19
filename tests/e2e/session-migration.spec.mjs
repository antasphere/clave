import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { launchApp, REPO, until } from './harness.mjs'

// Real Electron/preload/renderer, with fixtures at the main IPC boundary.
// Backend transaction tests own native dialogs and provider resume execution.
export async function run(t) {
  const dir = mkdtempSync(path.join(REPO, '.migration-e2e-'))
  let app
  try {
    const launched = await launchApp(dir)
    app = launched.app
    const win = launched.win
    await app.evaluate(({ ipcMain }) => {
      const handlers = ipcMain._invokeHandlers
      if (!handlers?.get('records:list-adoptable')) throw new Error('Missing record IPC handler')
      const record = {
        id: 'legacy-migration-fixture',
        cwd: '/tmp',
        folderName: 'migration fixture',
        displayName: 'Migration fixture',
        claudeMode: true,
        codexMode: false,
        antigravityMode: false,
        dangerousMode: false,
        live: false,
        claudeSessionId: 'saved-native-resume',
        launchProfileId: 'missing-profile'
      }
      const snapshot = {
        session: {
          id: 'conversation-migration-fixture',
          provider: 'claude',
          cwd: '/tmp',
          title: 'Migration fixture',
          status: 'idle',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          capabilities: { permissions: true, questions: true, resume: true },
          providerSessionId: record.claudeSessionId,
          legacyImport: { sourceId: record.id, recordKey: record.id, complete: true }
        },
        sequence: 0,
        entries: [],
        requests: []
      }
      globalThis.__migrationFixture = {
        migrated: false,
        cancel: true,
        calls: [],
        pty: [],
        layout: null
      }
      const state = globalThis.__migrationFixture
      handlers.set('records:list-adoptable', async () => (state.migrated ? [] : [record]))
      handlers.set('sidebar-layout:load', async () => ({
        groups: [
          {
            id: 'migration-group',
            name: 'Migration group',
            sessionIds: [record.id],
            collapsed: false,
            cwd: '/tmp',
            terminals: [],
            color: 'blue'
          }
        ],
        displayOrder: ['migration-group']
      }))
      const save = handlers.get('sidebar-layout:save')
      handlers.set('sidebar-layout:save', async (event, layout) => {
        state.layout = layout
        return save(event, layout)
      })
      handlers.set('launch-profiles:list', async () => ({
        version: 1,
        customProfiles: [
          {
            id: 'fixture-profile',
            name: 'Fixture CLI',
            family: 'claude',
            command: ['/usr/bin/false'],
            args: []
          }
        ],
        globalDefaults: {},
        workspaceOverrides: {}
      }))
      handlers.set('session-migration:inspect', async () => ({
        id: record.id,
        provider: 'claude',
        cwd: record.cwd,
        title: record.displayName,
        live: false,
        launchProfileId: record.launchProfileId,
        resumeSessionId: record.claudeSessionId
      }))
      handlers.set('session-migration:mappings', async () =>
        state.migrated ? { [record.id]: snapshot.session.id } : {}
      )
      handlers.set('session-migration:migrate', async (_event, id, profileId) => {
        state.calls.push({ id, profileId })
        if (state.cancel) return null
        state.migrated = true
        snapshot.session.launchProfileId = profileId
        return { legacyId: id, snapshot }
      })
      handlers.set('conversation:command', async (_event, command) => {
        if (command.type === 'list') return state.migrated ? [snapshot.session] : []
        if (command.type === 'snapshot') return snapshot
        throw new Error(`Unexpected conversation command: ${command.type}`)
      })
      for (const channel of ['pty:start', 'pty:write', 'pty:resize']) {
        ipcMain.on(channel, (_event, id) => state.pty.push({ channel, id }))
      }
      const spawn = handlers.get('pty:spawn')
      handlers.set('pty:spawn', async (event, cwd, options) => {
        state.pty.push({ channel: 'pty:spawn', id: options?.adoptSessionId })
        return spawn(event, cwd, options)
      })
    })
    await win.reload()
    const panel = win.getByTestId('legacy-agent-migration')
    await panel.waitFor()
    await panel
      .getByText('Native context can resume using saved session', { exact: false })
      .waitFor()
    t.check(
      'saved resume ID is disclosed',
      (await panel.textContent()).includes('saved-native-resume')
    )
    const move = panel.getByRole('button', { name: 'Move to conversation', exact: true })
    t.check('missing saved profile blocks migration', await move.isDisabled())
    await panel.getByRole('button', { name: 'Migration launch profile' }).click()
    await win.getByRole('menuitem', { name: /Fixture CLI/ }).click()
    await move.click()
    await win.waitForTimeout(100)
    t.check('native cancellation keeps placeholder', await panel.isVisible())
    t.equal(
      'concrete selected command profile is sent',
      await app.evaluate(() => globalThis.__migrationFixture.calls[0]?.profileId),
      'fixture-profile'
    )
    await app.evaluate(() => {
      globalThis.__migrationFixture.cancel = false
    })
    await move.click()
    await panel.waitFor({ state: 'detached' })
    await win.getByText('Provider context may resume.', { exact: false }).waitFor()
    t.check('completed import explains empty transcript', true)
    const layout = await until(() =>
      app.evaluate(() => {
        const layout = globalThis.__migrationFixture.layout
        return layout?.groups?.some((group) =>
          group.sessionIds.includes('conversation-migration-fixture')
        )
          ? layout
          : null
      })
    )
    t.check(
      'migration preserves group slot',
      layout?.groups?.find((group) => group.id === 'migration-group')?.sessionIds?.join() ===
        'conversation-migration-fixture',
      layout
    )
    t.equal(
      'metadata agent never starts/writes/resizes a PTY',
      await app.evaluate(() => globalThis.__migrationFixture.pty.length),
      0
    )
    t.equal(
      'provider resume ID survives conversion',
      await win.evaluate(
        async () =>
          (await window.electronAPI.conversations.snapshot('conversation-migration-fixture'))
            .session.providerSessionId
      ),
      'saved-native-resume'
    )
    // Reload against an incompatible daemon with an already-migrated layout.
    // Failed discovery must not overwrite the only saved group membership.
    await app.evaluate(({ ipcMain }) => {
      const state = globalThis.__migrationFixture
      const handlers = ipcMain._invokeHandlers
      state.savedLayout = state.layout
      state.layout = null
      state.unavailable = true
      state.restartCancelled = true
      handlers.set('sidebar-layout:load', async () => state.savedLayout)
      const command = handlers.get('conversation:command')
      handlers.set('conversation:command', async (event, input) => {
        if (state.unavailable)
          throw new Error('Conversation service is incompatible. Restart the background service.')
        return command(event, input)
      })
      handlers.set('session-migration:restart-service', async () => {
        if (state.restartCancelled) return false
        state.unavailable = false
        return true
      })
    })
    await win.reload()
    await win.waitForTimeout(500)
    t.equal(
      'failed boot does not persist a partial layout',
      await app.evaluate(() => globalThis.__migrationFixture.layout),
      null
    )
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('menu:open-settings-section', 'agents')
    })
    const restartButton = win.getByRole('button', {
      name: 'Restart background service',
      exact: true
    })
    await restartButton.click()
    await restartButton.waitFor()
    t.equal(
      'cancelled restart leaves saved layout untouched',
      await app.evaluate(() => globalThis.__migrationFixture.layout),
      null
    )
    await app.evaluate(() => {
      globalThis.__migrationFixture.restartCancelled = false
    })
    await restartButton.click()
    const recovered = await until(() => app.evaluate(() => globalThis.__migrationFixture.layout))
    t.check(
      'successful refresh recovers group without reloading',
      recovered?.groups
        ?.find((group) => group.id === 'migration-group')
        ?.sessionIds?.includes('conversation-migration-fixture'),
      recovered
    )
    t.equal(
      'recovery does not spawn providers or PTYs',
      await app.evaluate(() => globalThis.__migrationFixture.pty.length),
      0
    )
  } finally {
    if (app) await app.close()
    rmSync(dir, { recursive: true, force: true })
  }
}
