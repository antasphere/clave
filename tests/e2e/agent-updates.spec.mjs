// The agent updater in the running app (PRDCT-2927): Clave keeps the agent
// CLIs it launches on their latest release, through the installer that owns
// each one, and the app never waits on it.
//
// The machine's own agents are never touched. Two test-only seams (honoured
// under --test-no-activate only, `src/main/agent-updates/index.ts`) point the
// updater at a fixture PATH and at a local registry: `pi` is a fake bun global
// whose fake `bun` sleeps like a real install, then moves the version; `codex`
// sits outside any installer Clave knows, far behind its registry's latest,
// and must never be run by anything but `--version`.
//
// What goes red when it breaks: a check that upgrades with automatic updates
// off, an upgrade that runs the wrong command or runs twice, an install Clave
// cannot identify being touched, the app freezing while an installer runs,
// the timers firing in test mode, and the switch not persisting.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import {
  callMcp,
  fixturePath,
  launchApp,
  seedTrustedRoots,
  seedWorkspaces,
  until,
  userDataDir
} from './harness.mjs'

const INSTALL_SECONDS = 4

function fixture(root) {
  rmSync(root, { recursive: true, force: true })
  const bin = path.join(root, 'bin')
  const pkg = path.join(root, 'home/.bun/install/global/node_modules/@clave-e2e/pi')
  const tools = path.join(root, 'tools')
  for (const dir of [bin, pkg, tools]) mkdirSync(dir, { recursive: true })
  const version = path.join(root, 'pi-version')
  const next = path.join(root, 'pi-next')
  const calls = path.join(root, 'calls.log')
  writeFileSync(version, '0.1.0\n')
  writeFileSync(next, '0.2.0\n')
  const script = (file, body) => {
    writeFileSync(file, `#!/bin/sh\n${body}\n`)
    chmodSync(file, 0o755)
  }
  script(path.join(pkg, 'cli.sh'), `/bin/cat '${version}'`)
  symlinkSync(path.join(pkg, 'cli.sh'), path.join(bin, 'pi'))
  script(
    path.join(bin, 'bun'),
    `echo "bun $*" >> '${calls}'\n/bin/sleep ${INSTALL_SECONDS}\n/bin/cat '${next}' > '${version}'`
  )
  script(
    path.join(tools, 'codex'),
    `if [ "$1" = "--version" ]; then echo "codex-cli 0.1.0"; else echo "codex $*" >> '${calls}'; fi`
  )
  symlinkSync(path.join(tools, 'codex'), path.join(bin, 'codex'))
  return { bin, next, calls }
}

function registry(tags) {
  const server = createServer((req, res) => {
    const name = decodeURIComponent(req.url.replace('/-/package/', '').replace('/dist-tags', ''))
    const answer = tags[name]
    res.writeHead(answer ? 200 : 404, { 'content-type': 'application/json' })
    res.end(JSON.stringify(answer ?? {}))
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  )
}

async function openSoftwareUpdate(win) {
  await win.evaluate(() =>
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', metaKey: true, bubbles: true }))
  )
  await win.waitForTimeout(600)
  await win.getByRole('button', { name: 'Software Update' }).first().click()
  await win.waitForTimeout(400)
}

const statusOf = (win, id) =>
  win
    .locator(`[data-agent-update-status="${id}"]`)
    .first()
    .innerText()
    .catch(() => null)

const callLines = (calls) =>
  existsSync(calls) ? readFileSync(calls, 'utf-8').trim().split('\n').filter(Boolean) : []

async function waitFor(fn, timeoutMs = 20_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true
    await new Promise((r) => setTimeout(r, 150))
  }
  return false
}

export async function run(t) {
  await settingsAndInstallers(t)
  await restartHint(t)
}

async function settingsAndInstallers(t) {
  const root = fixturePath('agent-updates-fixture')
  const { bin, next, calls } = fixture(root)
  const tags = { '@clave-e2e/pi': { latest: '0.2.0' }, '@openai/codex': { latest: '9.9.9' } }
  const { server, port } = await registry(tags)
  const dir = userDataDir('agent-updates')
  const { app, win } = await launchApp(dir, {
    env: {
      CLAVE_TEST_AGENT_PATH: bin,
      CLAVE_TEST_NPM_REGISTRY: `http://127.0.0.1:${port}`
    }
  })

  try {
    // --- Nothing runs on its own in test mode ---
    const boot = await win.evaluate(() => window.electronAPI.getAgentUpdates())
    t.equal('automatic updates are on by default', boot?.autoUpdate, true)
    t.equal('four agents are tracked', boot?.agents?.length, 4)
    t.check(
      'no check ran at boot under test mode',
      boot?.agents?.every((a) => a.lastCheckedAt === null),
      boot?.agents?.map((a) => a.lastCheckedAt)
    )

    // --- Off: a check only says ---
    await win.evaluate(() => window.electronAPI.setAgentAutoUpdate(false))
    const prefs = JSON.parse(readFileSync(path.join(dir, 'preferences.json'), 'utf-8'))
    t.equal('the switch persists', prefs.agentAutoUpdate, false)

    await openSoftwareUpdate(win)
    await win.locator('[data-agent-updates-check]').click()
    t.check(
      'the check finds Pi behind and says so',
      await waitFor(async () => (await statusOf(win, 'pi')) === '0.2.0 is available'),
      await statusOf(win, 'pi')
    )
    t.equal(
      'Claude, absent from the PATH, reads not installed',
      await statusOf(win, 'claude'),
      'Not installed'
    )
    t.check(
      'Codex, from no installer Clave knows, is left to itself',
      /leaves its updates to it/.test((await statusOf(win, 'codex')) ?? ''),
      await statusOf(win, 'codex')
    )
    t.equal(
      'Codex offers no Update button',
      await win.locator('[data-agent-update-button="codex"]').count(),
      0
    )
    t.equal('with automatic updates off, the check installed nothing', callLines(calls).length, 0)

    // --- The button: the owning installer, once, and the app keeps working ---
    // A main process blocked on the installer shows in two places. The click
    // first: in Electron the main process is the browser's UI thread, and a
    // click is acknowledged there, so it cannot return while main is stuck
    // (and Playwright runs this page's later commands behind it). Then every
    // 100 ms until the upgrade lands, an IPC round trip, which needs main's
    // event loop; app.evaluate cannot stand in for it, since the inspector
    // behind it interrupts a busy main thread and answers anyway.
    const clickStart = Date.now()
    await win.locator('[data-agent-update-button="pi"]').click()
    const clickMs = Date.now() - clickStart
    t.check(
      'the click on Update returns at once, main not held by the installer',
      clickMs < 1500,
      clickMs
    )
    const lags = []
    let sawUpdating = 0
    let sawRow = false
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      const start = Date.now()
      const state = await win.evaluate(() => window.electronAPI.getAgentUpdates())
      lags.push(Date.now() - start)
      const pi = state.agents.find((a) => a.id === 'pi')
      if (pi?.phase === 'updating') sawUpdating++
      if (!sawRow) sawRow = (await statusOf(win, 'pi')) === 'Updating to 0.2.0…'
      if (pi?.currentVersion === '0.2.0' && pi.phase === 'idle') break
      await new Promise((r) => setTimeout(r, 100))
    }
    t.check('the samples cover the install, taken while the installer ran', sawUpdating >= 10, {
      sawUpdating,
      samples: lags.length
    })
    t.check('the row said it was updating', sawRow)
    t.check(
      'while the installer runs, the main process answers the window in under 250 ms',
      Math.max(...lags) < 250,
      lags
    )
    t.check(
      'the upgrade lands and the row says what moved',
      await waitFor(async () => /^Updated from 0\.1\.0 /.test((await statusOf(win, 'pi')) ?? '')),
      await statusOf(win, 'pi')
    )
    const afterButton = await win.evaluate(() => window.electronAPI.getAgentUpdates())
    t.equal(
      'Pi now reports the new version',
      afterButton.agents.find((a) => a.id === 'pi')?.currentVersion,
      '0.2.0'
    )
    t.check(
      'the owning installer ran exactly once, with the package at latest',
      JSON.stringify(callLines(calls)) === JSON.stringify(['bun add -g @clave-e2e/pi@latest']),
      callLines(calls)
    )

    // --- On: a check that finds a newer release installs it by itself ---
    tags['@clave-e2e/pi'] = { latest: '0.3.0' }
    writeFileSync(next, '0.3.0\n')
    await win.evaluate(() => window.electronAPI.setAgentAutoUpdate(true))
    await win.evaluate(() => window.electronAPI.checkAgentUpdates())
    const afterAuto = await win.evaluate(() => window.electronAPI.getAgentUpdates())
    t.equal(
      'with automatic updates on, the check upgraded Pi by itself',
      afterAuto.agents.find((a) => a.id === 'pi')?.currentVersion,
      '0.3.0'
    )
    t.equal('the second upgrade is the second install, not a third', callLines(calls).length, 2)
    t.check(
      'Codex was never run for anything but its version',
      !callLines(calls).some((line) => line.startsWith('codex')),
      callLines(calls)
    )
  } finally {
    await app.close()
    server.close()
    rmSync(root, { recursive: true, force: true })
  }
}

// A tab started before its agent was upgraded offers a restart onto the new
// release, and the restart keeps the tab's account: the tab's "claude" is a
// stand-in that prints the token its process got, read off the session.
async function restartHint(t) {
  const root = fixturePath('agent-updates-hint-agents')
  const ws = fixturePath('agent-updates-hint-ws')
  const dir = userDataDir('agent-updates-hint')
  rmSync(root, { recursive: true, force: true })
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(ws, { recursive: true })
  const bin = path.join(root, 'bin')
  const versions = path.join(root, 'home/.local/share/claude/versions')
  mkdirSync(bin, { recursive: true })
  mkdirSync(versions, { recursive: true })
  const version = path.join(root, 'claude-version')
  writeFileSync(version, '1.0.0 (Claude Code)\n')
  const claude = path.join(versions, '1.0.0')
  writeFileSync(
    claude,
    `#!/bin/sh\nif [ "$1" = "update" ]; then echo "1.0.1 (Claude Code)" > '${version}'; else /bin/cat '${version}'; fi\n`
  )
  chmodSync(claude, 0o755)
  symlinkSync(claude, path.join(bin, 'claude'))
  const release = { latest: '1.0.1', stable: '1.0.1' }
  const { server, port } = await registry({ '@anthropic-ai/claude-code': release })
  const WS = { id: 'hint-ws', name: 'Hint', rootDir: ws, profileFile: null, createdAt: 1 }
  seedWorkspaces(dir, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(dir, [ws])
  const TOKEN = 'sk-ant-oat01-hint-token-for-the-agent-updates-run-0123456789'
  const { app, win } = await launchApp(dir, {
    env: { CLAVE_TEST_AGENT_PATH: bin, CLAVE_TEST_NPM_REGISTRY: `http://127.0.0.1:${port}` }
  })
  try {
    await win.evaluate(
      async ({ workspaceId, TOKEN }) => {
        await window.electronAPI.launchProfileUpsert({
          id: 'e2e-claude-token',
          name: 'token',
          family: 'claude',
          command: [
            'sh',
            '-c',
            'printf "TOKEN=[%s]\\n" "$CLAUDE_CODE_OAUTH_TOKEN"; sleep 300',
            'claude'
          ],
          additionalArgs: []
        })
        await window.electronAPI.launchProfileSetWorkspace(
          workspaceId,
          'claude',
          'e2e-claude-token'
        )
        const work = await window.electronAPI.claudeAccountAdd({ label: 'Work' })
        await window.electronAPI.claudeAccountSetToken(work.id, TOKEN)
        await window.electronAPI.setAgentAutoUpdate(false)
      },
      { workspaceId: WS.id, TOKEN }
    )
    await win.reload()
    await until(async () => {
      try {
        return await callMcp(app, 'list', {})
      } catch {
        return false
      }
    })
    const tab = await callMcp(app, 'openSession', {
      cwd: ws,
      mode: 'claude',
      account: 'Work',
      name: 'Hinted'
    })
    await callMcp(app, 'focus', { sessionId: tab.sessionId })
    const tokens = async () => {
      const read = await callMcp(app, 'readSession', {
        sessionId: tab.sessionId,
        lines: 200,
        callerSessionId: tab.sessionId
      })
      return [...(read?.text ?? '').matchAll(/TOKEN=\[([^\]]*)\]/g)].map((m) => m[1])
    }
    t.check(
      'the tab started on its account',
      !!(await until(async () => (await tokens()).includes(TOKEN), { tries: 60, gapMs: 250 })),
      await tokens()
    )
    const hint = win.locator('[data-agent-update-hint="claude"]')
    t.equal('no hint before any upgrade', await hint.count(), 0)

    await win.evaluate(() => window.electronAPI.checkAgentUpdates())
    const updated = await win.evaluate(() => window.electronAPI.updateAgent('claude'))
    t.equal(
      "Claude's installer moved it",
      updated.agents.find((a) => a.id === 'claude')?.currentVersion,
      '1.0.1'
    )
    t.check(
      'the older tab shows the restart hint',
      !!(await until(async () => (await hint.count()) > 0, { tries: 40, gapMs: 150 })),
      await hint.count()
    )
    t.check(
      'the hint names the new release',
      /Claude 1\.0\.1/.test(
        (await hint
          .first()
          .innerText()
          .catch(() => '')) ?? ''
      ),
      await hint
        .first()
        .innerText()
        .catch(() => null)
    )
    const before = (await tokens()).length
    await win.locator('[data-agent-update-restart]').first().click()
    const after = await until(
      async () => {
        const all = await tokens()
        return all.length > before || (all.length > 0 && (await hint.count()) === 0 && all)
          ? all
          : null
      },
      { tries: 60, gapMs: 250 }
    )
    t.check('the tab restarted', !!after, after)
    t.equal('the restarted process kept the account', after?.at(-1), TOKEN)
    t.check(
      'the hint is gone once the tab runs the new release',
      !!(await until(async () => (await hint.count()) === 0, { tries: 20, gapMs: 150 })),
      await hint.count()
    )
  } finally {
    await app.close()
    server.close()
    rmSync(root, { recursive: true, force: true })
  }
}
