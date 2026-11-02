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
  callMcp,
  until,
  REPO
} from './harness.mjs'
import { openServersPage } from './fixtures/fleet-world.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const owned = (kind, owner, id) =>
  `clave-owner:${kind}:${encodeURIComponent(owner)}:${encodeURIComponent(id)}`
const collision = '11111111-1111-4111-8111-111111111111'
// Keep title scheduling inside a one-shot recording fixture as well.
function seedTitleProfile(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const script = path.join(dir, 'title-fixture.cjs')
  writeFileSync(script, 'process.stdout.write("Desktop fixture title\\n")', { mode: 0o600 })
  writeFileSync(
    path.join(dir, 'agent-launch-profiles.json'),
    JSON.stringify({
      version: 1,
      customProfiles: [
        {
          id: 'desktop-title-fixture',
          name: 'Desktop title fixture',
          family: 'claude',
          command: [process.execPath, script],
          additionalArgs: []
        }
      ],
      globalDefaults: { claude: 'desktop-title-fixture' },
      workspaceOverrides: {}
    }),
    { mode: 0o600 }
  )
}
async function daemon(label, previous) {
  const dir = previous?.dir ?? fixturePath(`desktop-fleet-${label}-${Date.now()}`)
  const cwd = path.join(dir, 'repo')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  mkdirSync(cwd, { recursive: true })
  const rolloutRoot = path.join(dir, 'recording-codex-rollouts')
  mkdirSync(rolloutRoot, { recursive: true, mode: 0o700 })
  if (!previous) seedTitleProfile(dir)
  let stderr = ''
  const child = spawn(
    process.execPath,
    [
      path.join(REPO, 'out/main/server-entry.js'),
      '--daemon',
      '--host',
      '127.0.0.1',
      '--port',
      String(previous?.port ?? 0),
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
      env: { ...process.env, SHELL: '/bin/sh', CLAVE_CODEX_ROOT: rolloutRoot },
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
// Close the switcher and wait until its popover is gone, so a shortcut
// pressed next reaches the window.
async function closeSwitcher(win) {
  const add = win.getByRole('button', { name: 'Add workspace…', exact: true })
  if (await add.isVisible()) await win.keyboard.press('Escape')
  await add.waitFor({ state: 'hidden' })
}
/** Switch the window to a workspace through the toolbar switcher. */
async function switchWorkspace(win, workspaceId) {
  const item = win.locator(`[data-workspace-id="${workspaceId}"]`)
  await check(
    () =>
      until(async () => {
        if (!(await item.count())) {
          await win.getByLabel('Switch workspace', { exact: true }).click()
          await item.waitFor({ state: 'visible', timeout: 2_000 }).catch(() => {})
        }
        if (!(await item.count())) {
          await closeSwitcher(win)
          return false
        }
        if (
          (await item.getAttribute('data-selected', { timeout: 2_000 }).catch(() => null)) ===
          'true'
        ) {
          await closeSwitcher(win)
          return true
        }
        // A pane mounting after a launch can take focus and close the popover
        // while it animates in: the click is retried from a fresh open.
        await item.click({ timeout: 3_000 }).catch(() => {})
        return false
      }),
    `the window shows workspace ${workspaceId}`
  )
}
/** Remote tabs show only in a workspace of their own server (#241): register
 *  the server's repo folder as one of its workspaces (once) and switch to it. */
async function showServer(win, owner, rootDir) {
  const id = await win.evaluate(
    async ({ owner, rootDir }) => {
      const existing = (await window.electronAPI.fleetWorkspaces(owner)).find(
        (w) => w.rootDir === rootDir
      )
      return (existing ?? (await window.electronAPI.fleetAddWorkspace(owner, { rootDir }))).id
    },
    { owner, rootDir }
  )
  await switchWorkspace(win, id)
  return id
}
const showMac = (win) => switchWorkspace(win, 'mac-only')
export async function run(t) {
  const servers = []
  let app
  const root = fixturePath(`desktop-fleet-mac-root-${Date.now()}`)
  const dir = fixturePath(`desktop-fleet-mac-${Date.now()}`)
  mkdirSync(root, { recursive: true })
  seedTitleProfile(dir)
  seedWorkspaces(dir, {
    workspaces: [{ id: 'mac-only', name: 'Mac', rootDir: root, profileFile: null, createdAt: 1 }],
    activeWorkspaceId: 'mac-only',
    fresh: true
  })
  seedTrustedRoots(dir, [root])
  try {
    let a = await daemon('a')
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
    const rendererErrors = []
    const documentImageRequests = []
    win.on('request', (request) => {
      if (request.url().includes('server-picture.png')) documentImageRequests.push(request.url())
    })
    win.on('pageerror', (error) => rendererErrors.push(error.message))
    assert.equal(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((w) => w.isVisible())
      ),
      false
    )
    await openServersPage(win)
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
    await win.getByRole('button', { name: 'Back to sessions', exact: true }).click()
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
    // The empty server starts a session through the normal launch flow: in a
    // workspace of that server, Cmd+T opens a terminal at its root.
    await showServer(win, savedB.id, b.cwd)
    await win.keyboard.press('Meta+T')
    const firstStarted = await until(async () =>
      (await win.evaluate((id) => window.electronAPI.fleetSnapshot(id), savedB.id)).sessions.some(
        (s) => s.provider === 'terminal'
      )
    )
    if (!firstStarted) {
      const listed = await fetch(`${b.url}/sessions`, {
        headers: { authorization: `Bearer ${b.token}` }
      }).then((r) => r.json())
      const notice = await win.getByTestId('launch-notice').allInnerTexts()
      assert.fail(
        `first session starts on empty owner: server B lists ${JSON.stringify(listed)}, notice ${JSON.stringify(notice)}`
      )
    }
    const terminal = (
      await win.evaluate((id) => window.electronAPI.fleetSnapshot(id), savedB.id)
    ).sessions.find((s) => s.provider === 'terminal')
    const terminalWire = decodeURIComponent(terminal.id.split(':').at(-1))
    const onB = await fetch(`${b.url}/sessions`, {
      headers: { authorization: `Bearer ${b.token}` }
    })
    assert.equal(onB.status, 200)
    const started = (await onB.json()).find((s) => s.id === terminalWire)
    assert.ok(started, 'the owning server lists the started terminal')
    assert.equal(
      realpathSync(started.cwd),
      b.cwd,
      'the terminal starts at the server workspace root'
    )
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
        cwd: server === a ? server.cwd.replace(/^\/private\/tmp\//, '/tmp/') : server.cwd,
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
    await win.locator(`[data-sidebar-item-id="${kb}"]`).waitFor()
    await showServer(win, savedA.id, a.cwd)
    await win.locator(`[data-sidebar-item-id="${ka}"]`).waitFor()
    assert.equal(
      await win.locator(`[data-sidebar-item-id="${ka}"] [data-fleet-owner="${savedA.id}"]`).count(),
      1
    )
    // Echo deliberately has no persisted provider/account record. Use an
    // actual Claude adapter with a recording offline CLI for account identity.
    const quotaCli = path.join(a.dir, 'quota-cli.cjs')
    const quotaProcesses = path.join(a.dir, 'quota-cli-processes.jsonl')
    writeFileSync(
      quotaCli,
      `
      const fs = require('node:fs');
      const readline = require('node:readline');
      const argv = process.argv.slice(2);
      if (argv.includes('-p') && !argv.includes('--input-format')) {
        process.stdout.write('offline quota title\\n'); process.exit(0);
      }
      fs.appendFileSync(${JSON.stringify(quotaProcesses)}, JSON.stringify({pid:process.pid,argv})+'\\n');
      readline.createInterface({input:process.stdin}).on('line', () => {});
      setInterval(() => {}, 1000);
    `
    )
    await post(a, '/launch-profiles', {
      profile: {
        id: 'desktop-offline-claude',
        name: 'Desktop quota fixture',
        family: 'claude',
        command: [process.execPath, quotaCli],
        additionalArgs: []
      }
    })
    const quotaId = '33333333-3333-4333-8333-333333333333'
    await post(a, '/sessions/start', {
      cwd: a.cwd,
      options: {
        claudeMode: true,
        launchProfileId: 'chat:claude:desktop-offline-claude',
        claudeProfileId: 'default',
        adoptSessionId: quotaId
      }
    })
    const quotaKey = owned('session', savedA.id, quotaId)
    // A default account on a server is unrelated to the Mac's default account.
    // Stub only the isolated Mac settings source, then load it through the real
    // Usage UI. A real local echo row proves that its exhausted quota landed.
    await app.evaluate(() => {
      const read = () => ({
        fetchedAt: Date.now(),
        windows: [
          {
            key: '5h',
            label: 'Current session (5h)',
            kind: 'session',
            scope: null,
            usedPercentage: 100,
            severity: 'critical',
            resetsAt: Date.now() + 3600000
          }
        ]
      })
      const usage = globalThis.__claveE2E.settings.usage
      usage.readClaude = async (accountId) => {
        assertDefault(accountId)
        return read()
      }
      usage.claudeSnapshot = () => ({ default: read() })
      function assertDefault(accountId) {
        if (accountId !== 'default') throw new Error('Unexpected Mac quota account')
      }
    })
    // The local control row lives in the Mac workspace, which shows no tab
    // of a server.
    await showMac(win)
    await check(
      () => until(async () => (await win.locator(`[data-sidebar-item-id="${ka}"]`).count()) === 0),
      'the remote tab is hidden in the Mac workspace'
    )
    const localQuota = await callMcp(app, 'openSession', {
      cwd: root,
      mode: 'claude',
      profile: 'dev-echo-adapter',
      account: 'default',
      name: 'Mac quota control'
    })
    const localRow = win.locator(`[data-sidebar-item-id="${localQuota.sessionId}"]`)
    await localRow.waitFor()
    await win.locator('.sidebar-footer-line[data-usage-provider="claude"]').click()
    await win.getByRole('button', { name: 'Refresh usage' }).click()
    await win.getByRole('button', { name: 'Back to sessions', exact: true }).click()
    await localRow.locator('[data-account-limit="default"]').waitFor()
    await showServer(win, savedA.id, a.cwd)
    const remoteRecord = (
      await win.evaluate((id) => window.electronAPI.fleetSnapshot(id), savedA.id)
    ).records.find((record) => record.id === quotaKey)
    assert.ok(remoteRecord, 'the owner supplies the actual remote session record')
    assert.equal(remoteRecord.claudeProfileId ?? 'default', 'default')
    assert.equal(remoteRecord.claudeMode, true)
    const remoteRow = win.locator(`[data-sidebar-item-id="${quotaKey}"]`)
    await remoteRow.waitFor()
    assert.equal(await remoteRow.locator('[data-account-limit]').count(), 0)
    // No logo leads a title any more (PRDCT-3933); the row's status slot is on
    // its right, and a remote row has no lifecycle to draw there.
    assert.equal(await remoteRow.locator('.sidebar-tab-icon').count(), 0)
    assert.equal(await remoteRow.locator('.sidebar-tab-status').count(), 1)
    assert.equal(await remoteRow.locator('.sidebar-tab-status svg').count(), 0)
    const ownerBadge = remoteRow.locator(`[data-fleet-owner="${savedA.id}"]`)
    const assertOwnerBadge = async () => {
      assert.equal(await ownerBadge.getAttribute('title'), 'VPS A')
      const nameBox = await remoteRow.getByTestId('session-tab-name').boundingBox()
      const badgeBox = await ownerBadge.boundingBox()
      assert.ok(
        nameBox && badgeBox && badgeBox.x >= nameBox.x + nameBox.width - 1,
        'the owner badge remains a separate accessory to the right of the name'
      )
      assert.equal(await remoteRow.locator('[data-account-limit]').count(), 0)
    }
    await assertOwnerBadge()
    t.check(
      'remote default-account row keeps its owner mark, no logo and no exhausted Mac quota',
      true
    )

    await win.click('.sidebar-footer-btn[aria-label="Settings"]')
    await win.click('[data-settings-nav-row="appearance"]')
    await win.click('[data-agent-mark-option="clave.orbs/orbs"]')
    await win.click('[data-orb-option="weaving"]')
    await win.getByRole('button', { name: 'Back to sessions', exact: true }).click()
    const remoteOrb = remoteRow.locator(
      '.sidebar-tab-status[data-mark="pack"] canvas[data-orb-state="weaving"]'
    )
    await remoteOrb.waitFor()
    assert.equal(await remoteRow.locator('.sidebar-tab-status svg').count(), 0)
    await assertOwnerBadge()
    await win.evaluate(() => window.electronAPI.pluginsDisable('clave.orbs'))
    assert.ok(
      await until(
        async () => (await remoteRow.locator('.sidebar-tab-status canvas').count()) === 0
      ),
      'the orb leaves the remote row when its plugin is disabled'
    )
    assert.equal(await remoteRow.locator('.sidebar-tab-status[data-mark]').count(), 0)
    await assertOwnerBadge()
    await win.evaluate(() => window.electronAPI.pluginsEnable('clave.orbs', []))
    await remoteOrb.waitFor()
    await assertOwnerBadge()
    t.check(
      'remote mark pack and disabled-plugin logo fallback preserve the separate far-right owner badge',
      true
    )
    await win.click('.sidebar-footer-btn[aria-label="Settings"]')
    await win.click('[data-settings-nav-row="appearance"]')
    await win.click('[data-agent-mark-option="logo"]')
    await win.getByRole('button', { name: 'Back to sessions', exact: true }).click()
    assert.ok(
      await until(
        async () => (await remoteRow.locator('.sidebar-tab-status canvas').count()) === 0
      ),
      'the orb leaves the remote row when the logo is the mark again'
    )
    await win.evaluate((id) => window.electronAPI.killSession(id), quotaKey)
    await win.evaluate((id) => window.electronAPI.killSession(id), localQuota.sessionId)
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
    mkdirSync(path.join(a.cwd, 'uploads'), { recursive: true })
    writeFileSync(
      path.join(a.cwd, 'remote.md'),
      '# From server A\n![server picture](server-picture.png)'
    )
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
    const panelCwd = a.cwd.replace(/^\/private\/tmp\//, '/tmp/')
    const tree = win.locator(`[data-file-tree-root="${owned('file', savedA.id, panelCwd)}"]`)
    if (!(await tree.count())) await win.getByTitle(/^File tree/).click()
    await tree.locator('[data-tree-name="notes.txt"]').click({ button: 'right' })
    await win.getByRole('menuitem', { name: 'Open in Tab', exact: true }).click()
    const editor = win.locator('.cm-content[contenteditable="true"]:visible')
    await editor.waitFor()
    assert.deepEqual(rendererErrors, [], 'remote file focus keeps the renderer alive')
    assert.equal(await tree.count(), 1, 'remote file focus keeps the file panel on its owner')
    await editor.fill('A edited in desktop')
    await editor.press('Meta+s')
    await check(
      () =>
        until(() => readFileSync(path.join(a.cwd, 'notes.txt'), 'utf8') === 'A edited in desktop'),
      'remote file editor saves bytes on its owner'
    )
    assert.equal(readFileSync(path.join(b.cwd, 'notes.txt'), 'utf8'), 'B initial')
    await win.locator(`[data-sidebar-item-id="${ka}"]`).click()
    await tree.locator('[data-tree-name="remote.md"]').click({ button: 'right' })
    await win.getByRole('menuitem', { name: 'Open in Tab', exact: true }).click()
    await sleep(400)
    assert.deepEqual(
      documentImageRequests.filter((url) => url.startsWith('file:')),
      [],
      'remote document must not request its image from the Mac filesystem'
    )
    await win
      .locator('.cm-content:visible')
      .filter({ hasText: '# From server A' })
      .waitFor({ timeout: 5000 })
    assert.equal(
      await win.locator('.mdxeditor:visible img').count(),
      0,
      'remote document image references are not interpreted as Mac paths'
    )
    await win.locator(`[data-sidebar-item-id="${ka}"]`).click()
    // Normal Upload from a navigated /tmp alias must use the visible owner root.
    await tree.locator('[data-tree-name="uploads"]').click({ button: 'right' })
    await win.getByRole('menuitem', { name: 'Open as Root', exact: true }).click()
    const uploadsTree = win.locator(
      `[data-file-tree-root="${owned('file', savedA.id, path.join(panelCwd, 'uploads'))}"]`
    )
    const macUpload = path.join(root, 'mac-upload.txt')
    writeFileSync(macUpload, 'Mac upload owning-server byte sentinel')
    await app.evaluate(({ dialog }, source) => {
      globalThis.__fleetOpenDialog = dialog.showOpenDialog
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] })
    }, macUpload)
    try {
      await uploadsTree.getByText('Empty directory', { exact: true }).click({ button: 'right' })
      await win.getByRole('menuitem', { name: 'Upload files here…', exact: true }).click()
      assert.ok(
        await until(() => existsSync(path.join(a.cwd, 'uploads', 'mac-upload.txt'))),
        `normal UI upload must complete: ${await uploadsTree.innerText()}`
      )
      assert.equal(
        readFileSync(path.join(a.cwd, 'uploads', 'mac-upload.txt'), 'utf8'),
        'Mac upload owning-server byte sentinel'
      )
      assert.equal(existsSync(path.join(b.cwd, 'uploads', 'mac-upload.txt')), false)
    } finally {
      await app.evaluate(({ dialog }) => {
        dialog.showOpenDialog = globalThis.__fleetOpenDialog
        delete globalThis.__fleetOpenDialog
      })
    }
    t.check('normal UI Upload from a navigated directory transfers exact owning bytes', true)
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
    // The server's question docks in its own session's pane, the dock a local
    // session uses (#261), and no separate dialog opens for it.
    const nativeDock = win.locator(`.chat-host[data-session-id="${ka}"] .chat-prompt:visible`)
    const privateInput = nativeDock.locator('input.chat-prompt-other')
    await privateInput.waitFor()
    assert.equal(await privateInput.getAttribute('type'), 'password')
    assert.equal(await win.getByRole('dialog').count(), 0, 'no separate request dialog')
    await privateInput.fill('test-only-private-answer')
    await nativeDock.getByRole('button', { name: 'Review', exact: true }).click()
    assert.equal((await nativeDock.innerText()).includes('test-only-private-answer'), false)
    await nativeDock.getByRole('button', { name: 'Send', exact: true }).click()
    assert.ok(await until(async () => (await nativeDock.count()) === 0), 'the dock settles')
    assert.equal(
      await win
        .locator('body')
        .innerText()
        .then((s) => s.includes('test-only-private-answer')),
      false
    )
    t.check(
      'native clarification replays into the session dock with masked answers and settles',
      true
    )

    // An actual recording JSON-RPC child exercises the provider boundary.
    // It performs no model inference and records no initialization credentials.
    const providerFile = path.join(a.dir, 'question-provider.cjs')
    const providerReplies = path.join(a.dir, 'question-provider-replies.jsonl')
    const providerLaunches = path.join(a.dir, 'question-provider-launches.jsonl')
    const providerThread = '22222222-2222-4222-8222-222222222222'
    const providerRollout = path.join(
      a.dir,
      'recording-codex-rollouts',
      `rollout-desktop-${providerThread}.jsonl`
    )
    writeFileSync(
      providerFile,
      `
      const fs = require('node:fs');
      const readline = require('node:readline');
      readline.createInterface({input:process.stdin}).on('line', line => {
        const frame = JSON.parse(line);
        if (frame.id === 'native-input' && frame.result) {
          fs.appendFileSync(${JSON.stringify(providerReplies)}, JSON.stringify(frame)+'\\n');
          return;
        }
        if (frame.id === undefined) return;
        if (frame.method === 'thread/start' || frame.method === 'thread/resume')
          fs.appendFileSync(${JSON.stringify(providerLaunches)}, JSON.stringify({method:frame.method,cwd:frame.params?.cwd,threadId:frame.params?.threadId})+'\\n');
        const result = ['thread/start','thread/resume','thread/read'].includes(frame.method)
          ? {thread:{id:${JSON.stringify(providerThread)},turns:[]}} : frame.method === 'model/list' ? {data:[],nextCursor:null} : frame.method === 'turn/start' ? {turn:{id:'recorded-turn',status:'completed'}} : {};
        process.stdout.write(JSON.stringify({id:frame.id,result})+'\\n');
        if (frame.method === 'turn/start') {
          const text = frame.params.input.filter(item => item.type === 'text').map(item => item.text).join('\\n');
          const reply = 'Recorded provider reply: '+text;
          fs.writeFileSync(${JSON.stringify(providerRollout)}, [
            {type:'session_meta',payload:{id:${JSON.stringify(providerThread)},cwd:${JSON.stringify(a.cwd)}}},
            {type:'turn_context',payload:{turn_id:'recorded-turn'}},
            {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text}]}},
            {type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:reply}]}}
          ].map(row => JSON.stringify(row)).join('\\n')+'\\n', {mode:0o600});
          process.stdout.write(JSON.stringify({method:'item/completed',params:{threadId:${JSON.stringify(providerThread)},turnId:'recorded-turn',item:{type:'agentMessage',id:'recorded-reply',text:reply}}})+'\\n');
          process.stdout.write(JSON.stringify({method:'turn/completed',params:{threadId:${JSON.stringify(providerThread)},turn:{id:'recorded-turn',status:'completed'}}})+'\\n');
        }
        if (frame.method === 'thread/start') process.stdout.write(JSON.stringify({
          id:'native-input',method:'item/tool/requestUserInput',params:{
            threadId:${JSON.stringify(providerThread)},turnId:'desktop-fixture-turn',itemId:'desktop-fixture-item',isBlocking:true,
            questions:[
              {id:'public-question-id',header:'Public value',question:'Value?',isSecret:false,options:null},
              {id:'private-question-id',header:'Private value',question:'Value?',isSecret:true,options:null}
            ]
          }
        })+'\\n');
      });
    `
    )
    await post(a, '/launch-profiles', {
      profile: {
        id: 'desktop-protocol',
        name: 'Desktop protocol fixture',
        family: 'codex',
        command: [process.execPath, providerFile],
        additionalArgs: []
      }
    })
    // The launch flow carries no server profile pick, so this session names
    // the server's protocol profile explicitly; the window is already on the
    // workspace of server A, rooted at a.cwd.
    const startedProvider = await win.evaluate(
      ({ owner, cwd }) =>
        window.electronAPI.fleetStart(owner, cwd, {
          claudeMode: false,
          codexMode: true,
          launchProfileId: 'chat:codex:desktop-protocol'
        }),
      { owner: savedA.id, cwd: a.cwd }
    )
    // Its question docks in its own pane: open its tab.
    await win.locator(`[data-sidebar-item-id="${startedProvider.id}"]`).click()
    const pendingNative = await until(async () => {
      const response = await fetch(`${a.url}/requests/pending`, {
        headers: { authorization: `Bearer ${a.token}` }
      })
      assert.equal(response.status, 200)
      return (await response.json()).pending.find((r) => r.providerRequestId === '"native-input"')
    })
    assert.ok(pendingNative, 'the real provider request reaches owning pending HTTP snapshot')
    assert.deepEqual(
      pendingNative.questions.map((q) => q.id),
      ['public-question-id', 'private-question-id']
    )
    assert.deepEqual(pendingNative.secretQuestions, ['private-question-id'])
    const providerKey = owned('session', savedA.id, pendingNative.sessionId)
    // One question at a time, then a review, as in a local session's dock.
    const dock = win.locator(`.chat-host[data-session-id="${providerKey}"] .chat-prompt:visible`)
    const publicQuestion = dock.locator('textarea.chat-prompt-other')
    await publicQuestion.waitFor()
    assert.equal(await win.getByRole('dialog').count(), 0, 'no separate request dialog')
    assert.ok((await dock.innerText()).includes('Public value'))
    await publicQuestion.fill('public fixture answer')
    assert.equal(await publicQuestion.inputValue(), 'public fixture answer')
    await dock.getByRole('button', { name: 'Next', exact: true }).click()
    const privateQuestion = dock.locator('input.chat-prompt-other')
    await privateQuestion.waitFor()
    assert.equal(await privateQuestion.getAttribute('type'), 'password')
    assert.equal(await privateQuestion.getAttribute('aria-label'), 'Private value')
    await privateQuestion.fill('private fixture answer')
    assert.equal(await privateQuestion.inputValue(), 'private fixture answer')
    assert.equal((await win.locator('body').innerText()).includes('private-question-id'), false)
    await dock.getByRole('button', { name: 'Review', exact: true }).click()
    const review = await dock.innerText()
    assert.ok(review.includes('public fixture answer'))
    assert.equal(review.includes('private fixture answer'), false)
    await dock.getByRole('button', { name: 'Send', exact: true }).click()
    assert.ok(await until(async () => (await dock.count()) === 0), 'the dock settles')
    assert.equal((await win.locator('body').innerText()).includes('private fixture answer'), false)
    const replies = () =>
      existsSync(providerReplies)
        ? readFileSync(providerReplies, 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : []
    await check(
      () => until(() => replies().length === 1),
      'one actual provider JSON-RPC response is written'
    )
    assert.deepEqual(replies(), [
      {
        id: 'native-input',
        result: {
          answers: {
            'public-question-id': { answers: ['public fixture answer'] },
            'private-question-id': { answers: ['private fixture answer'] }
          }
        }
      }
    ])
    const duplicate = await post(a, '/requests/resolve', {
      requestId: pendingNative.id,
      response: {
        type: 'permission',
        optionId: 'answer',
        answers: {
          'public-question-id': 'public fixture answer',
          'private-question-id': 'private fixture answer'
        }
      }
    })
    assert.equal(duplicate.accepted, false)
    assert.equal(replies().length, 1)
    assert.equal(
      JSON.parse(readFileSync(providerLaunches, 'utf8').trim().split('\n')[0]).cwd,
      a.cwd,
      'selected folder reaches the actual provider on its server'
    )
    t.check(
      'server launch profile and same-label public/private inputs map to exact provider IDs once',
      true
    )
    // Started outside the launcher, the session is not focused on its own:
    // open its tab so its transcript is on screen.
    await win.locator(`[data-sidebar-item-id="${providerKey}"]`).click()
    await win.locator(`[data-session-id="${providerKey}"]`).waitFor()
    await win.evaluate(
      (id) =>
        window.electronAPI.sessionsWrite(id, {
          type: 'user_message',
          text: 'recorded provider turn'
        }),
      providerKey
    )
    await check(
      () => until(() => existsSync(providerRollout)),
      'actual provider turn writes its rollout inside the isolated daemon root'
    )
    await check(
      () =>
        until(async () =>
          (await win.locator(`[data-session-id="${providerKey}"]`).innerText()).includes(
            'Recorded provider reply: recorded provider turn'
          )
        ),
      'actual protocol turn reply reaches the native desktop transcript'
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
    await a.fixture.evaluate((id) => {
      globalThis.__claveE2E.echo.inject(id, {
        kind: 'event',
        event: { type: 'user_message', text: 'missed while this Mac was disconnected' }
      })
      globalThis.__claveE2E.echo.inject(id, {
        kind: 'event',
        event: { type: 'assistant_text', delta: 'owner reply while disconnected', final: true }
      })
    }, collision)
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

    await showServer(win, savedB.id, b.cwd)
    await win.locator(`[data-sidebar-item-id="${kb}"]`).waitFor()
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
    assert.deepEqual(rendererErrors, [], 'desktop has no uncaught renderer errors')
    t.check('closing one colliding tab removes only its owning server tab', true)
    assert.ok(reconnectHistory.items.length > 0, 'owning live history survives reconnect')
    await showServer(win, savedA.id, a.cwd)
    await win.locator(`[data-sidebar-item-id="${ka}"]`).click()
    await win
      .locator(
        `[data-session-id="${ka}"] [data-testid="chat-view"] .chat-turn[data-role="assistant"]`
      )
      .filter({ hasText: 'owner reply while disconnected' })
      .waitFor()
    assert.ok(
      JSON.stringify(histories[0]).includes('message only for server A'),
      'live history contains the turn sent through this desktop'
    )
    t.check('owning live history and missed native turns catch up after reconnect', true)

    // Reboot the owning daemon on its originally held port and data directory.
    // No client-side adoption may spawn the persisted provider before Resume.
    const oldToken = a.token
    const oldServerId = a.serverId
    const savedDir = a.dir
    const savedPort = Number(new URL(a.url).port)
    await a.stop()
    a = await daemon('a-restarted', { dir: savedDir, port: savedPort })
    servers[0] = a
    assert.ok(a.token === oldToken, 'owning daemon retains its credential across restart')
    assert.ok(a.serverId === oldServerId, 'owning daemon retains its identity across restart')
    const launches = () =>
      readFileSync(providerLaunches, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    await check(
      () =>
        until(() => win.evaluate((id) => globalThis.fleetStatus[id] === 'connected', savedA.id)),
      'desktop reconnects to restarted owning daemon'
    )
    await check(
      () =>
        until(async () => {
          const snapshot = await win.evaluate(
            (id) => window.electronAPI.fleetSnapshot(id),
            savedA.id
          )
          return snapshot.sessions.some(
            (session) => session.id === providerKey && session.state === 'ended'
          )
        }),
      'persisted native provider is visible as stopped after server restart'
    )
    assert.equal(launches().length, 1, 'desktop did not implicitly restart the stopped provider')
    await showServer(win, savedA.id, a.cwd)
    await win.locator(`[data-sidebar-item-id="${providerKey}"]`).click()
    await win
      .locator(`[data-session-id="${providerKey}"]`)
      .getByRole('button', { name: 'Resume', exact: true })
      .click()
    await check(
      () => until(() => launches().some((entry) => entry.method === 'thread/resume')),
      'explicit Resume reaches original provider thread on owning server'
    )
    assert.equal(launches().filter((entry) => entry.method === 'thread/start').length, 1)
    assert.equal(launches().filter((entry) => entry.method === 'thread/resume').length, 1)
    assert.equal(
      launches().find((entry) => entry.method === 'thread/resume').threadId,
      providerThread
    )
    assert.deepEqual(rendererErrors, [], 'restart and Resume keep the renderer alive')
    await win.evaluate((id) => window.electronAPI.killSession(id), providerKey)
    t.check(
      'server restart retains stopped native tab without replay; explicit desktop Resume resumes original thread',
      true
    )
  } finally {
    if (app) await app.close()
    for (const server of servers.reverse()) await server.stop()
  }
}
