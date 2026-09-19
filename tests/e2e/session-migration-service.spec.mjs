import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  REPO,
  callMcp,
  launchApp,
  seedTrustedRoots,
  seedWorkspaces,
  until,
  windowLayout
} from './harness.mjs'

// Real migration/conversation IPC, durable daemon, and CLI protocol. Only the
// native confirmation dialog is replaced. Every file and PID belongs to this run.
export async function run(t) {
  const root = mkdtempSync(join(REPO, '.migration-service-e2e-'))
  const userData = join(root, 'app')
  const cwd = join(root, 'project')
  const workspaceId = randomUUID()
  const windowKey = randomUUID()
  const legacyId = randomUUID()
  const resumeId = randomUUID()
  const groupId = randomUUID()
  const profileId = 'migration-fixture'
  const marker = '--migration-selected-profile'
  const recordFile = join(userData, 'session-records', `${legacyId}.json`)
  const fixtureFile = join(cwd, 'fixture-state.json')
  const ownerFile = join(userData, 'conversation-service', 'owner.json')
  const view = {
    url: 'http://127.0.0.1:45999',
    title: 'Preserved migration dashboard',
    command: 'echo migration-view-must-not-start',
    cwd
  }
  const json = (file) => JSON.parse(readFileSync(file, 'utf8'))
  const writeJson = (file, value) => {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(value, null, 2))
  }
  const alive = (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      if (error.code === 'ESRCH') return false
      throw error
    }
  }
  const eventually = async (check, message) => {
    assert.ok(await until(check, { tries: 100, gapMs: 100 }), message)
  }
  mkdirSync(cwd)
  seedWorkspaces(userData, {
    workspaces: [
      { id: workspaceId, name: 'Migration service fixture', rootDir: cwd, createdAt: 1 }
    ],
    activeWorkspaceId: workspaceId
  })
  seedTrustedRoots(userData, [cwd])
  writeJson(join(userData, 'windows.json'), {
    version: 1,
    windows: [{ key: windowKey, workspaceId }]
  })
  writeJson(recordFile, {
    id: legacyId,
    cwd,
    folderName: 'project',
    displayName: 'Legacy migration service fixture',
    userRenamed: true,
    claudeMode: true,
    codexMode: false,
    antigravityMode: false,
    piMode: false,
    claudeAgentsMode: false,
    dangerousMode: false,
    claudeSessionId: resumeId,
    launchProfileId: 'removed-legacy-profile',
    workspaceId,
    windowKey,
    view
  })
  const group = {
    id: groupId,
    name: 'Preserved migration group',
    sessionIds: [legacyId],
    collapsed: false,
    cwd,
    workspaceId,
    color: 'blue',
    terminals: []
  }
  writeJson(join(userData, 'sidebar-layouts', 'windows', `${windowKey}.json`), {
    groups: [group],
    displayOrder: [groupId]
  })
  writeJson(join(userData, 'agent-launch-profiles.json'), {
    version: 1,
    customProfiles: [
      {
        id: profileId,
        name: 'Migration fixture CLI',
        family: 'claude',
        command: [process.execPath, join(REPO, 'tests/e2e/fixtures/conversation-claude.mjs')],
        additionalArgs: [marker]
      }
    ],
    globalDefaults: { claude: profileId },
    workspaceOverrides: {}
  })

  let app
  let win
  let conversationId
  let daemonPid
  try {
    ;({ app, win } = await launchApp(userData))
    const panel = win.getByTestId('legacy-agent-migration')
    await panel.waitFor()
    assert.equal(await win.locator('.xterm').count(), 0, 'Boot must not attach a terminal')
    assert.deepEqual(
      await win.evaluate(() => window.electronAPI.listSessions()),
      [],
      'Boot must not create a PTY'
    )
    assert.equal(existsSync(fixtureFile), false, 'Boot must not launch the CLI')
    assert.deepEqual(await win.evaluate(() => window.electronAPI.conversations.list()), [])
    const inspected = await win.evaluate(
      (id) => window.electronAPI.sessionMigration.inspect(id),
      legacyId
    )
    assert.equal(inspected.resumeSessionId, resumeId)
    assert.equal(inspected.live, false)
    assert.equal(inspected.launchProfileId, 'removed-legacy-profile')
    daemonPid = json(ownerFile).pid
    assert.ok(Number.isInteger(daemonPid) && daemonPid > 1)
    assert.notEqual(daemonPid, process.pid)

    // A missing saved profile requires an explicit selection, even if a valid
    // global default exists. The selected command is proven by its actual argv.
    const move = panel.getByRole('button', { name: 'Move to conversation', exact: true })
    assert.equal(await move.isDisabled(), true)
    await panel.getByRole('button', { name: 'Migration launch profile' }).click()
    await win.getByRole('menuitem', { name: /Migration fixture CLI/ }).click()
    await app.evaluate(({ dialog }) => {
      globalThis.__migrationConfirmation = { accept: false, calls: [] }
      dialog.showMessageBox = async (...args) => {
        const options = args.at(-1)
        const state = globalThis.__migrationConfirmation
        if (!Number.isInteger(options.cancelId) || options.buttons?.length !== 2)
          throw new Error('Expected an explicit two-button migration confirmation')
        state.calls.push({
          message: options.message,
          detail: options.detail,
          buttons: options.buttons
        })
        return {
          response: state.accept ? 1 - options.cancelId : options.cancelId,
          checkboxChecked: false
        }
      }
    })
    await move.click()
    await eventually(
      () => app.evaluate(() => globalThis.__migrationConfirmation.calls.length === 1),
      'Migration did not request native confirmation'
    )
    await eventually(() => move.isEnabled(), 'Cancelled migration did not settle')
    assert.equal(await panel.isVisible(), true)
    assert.equal(existsSync(recordFile), true, 'Cancellation must keep the source record')
    assert.deepEqual(await win.evaluate(() => window.electronAPI.sessionMigration.mappings()), {})
    assert.deepEqual(await win.evaluate(() => window.electronAPI.conversations.list()), [])
    assert.equal(existsSync(fixtureFile), false)
    assert.deepEqual(windowLayout(userData, windowKey).groups[0].sessionIds, [legacyId])
    t.check('boot is metadata-only; native cancellation preserves source and group', true)

    await app.evaluate(() => {
      globalThis.__migrationConfirmation.accept = true
    })
    await move.click()
    await panel.waitFor({ state: 'detached' })
    await win.getByTestId('conversation-panel').waitFor()
    const mappings = await win.evaluate(() => window.electronAPI.sessionMigration.mappings())
    conversationId = mappings[legacyId]
    assert.match(conversationId, /^conversation-/)
    assert.equal(existsSync(recordFile), false, 'Accepted migration must remove the legacy record')
    assert.equal(await app.evaluate(() => globalThis.__migrationConfirmation.calls.length), 2)
    const snapshot = await win.evaluate(
      (id) => window.electronAPI.conversations.snapshot(id),
      conversationId
    )
    assert.equal(snapshot.session.legacyImport.sourceId, legacyId)
    assert.equal(snapshot.session.legacyImport.complete, true)
    assert.equal(snapshot.session.launchProfileId, profileId)
    assert.equal(snapshot.session.resumeSessionId, resumeId)
    assert.deepEqual(snapshot.session.view, view)
    assert.deepEqual(snapshot.entries, [], 'Migration must not synthesize or replay old prompts')
    await eventually(
      () =>
        windowLayout(userData, windowKey)
          ?.groups.find((item) => item.id === groupId)
          ?.sessionIds.join() === conversationId,
      'Migration did not persist the group remap'
    )
    const layout = windowLayout(userData, windowKey)
    assert.deepEqual(layout.displayOrder, [groupId])
    const migratedGroup = layout.groups.find((item) => item.id === groupId)
    for (const key of ['name', 'cwd', 'workspaceId', 'color', 'collapsed'])
      assert.equal(migratedGroup[key], group[key], `Migration changed group ${key}`)
    assert.deepEqual(migratedGroup.sessionIds, [conversationId])
    assert.equal(existsSync(fixtureFile), false, 'Migration must wait for the first prompt')
    assert.deepEqual(await win.evaluate(() => window.electronAPI.listSessions()), [])
    t.check(
      'real migration commits one conversation, preserves view, and remaps the group without spawning',
      true
    )

    await win.getByRole('textbox', { name: 'Message', exact: true }).fill('migration first prompt')
    await win.getByRole('button', { name: 'Send', exact: true }).click()
    await win.getByText('Fixture reply:', { exact: true }).waitFor()
    await eventually(
      () => existsSync(fixtureFile) && json(fixtureFile).turns === 1,
      'First prompt did not reach the selected CLI'
    )
    const fixture = json(fixtureFile)
    assert.equal(fixture.claveId, conversationId)
    assert.equal(fixture.sessionId, resumeId)
    assert.ok(fixture.args.includes(marker), 'Selected profile arguments must reach the real CLI')
    assert.equal(fixture.args[fixture.args.indexOf('--resume') + 1], resumeId)
    assert.ok(fixture.args.includes('--resume'))
    assert.ok(fixture.args.includes('--output-format'))
    assert.ok(fixture.args.includes('stream-json'))
    const beforeReload = await win.evaluate(
      (id) => window.electronAPI.conversations.snapshot(id),
      conversationId
    )
    await win.reload()
    await win.getByTestId('conversation-panel').waitFor()
    await win.getByText('Fixture reply:', { exact: true }).waitFor()
    assert.deepEqual(
      await win.evaluate(() => window.electronAPI.sessionMigration.mappings()),
      mappings
    )
    const sessions = await win.evaluate(() => window.electronAPI.conversations.list())
    assert.deepEqual(
      sessions.map((session) => session.id),
      [conversationId]
    )
    const renderer = await callMcp(app, 'list', {})
    assert.deepEqual(
      renderer.sessions.map((session) => session.id),
      [conversationId]
    )
    assert.deepEqual(renderer.sessions[0].view, { url: view.url, title: view.title })
    assert.deepEqual(renderer.groups.find((item) => item.id === groupId).sessionIds, [
      conversationId
    ])
    const afterReload = await win.evaluate(
      (id) => window.electronAPI.conversations.snapshot(id),
      conversationId
    )
    assert.deepEqual(afterReload.session.view, view)
    assert.deepEqual(
      afterReload.entries,
      beforeReload.entries,
      'Reload must not replay transcript entries'
    )
    assert.equal(json(fixtureFile).pid, fixture.pid, 'Reload must attach without respawning')
    assert.equal(json(fixtureFile).turns, 1, 'Reload must not resend the prompt')
    assert.equal(await win.locator('.xterm').count(), 0)
    assert.equal(await win.getByTestId('legacy-agent-migration').count(), 0)
    assert.equal(existsSync(recordFile), false)
    t.check(
      'selected CLI resumes the native UUID; reload keeps one mapped tab with no replay',
      true
    )
  } finally {
    try {
      if (app) {
        if (conversationId)
          await win
            .evaluate((id) => window.electronAPI.conversations.close(id), conversationId)
            .catch(() => {})
        await app.close()
      }
    } finally {
      // Never match process names or touch the user's daemon. This fresh profile's
      // owner file is the sole authority for the exact detached PID we may stop.
      if (!daemonPid && existsSync(ownerFile)) daemonPid = json(ownerFile).pid
      if (Number.isInteger(daemonPid) && daemonPid > 1 && daemonPid !== process.pid) {
        if (alive(daemonPid)) process.kill(daemonPid, 'SIGTERM')
        await eventually(() => !alive(daemonPid), 'Test-owned daemon did not stop')
      }
      rmSync(root, { recursive: true, force: true })
    }
  }
}
