import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { build } from 'esbuild'
import { REPO, callMcp, launchApp, seedTrustedRoots, seedWorkspaces, until } from './harness.mjs'

// A real protocol-2 daemon with an older built-in revision, not an IPC mock.
// Only the native restart confirmation is stubbed. Providers use a local CLI fixture.
export async function run(t) {
  const root = mkdtempSync(join(REPO, '.runtime-version-e2e-'))
  const userData = join(root, 'app')
  const cwd = join(root, 'project')
  const oldRevision = createHash('sha256').update('e2e-old-builtins').digest('hex')
  const profileId = 'runtime-version-fixture'
  const marker = '--runtime-version-selected-profile'
  const prompt = 'only the explicitly submitted post-restart prompt'
  const ownerFile = join(userData, 'conversation-service', 'owner.json')
  const fixtureFile = join(cwd, 'fixture-state.json')
  const records = join(userData, 'conversation-service', 'records')
  const json = (file) => JSON.parse(readFileSync(file, 'utf8'))
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
  let app
  let win
  let oldDaemon
  let sessionId
  let paths
  let handshake
  try {
    mkdirSync(cwd)
    seedWorkspaces(userData, {
      workspaces: [{ id: profileId, name: 'Runtime version fixture', rootDir: cwd, createdAt: 1 }],
      activeWorkspaceId: profileId
    })
    seedTrustedRoots(userData, [cwd])
    writeFileSync(
      join(userData, 'agent-launch-profiles.json'),
      JSON.stringify({
        version: 1,
        customProfiles: [
          {
            id: profileId,
            name: 'Runtime version fixture CLI',
            family: 'claude',
            command: [process.execPath, join(REPO, 'tests/e2e/fixtures/conversation-claude.mjs')],
            additionalArgs: [marker]
          }
        ],
        globalDefaults: { claude: profileId },
        workspaceOverrides: {}
      })
    )
    await build({
      absWorkingDir: REPO,
      entryPoints: ['src/main/conversations/daemon.ts', 'src/main/conversations/wire.ts'],
      outdir: root,
      outExtension: { '.js': '.cjs' },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      define: { __CLAVE_BUILTIN_REVISION__: JSON.stringify(oldRevision) }
    })
    const { servicePaths, receive, transmit } = createRequire(import.meta.url)(
      join(root, 'wire.cjs')
    )
    paths = servicePaths(userData)
    handshake = () =>
      new Promise((resolve, reject) => {
        const socket = createConnection(paths.socket)
        socket.setTimeout(3000, () => socket.destroy(new Error('Daemon handshake timed out')))
        socket.once('error', reject)
        socket.once('close', () => reject(new Error('Daemon closed before handshake')))
        socket.once('connect', () =>
          transmit(socket, {
            hello: 2,
            token: readFileSync(paths.token, 'utf8')
          })
        )
        receive(socket, (message) => {
          if (!('ready' in message)) return
          socket.destroy()
          resolve(message)
        })
      })
    oldDaemon = spawn(
      process.execPath,
      [join(root, 'daemon.cjs'), '--conversation-daemon', userData],
      {
        cwd: REPO,
        stdio: 'ignore'
      }
    )
    let spawnError
    oldDaemon.once('error', (error) => {
      spawnError = error
    })
    await eventually(async () => {
      if (spawnError) throw spawnError
      assert.equal(oldDaemon.exitCode, null, 'Old daemon exited during startup')
      return existsSync(ownerFile) && (await handshake().catch(() => false))
    }, 'Old daemon did not become ready')
    const before = await handshake()
    assert.equal(before.ready, 2)
    assert.equal(before.pid, oldDaemon.pid)
    assert.equal(before.builtinRevision, oldRevision)
    ;({ app, win } = await launchApp(userData))
    assert.deepEqual(await win.evaluate(() => window.electronAPI.conversations.list()), [])
    const failure = await win.evaluate(
      async ({ cwd, profileId }) => {
        try {
          await window.electronAPI.conversations.create({
            provider: 'claude',
            cwd,
            launchProfileId: profileId
          })
          return null
        } catch (error) {
          return String(error)
        }
      },
      { cwd, profileId }
    )
    assert.match(failure ?? '', /Restart background service/)
    assert.deepEqual(await win.evaluate(() => window.electronAPI.conversations.list()), [])
    assert.deepEqual(
      readdirSync(records),
      [],
      'Rejected create must not persist a session or message'
    )
    assert.equal(existsSync(fixtureFile), false, 'Revision rejection must precede CLI startup')
    assert.equal(json(ownerFile).pid, oldDaemon.pid, 'Create must not replace the old daemon')
    assert.equal(alive(oldDaemon.pid), true)
    t.check(
      'stale built-ins reject before persistence or provider launch, with restart guidance',
      true
    )

    await app.evaluate(({ dialog }) => {
      globalThis.__runtimeVersionConfirmation = { accept: false, calls: [] }
      dialog.showMessageBox = async (...args) => {
        const options = args.at(-1)
        if (
          options.title !== 'Restart conversation service' ||
          options.cancelId !== 0 ||
          options.buttons?.[1] !== 'Restart service'
        )
          throw new Error('Unexpected native dialog')
        const state = globalThis.__runtimeVersionConfirmation
        state.calls.push({ message: options.message, detail: options.detail })
        return { response: state.accept ? 1 : 0, checkboxChecked: false }
      }
    })
    await win.getByRole('button', { name: 'Settings', exact: true }).click()
    await win.locator('[data-settings-nav-row="agents"]').click()
    const restart = win.getByRole('button', { name: 'Restart background service', exact: true })
    await restart.click()
    await eventually(
      () => app.evaluate(() => globalThis.__runtimeVersionConfirmation.calls.length === 1),
      'Restart did not ask for native confirmation'
    )
    await restart.waitFor()
    await eventually(() => restart.isEnabled(), 'Cancelled restart did not settle')
    assert.equal(alive(oldDaemon.pid), true, 'Cancellation must leave the exact old PID alive')
    assert.deepEqual(await handshake(), before)
    assert.equal(json(ownerFile).pid, oldDaemon.pid)
    assert.deepEqual(readdirSync(records), [])
    t.check('Settings restart cancellation leaves the original daemon and records unchanged', true)

    await app.evaluate(() => {
      globalThis.__runtimeVersionConfirmation.accept = true
    })
    await restart.click()
    await eventually(
      () =>
        oldDaemon.exitCode !== null &&
        existsSync(ownerFile) &&
        json(ownerFile).pid !== oldDaemon.pid,
      'Confirmed restart did not stop the owned old daemon and start a replacement'
    )
    await restart.waitFor()
    await eventually(() => restart.isEnabled(), 'Confirmed restart did not settle')
    const current = await handshake()
    assert.equal(current.ready, 2)
    assert.equal(current.pid, json(ownerFile).pid)
    assert.notEqual(current.builtinRevision, oldRevision)
    assert.match(current.builtinRevision, /^[a-f0-9]{64}$/)
    assert.equal(await app.evaluate(() => globalThis.__runtimeVersionConfirmation.calls.length), 2)
    assert.deepEqual(await win.evaluate(() => window.electronAPI.conversations.list()), [])
    assert.equal(existsSync(fixtureFile), false, 'Restart alone must not launch any provider')
    await win.getByRole('button', { name: 'Back to sessions', exact: true }).click()

    const opened = await callMcp(app, 'openSession', {
      cwd,
      mode: 'claude',
      name: 'Current runtime fixture'
    })
    sessionId = opened.sessionId
    await win.getByTestId('conversation-panel').waitFor()
    const snapshot = await win.evaluate(
      (id) => window.electronAPI.conversations.snapshot(id),
      sessionId
    )
    assert.equal(snapshot.session.launchProfileId, profileId)
    assert.equal(snapshot.session.pluginBindings.provider.revision, current.builtinRevision)
    assert.deepEqual(snapshot.entries, [], 'No rejected work may be replayed after restart')
    await win.getByRole('textbox', { name: 'Message', exact: true }).fill(prompt)
    await win.getByRole('button', { name: 'Send', exact: true }).click()
    await win.getByText('Fixture reply:', { exact: true }).waitFor()
    await eventually(
      () => existsSync(fixtureFile) && json(fixtureFile).turns === 1,
      'Explicit prompt did not reach the real fixture CLI'
    )
    const fixture = json(fixtureFile)
    assert.equal(fixture.claveId, sessionId)
    assert.ok(fixture.args.includes(marker))
    assert.ok(fixture.args.includes('stream-json'))
    const after = await win.evaluate(
      (id) => window.electronAPI.conversations.snapshot(id),
      sessionId
    )
    assert.deepEqual(
      after.entries.filter((entry) => entry.role === 'user').map((entry) => entry.text),
      [prompt]
    )
    assert.ok(
      after.entries.some((entry) => entry.role === 'assistant' && entry.text.includes(prompt))
    )
    await win.reload()
    await win.getByTestId('conversation-panel').waitFor()
    await win.getByText('Fixture reply:', { exact: true }).waitFor()
    assert.equal(json(fixtureFile).turns, 1, 'Reload must not replay the prompt')
    assert.equal(json(fixtureFile).pid, fixture.pid)
    t.check(
      'confirmed restart reconnects current built-ins; saved CLI profile sends once without replay',
      true
    )
  } finally {
    if (app) {
      if (sessionId)
        await win
          .evaluate((id) => window.electronAPI.conversations.close(id), sessionId)
          .catch(() => {})
      await app.close().catch(() => {})
    }
    // Only this fresh profile's exact owner, fixture PID, and spawned child.
    const pids = new Set()
    if (oldDaemon?.pid && oldDaemon.exitCode === null) pids.add(oldDaemon.pid)
    if (existsSync(ownerFile)) pids.add(json(ownerFile).pid)
    if (existsSync(fixtureFile)) pids.add(json(fixtureFile).pid)
    for (const pid of pids) {
      assert.ok(Number.isInteger(pid) && pid > 1 && pid !== process.pid)
      if (alive(pid)) process.kill(pid, 'SIGTERM')
      await eventually(() => !alive(pid), `Test-owned process ${pid} did not stop`)
    }
    // The daemon owns this hash-specific socket directory, never a shared socket.
    if (paths && paths.socketDirectory !== paths.directory)
      rmSync(paths.socketDirectory, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
}
