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
import { launchApp, userDataDir } from './harness.mjs'

const INSTALL_SECONDS = 3

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
  const root = '/tmp/clave-e2e-agent-updates-fixture'
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
    await win.locator('[data-agent-update-button="pi"]').click()
    t.check(
      'the row says it is updating',
      await waitFor(async () => (await statusOf(win, 'pi')) === 'Updating to 0.2.0…', 3000),
      await statusOf(win, 'pi')
    )
    const lags = []
    for (let i = 0; i < 10; i++) {
      const start = Date.now()
      await win.evaluate(() => document.title)
      await app.evaluate(() => process.uptime())
      lags.push(Date.now() - start)
      await new Promise((r) => setTimeout(r, 150))
    }
    t.check(
      'while the installer runs, the window and the main process answer in under 250 ms',
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
