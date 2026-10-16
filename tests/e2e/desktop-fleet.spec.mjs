// E owns desktop-consumer integration. F owns the fleet fixture and two-client suite.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  fixturePath,
  serverFixture,
  until,
  REPO
} from './harness.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const owned = (kind, owner, id) =>
  `clave-owner:${kind}:${encodeURIComponent(owner)}:${encodeURIComponent(id)}`
const collision = '11111111-1111-4111-8111-111111111111'
async function daemon(label) {
  const dir = fixturePath(`desktop-fleet-${label}-${Date.now()}`)
  const cwd = path.join(dir, 'repo')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  mkdirSync(cwd, { recursive: true })
  let stderr = ''
  const child = spawn(
    process.execPath,
    [
      path.join(REPO, 'out/main/server-entry.js'),
      '--daemon',
      '--host',
      '127.0.0.1',
      '--port',
      '0',
      '--data-dir',
      dir,
      '--terminal-process',
      path.join(REPO, 'out/main/terminal-process.js'),
      '--node',
      process.execPath,
      '--test-no-activate',
      '--dev-echo-adapter'
    ],
    {
      cwd: REPO,
      env: { ...process.env, SHELL: '/bin/sh' },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  child.stdout.resume()
  child.stderr.on('data', (bytes) => {
    stderr += bytes.toString()
  })
  const endpoint = await until(
    async () => {
      if (child.exitCode !== null) throw new Error(`Test daemon failed: ${stderr.slice(-1500)}`)
      try {
        const value = JSON.parse(readFileSync(path.join(dir, 'clave-server.json'), 'utf8'))
        return value.pid === child.pid ? value : null
      } catch {
        return null
      }
    },
    { tries: 100, gapMs: 150 }
  )
  if (!endpoint) {
    child.kill('SIGTERM')
    throw new Error('Isolated daemon did not become ready')
  }
  return {
    ...endpoint,
    cwd: realpathSync(cwd),
    dir: realpathSync(dir),
    fixture: serverFixture(endpoint.url, endpoint.token),
    async stop() {
      if (child.exitCode !== null) return
      const exited = once(child, 'exit')
      child.kill('SIGTERM')
      const result = await Promise.race([exited, sleep(12000).then(() => null)])
      if (!result) {
        child.kill('SIGKILL')
        await once(child, 'exit')
        throw new Error('Owned daemon exceeded shutdown deadline')
      }
    }
  }
}
async function post(server, route, body) {
  const response = await fetch(`${server.url}${route}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  assert.equal(response.status, 200, `owning endpoint ${route}: ${await response.clone().text()}`)
  return response.json()
}
async function check(condition, message) {
  assert.ok(await condition(), message)
}
export async function run(t) {
  const servers = []
  let app
  const root = fixturePath(`desktop-fleet-mac-root-${Date.now()}`)
  const dir = fixturePath(`desktop-fleet-mac-${Date.now()}`)
  mkdirSync(root, { recursive: true })
  seedWorkspaces(dir, {
    workspaces: [{ id: 'mac-only', name: 'Mac', rootDir: root, profileFile: null, createdAt: 1 }],
    activeWorkspaceId: 'mac-only',
    fresh: true
  })
  seedTrustedRoots(dir, [root])
  try {
    const a = await daemon('a')
    servers.push(a)
    const b = await daemon('b')
    servers.push(b)
    const launched = await launchApp(dir, {
      server: 'in-process',
      env: { SHELL: '/bin/sh' },
      args: ['--dev-echo-adapter']
    })
    app = launched.app
    const win = launched.win
    assert.equal(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((w) => w.isVisible())
      ),
      false
    )
    await win.getByLabel('Manage Clave servers', { exact: true }).click()
    await win.getByLabel('Server name', { exact: true }).fill('VPS A')
    await win.getByLabel('Server address', { exact: true }).fill(a.url)
    await win.getByLabel('Server bearer token', { exact: true }).fill(a.token)
    await win.getByRole('button', { name: 'Add server', exact: true }).click()
    await check(
      () =>
        until(async () => (await win.evaluate(() => window.electronAPI.fleetList())).length === 1),
      'UI saves the first server'
    )
    assert.equal(await win.getByLabel('Server bearer token', { exact: true }).inputValue(), '')
    await win.getByRole('button', { name: 'Close', exact: true }).click()
    const savedA = (await win.evaluate(() => window.electronAPI.fleetList()))[0]
    const savedB = await win.evaluate(
      ({ name, url, token }) => window.electronAPI.fleetSave({ name, url, token }),
      { name: 'VPS B', url: b.url, token: b.token }
    )
    assert.equal('token' in savedA, false)
    assert.equal('token' in savedB, false)
    await win.evaluate(() => {
      globalThis.fleetStatus = {}
      window.electronAPI.onFleetStatus((s) => {
        globalThis.fleetStatus[s.serverId] = s.state
      })
    })
    await check(
      () =>
        until(() =>
          win.evaluate(
            (ids) => ids.every((id) => globalThis.fleetStatus[id] === 'connected'),
            [savedA.id, savedB.id]
          )
        ),
      'both servers connect'
    )
    // The empty server has an explicit creation path, using its own folder/profile data.
    await win.getByLabel('Manage Clave servers', { exact: true }).click()
    await win
      .locator(`[data-server-id="${savedB.id}"]`)
      .getByRole('button', { name: 'New session', exact: true })
      .click()
    await win.getByLabel('Server folder', { exact: true }).fill(b.cwd)
    await win.getByRole('button', { name: 'Start session', exact: true }).click()
    await check(
      () =>
        until(async () =>
          (
            await win.evaluate((id) => window.electronAPI.fleetSnapshot(id), savedB.id)
          ).sessions.some((s) => s.provider === 'terminal')
        ),
      'first session starts on empty owner'
    )
    const terminal = (
      await win.evaluate((id) => window.electronAPI.fleetSnapshot(id), savedB.id)
    ).sessions.find((s) => s.provider === 'terminal')
    const terminalWire = decodeURIComponent(terminal.id.split(':').at(-1))
    await win.locator(`[data-terminal-tile="${terminal.id}"] .xterm`).waitFor()
    await win.evaluate((id) => {
      globalThis.remoteTerminalBytes = ''
      window.electronAPI.onSessionData(id, (data) => {
        globalThis.remoteTerminalBytes += data
      })
    }, terminal.id)
    await check(
      () =>
        until(() =>
          win.evaluate(
            () =>
              globalThis.remoteTerminalBytes.split(String.fromCharCode(27) + 'c').join('').length >
              3
          )
        ),
      'selected remote terminal actually starts and emits shell output'
    )

    await win.evaluate(
      (id) =>
        window.electronAPI.writeSession(
          id,
          "printf 'OWNING_REMOTE_EFFECT\\n' > bridge-effect.txt\r"
        ),
      terminal.id
    )
    await check(
      () => until(async () => existsSync(path.join(b.cwd, 'bridge-effect.txt'))),
      'remote terminal produces a real owning-server effect'
    )
    assert.equal(
      readFileSync(path.join(b.cwd, 'bridge-effect.txt'), 'utf8'),
      'OWNING_REMOTE_EFFECT\n'
    )
    assert.equal(existsSync(path.join(a.cwd, 'bridge-effect.txt')), false)
    t.check(
      'empty remote server starts a real terminal through UI and executes only on its owner',
      true
    )

    for (const server of [a, b])
      await post(server, '/sessions/start', {
        cwd: server.cwd,
        windowKey: 'unrelated-mac-key',
        options: {
          claudeMode: true,
          launchProfileId: 'dev-echo-adapter',
          adoptSessionId: collision
        }
      })
    const ka = owned('session', savedA.id, collision)
    const kb = owned('session', savedB.id, collision)
    await win.evaluate(
      (ids) => Promise.all(ids.map((id) => window.electronAPI.fleetSnapshot(id))),
      [savedA.id, savedB.id]
    )
    await win.locator(`[data-sidebar-item-id="${ka}"]`).waitFor()
    await win.locator(`[data-sidebar-item-id="${kb}"]`).waitFor()
    assert.equal(
      await win.locator(`[data-sidebar-item-id="${ka}"] [data-fleet-owner="${savedA.id}"]`).count(),
      1
    )
    await win.locator(`[data-sidebar-item-id="${ka}"]`).click()
    await win
      .locator(`[data-session-id="${ka}"] [data-testid="chat-view"] textarea:not(:disabled)`)
      .waitFor()
    await win
      .locator(`[data-session-id="${ka}"] [data-testid="chat-view"] textarea`)
      .fill('message only for server A')
    await win
      .locator(`[data-session-id="${ka}"] [data-testid="chat-view"]`)
      .getByRole('button', { name: 'Send message', exact: true })
      .click()
    await win
      .locator(`[data-session-id="${ka}"] .chat-turn[data-role="assistant"]`)
      .filter({ hasText: 'message only for server A' })
      .waitFor()
    const histories = await win.evaluate(
      (ids) => Promise.all(ids.map((id) => window.electronAPI.sessionsHistory(id))),
      [ka, kb]
    )

    assert.equal(JSON.stringify(histories[1]).includes('message only for server A'), false)
    t.check(
      'colliding IDs from unrelated server windows have distinct sidebar rows, panes and live turns',
      true
    )

    writeFileSync(path.join(a.cwd, 'notes.txt'), 'A initial')
    writeFileSync(path.join(b.cwd, 'notes.txt'), 'B initial')
    const fileA = owned('file', savedA.id, a.cwd)
    const fileB = owned('file', savedB.id, b.cwd)
    const reads = await win.evaluate(
      (roots) => Promise.all(roots.map((r) => window.electronAPI.readFile(r, 'notes.txt'))),
      [fileA, fileB]
    )
    assert.deepEqual(
      reads.map((r) => r.content),
      ['A initial', 'B initial']
    )
    await win.evaluate((root) => window.electronAPI.writeFile(root, 'notes.txt', 'A edited'), fileA)
    assert.equal(readFileSync(path.join(a.cwd, 'notes.txt'), 'utf8'), 'A edited')
    assert.equal(readFileSync(path.join(b.cwd, 'notes.txt'), 'utf8'), 'B initial')
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
    const localImage = path.join(root, 'mac-image.png')
    writeFileSync(localImage, Buffer.from(png, 'base64'))
    const image = await win.evaluate(
      ({ id, file }) => window.electronAPI.sessionsFiles.prepare(id, { path: file }),
      { id: ka, file: localImage }
    )
    assert.ok(image.path.startsWith(`clave-owner:file:${savedA.id}:`))
    const remotePath = decodeURIComponent(image.path.split(':').at(-1))
    assert.ok(remotePath.startsWith(path.join(a.dir, 'session-attachments')))
    assert.equal(readFileSync(remotePath).toString('base64'), png)
    assert.ok(
      (await win.evaluate((file) => window.electronAPI.sessionsFiles.preview(file), image)).image
    )
    await win.evaluate(
      ({ id, file }) =>
        window.electronAPI.sessionsWrite(id, {
          type: 'user_message',
          text: 'image to A',
          attachments: [file]
        }),
      { id: ka, file: image }
    )
    t.check('file reads/edits and selected Mac image bytes stay owner-scoped', true)

    await a.fixture.evaluate(
      (id) =>
        globalThis.__claveE2E.echo.inject(id, {
          kind: 'event',
          event: {
            type: 'permission_request',
            id: 'native-question',
            description: 'Native private clarification',
            toolName: 'item/tool/requestUserInput',
            input: { questions: [{ question: 'Private answer', isSecret: true }] },
            questions: [{ question: 'Private answer', options: [] }],
            options: [
              { id: 'answer', label: 'Answer' },
              { id: 'deny', label: 'Deny' }
            ]
          }
        }),
      collision
    )
    const privateInput = win.locator('input[aria-label="Private answer"]')
    await privateInput.waitFor()
    assert.equal(await privateInput.getAttribute('type'), 'password')
    assert.equal(
      await win.locator('.chat-prompt-options[aria-label="Private answer"]').count(),
      0,
      'all native views defer to the shared masked request UI'
    )
    await privateInput.fill('test-only-private-answer')
    await win.getByRole('button', { name: 'Answer', exact: true }).click()
    await privateInput.waitFor({ state: 'detached' })
    assert.equal(
      await win
        .locator('body')
        .innerText()
        .then((s) => s.includes('test-only-private-answer')),
      false
    )
    t.check(
      'native clarification replays through the common request UI with masked answers and settles',
      true
    )

    await win.evaluate((id) => window.electronAPI.fleetDisconnect(id), savedA.id)
    await check(
      () =>
        until(() =>
          win.locator(`[data-sidebar-item-id="${ka}"] [data-fleet-state="disconnected"]`).count()
        ),
      'intentional disconnect retains offline rows'
    )
    await win.evaluate(
      (id) =>
        window.electronAPI.sessionsWrite(id, {
          type: 'user_message',
          text: 'B works while A disconnected'
        }),
      kb
    )
    await assert.rejects(win.evaluate((id) => window.electronAPI.sessionsHistory(id), ka))
    await win.evaluate((id) => window.electronAPI.fleetConnect(id), savedA.id)
    await check(
      () =>
        until(() => win.evaluate((id) => globalThis.fleetStatus[id] === 'connected', savedA.id)),
      'intentional reconnect succeeds'
    )
    const reconnectHistory = await win.evaluate((id) => window.electronAPI.sessionsHistory(id), ka)
    t.check(
      'disconnect retains remote sessions, rejects stale owner calls and leaves the other server usable',
      true
    )

    await win.evaluate((id) => window.electronAPI.killSession(id), kb)
    await check(
      () => until(async () => (await win.locator(`[data-sidebar-item-id="${kb}"]`).count()) === 0),
      'close propagates from owning server'
    )
    assert.ok(
      (await win.evaluate((id) => window.electronAPI.fleetSnapshot(id), savedA.id)).sessions.some(
        (s) => s.id === ka
      )
    )
    await win.evaluate((id) => window.electronAPI.killSession(id), terminal.id)
    assert.ok(terminalWire)
    t.check('closing one colliding tab removes only its owning server tab', true)
    assert.ok(reconnectHistory.items.length > 0, 'owning live history survives reconnect')
    assert.ok(
      JSON.stringify(histories[0]).includes('message only for server A'),
      'live history contains the turn sent through this desktop'
    )
  } finally {
    if (app) await app.close()
    for (const server of servers.reverse()) await server.stop()
  }
}
