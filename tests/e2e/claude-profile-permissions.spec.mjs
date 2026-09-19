import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO, launchApp, seedTrustedRoots, seedWorkspaces, until } from './harness.mjs'

// Actual profile resolution, daemon, adapter and subprocess. No live Claude calls.
export async function run(t) {
  const root = mkdtempSync(join(REPO, '.claude-profile-e2e-'))
  const userData = join(root, 'app')
  const cwd = join(root, 'project')
  const configDir = join(root, 'claude-config')
  mkdirSync(cwd)
  mkdirSync(configDir)
  writeFileSync(
    join(configDir, 'settings.json'),
    JSON.stringify({ permissions: { defaultMode: 'auto' } })
  )
  seedWorkspaces(userData, {
    workspaces: [{ id: 'auto-test', name: 'Auto profile', rootDir: cwd, createdAt: 1 }],
    activeWorkspaceId: 'auto-test'
  })
  seedTrustedRoots(userData, [cwd])
  let app
  let win
  let sessionId
  try {
    ;({ app, win } = await launchApp(userData))
    const fixture = join(REPO, 'tests/e2e/fixtures/conversation-claude.mjs')
    // The sentinel exists only in the child wrapper argv, never user credentials.
    // Setting then unsetting proves the wrapper, rather than assuming the host has a key.
    const command =
      process.platform === 'win32'
        ? [process.execPath, fixture]
        : [
            '/usr/bin/env',
            'ANTHROPIC_API_KEY=fixture-only',
            '/usr/bin/env',
            '-u',
            'ANTHROPIC_API_KEY',
            process.execPath,
            fixture
          ]
    for (const explicit of [false, true]) {
      await win.evaluate(
        async ({ command, explicit }) => {
          await window.electronAPI.launchProfileUpsert({
            id: 'auto-profile',
            name: 'Claude without API key',
            family: 'claude',
            command,
            additionalArgs: explicit ? ['--permission-mode', 'auto'] : []
          })
          await window.electronAPI.launchProfileSetWorkspace('auto-test', 'claude', 'auto-profile')
        },
        { command, explicit }
      )
      const snapshot = await win.evaluate(
        ({ cwd, configDir }) =>
          window.electronAPI.conversations.create({ provider: 'claude', cwd, configDir }),
        { cwd, configDir }
      )
      sessionId = snapshot.session.id
      assert.equal(snapshot.session.launchProfileId, 'auto-profile')
      await win.evaluate(
        (id) => window.electronAPI.conversations.send(id, 'hello', 'first'),
        sessionId
      )
      const state = await until(() => {
        const file = join(cwd, 'fixture-state.json')
        if (!existsSync(file)) return null
        const state = JSON.parse(readFileSync(file, 'utf8'))
        return state.claveId === sessionId && state.turns === 1 ? state : null
      })
      assert.ok(state, 'Selected profile did not start the fixture')
      assert.equal(state.configDir, configDir)
      if (process.platform !== 'win32') assert.equal(state.hasApiKey, false)
      const modes = state.args.flatMap((arg, index) =>
        arg === '--permission-mode'
          ? [state.args[index + 1]]
          : arg.startsWith('--permission-mode=')
            ? [arg.slice('--permission-mode='.length)]
            : []
      )
      assert.deepEqual(modes, explicit ? ['auto'] : [])
      assert.equal(state.args.includes('--dangerously-skip-permissions'), false)
      await win.evaluate((id) => window.electronAPI.conversations.close(id), sessionId)
      sessionId = undefined
      t.check(
        explicit
          ? 'explicit auto profile reaches the process without a duplicate mode or bypass'
          : 'workspace profile preserves native settings and its API-key-unsetting wrapper',
        true
      )
    }
  } finally {
    if (app) {
      if (sessionId)
        await win
          .evaluate((id) => window.electronAPI.conversations.close(id), sessionId)
          .catch(() => {})
      await app.close()
    }
    const owner = join(userData, 'conversation-service', 'owner.json')
    if (existsSync(owner)) {
      try {
        process.kill(JSON.parse(readFileSync(owner, 'utf8')).pid, 'SIGTERM')
      } catch {
        /* already exited */
      }
    }
    rmSync(root, { recursive: true, force: true })
  }
}
