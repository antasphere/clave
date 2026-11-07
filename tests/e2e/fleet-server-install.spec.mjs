// "Run Clave as a server on this Mac" (PRDCT-4153, lane B of the server
// wave). The app runs the install script and reads what it leaves: the
// script here is a stand-in under `--test-install-script` that writes its
// phases, the saved options (`install.env`, pointing at the harness's own
// loopback daemon) and the daemon's identity file, under the test's config
// directory (`--test-install-config`) and never a service: nothing of the
// machine's own server install or launchd is read or written. Tailscale is
// read from a stopped status, so the address is loopback. The page shows
// the phases, adds the server to this Mac's list, which connects for real,
// offers the token to copy (landing on the test hooks, never the clipboard,
// never the page) and shows the service running with its version. A second
// run with a failing stand-in shows the fixed sentence of its code, its
// exit and the log, and nothing the script printed.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { REPO, fixturePath } from './harness.mjs'
import { eventually, fleetWorld, openServersPage } from './fixtures/fleet-world.mjs'

const CANARY = 'standin-canary-k4m2p'

function standIn(dir, server) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const record = path.join(dir, 'calls.txt')
  const failMarker = path.join(dir, 'fail')
  const dataDir = path.join(dir, 'data')
  const script = path.join(dir, 'install-server.sh')
  writeFileSync(
    script,
    [
      '#!/bin/bash',
      'set -u',
      `printf '%s\\n' "$*" >> ${JSON.stringify(record)}`,
      `printf 'env XDG_CONFIG_HOME=%s\\n' "\${XDG_CONFIG_HOME:-}" >> ${JSON.stringify(record)}`,
      '[[ -n "${CLAVE_INSTALL_STATUS_FILE:-}" ]] || exit 9',
      'printf \'phase=resolve\\n\' >> "$CLAVE_INSTALL_STATUS_FILE"; sleep 0.7',
      'printf \'phase=build\\n\' >> "$CLAVE_INSTALL_STATUS_FILE"; sleep 0.7',
      `if [[ -f ${JSON.stringify(failMarker)} ]]; then`,
      `  printf '%s\\n' 'code=build-incomplete' ${JSON.stringify(`code=${CANARY}`)} >> "$CLAVE_INSTALL_STATUS_FILE"`,
      `  echo '${CANARY} the build broke' >&2`,
      '  exit 3',
      'fi',
      'printf \'phase=service\\n\' >> "$CLAVE_INSTALL_STATUS_FILE"',
      `mkdir -p "$XDG_CONFIG_HOME/clave-server" ${JSON.stringify(path.join(dataDir, 'daemon'))}`,
      `printf 'CLAVE_URL=%q\\nCLAVE_DATA_DIR=%q\\n' ${JSON.stringify(server.url)} ${JSON.stringify(dataDir)} > "$XDG_CONFIG_HOME/clave-server/install.env"`,
      `cp ${JSON.stringify(path.join(server.dataDir, 'daemon', 'identity.json'))} ${JSON.stringify(path.join(dataDir, 'daemon', 'identity.json'))}`,
      `chmod 600 ${JSON.stringify(path.join(dataDir, 'daemon', 'identity.json'))}`,
      'printf \'phase=health\\n\' >> "$CLAVE_INSTALL_STATUS_FILE"; sleep 0.3',
      'exit 0',
      ''
    ].join('\n')
  )
  chmodSync(script, 0o755)
  return { script, record, failMarker, dataDir }
}
const calls = (record) =>
  existsSync(record) ? readFileSync(record, 'utf8').split('\n').filter(Boolean) : []

export async function run(t) {
  const world = await fleetWorld('server-install', { count: 1 })
  try {
    const [server] = world.servers
    const base = fixturePath(`server-install-${process.pid}`)
    const { script, record, failMarker } = standIn(path.join(base, 'stand-in'), server)
    const configDir = path.join(base, 'config')
    mkdirSync(configDir, { recursive: true, mode: 0o700 })
    // Tailscale up for the first install (the address is chosen then), stopped
    // for the second (the saved address must stay): the file is read each time.
    const statusFile = path.join(base, 'tailscale.json')
    const tailscale = (state) =>
      writeFileSync(
        statusFile,
        JSON.stringify({
          BackendState: state,
          Self: { HostName: 'this-mac', TailscaleIPs: ['100.64.0.1'], Online: true },
          Peer: {}
        })
      )
    tailscale('Running')

    const mac = await world.mac('a', {
      args: [
        `--test-install-script=${script}`,
        `--test-install-config=${configDir}`,
        `--test-tailscale-status=${statusFile}`
      ]
    })
    const { win } = mac
    await openServersPage(win)
    const page = win.locator('[data-settings-page="servers"]')
    const card = page.locator('[data-this-mac-server]')
    await card.waitFor()
    t.equal(
      'this Mac starts with no server installed',
      await card.getAttribute('data-install-state'),
      'not-installed'
    )
    t.check(
      "with Tailscale up the page names this Mac's tailnet address",
      (await card.innerText()).includes("listens on this Mac's Tailscale address, 100.64.0.1")
    )
    // Every progress event the window hears, kept to prove none carries the token.
    await win.evaluate(() => {
      window.__installProgress = []
      window.electronAPI.onServerSetupProgress((p) =>
        window.__installProgress.push(JSON.stringify(p))
      )
    })
    await card.locator('[data-install-server]').click()
    t.check(
      'the install warns what it does before running anything',
      (await card.innerText()).includes(
        'installs the standalone Clave server as a background service'
      )
    )
    t.equal('nothing runs before the confirmation', calls(record).length, 0)
    await card.locator('[data-install-confirm]').click()

    // The phases the script writes reach the page as it goes.
    const phases = new Set()
    for (let i = 0; i < 80 && (await card.getAttribute('data-install-state')) !== 'running'; i++) {
      const phase = await card
        .locator('[data-install-phase]')
        .getAttribute('data-install-phase')
        .catch(() => null)
      if (phase) phases.add(phase)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    await eventually(
      async () => (await card.getAttribute('data-install-state')) === 'running',
      'the install ends with the service running'
    )
    t.check(
      'the page followed the phases the script wrote',
      phases.has('build'),
      [...phases].join(',')
    )
    t.equal(
      "the first install gives the script this Mac's tailnet address, and nothing else",
      calls(record)
        .filter((line) => !line.startsWith('env '))
        .join('|'),
      '--host 100.64.0.1'
    )
    const progress = await win.evaluate(() => window.__installProgress)
    t.check(
      'the phases reached the window as events, none carrying the token',
      progress.some((p) => p.includes('"build"')) &&
        progress.some((p) => p.includes('"done"')) &&
        !progress.some((p) => p.includes(server.token)),
      progress.join(' ')
    )
    t.equal(
      'the script wrote under the test config directory',
      calls(record).find((line) => line.startsWith('env ')),
      `env XDG_CONFIG_HOME=${configDir}`
    )
    t.equal(
      'the address is the one the script saved',
      (await card.locator('[data-install-url]').innerText()).trim(),
      server.url
    )
    t.equal(
      'the service reads running',
      await card.locator('[data-install-service]').getAttribute('data-install-service'),
      'running'
    )

    // The server is on this Mac's list, connected with the token read from the identity file.
    await eventually(
      async () => (await win.evaluate(() => window.electronAPI.fleetList())).length === 1,
      "the installed server is added to this Mac's list"
    )
    const [saved] = await win.evaluate(() => window.electronAPI.fleetList())
    t.equal('the saved connection points at the installed server', saved.url, server.url)
    const row = page.locator(`[data-server-id="${saved.id}"]`)
    await eventually(
      async () => (await row.locator('.status-text').innerText()) === 'Connected',
      'the installed server connects'
    )
    // The harness's daemon was not installed by the script, so its line says
    // it does not upgrade from the Mac; the version itself is the checkout's.
    const { version } = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8'))
    await eventually(
      async () => (await card.innerText()).includes(`Version ${version} ·`),
      'the service line shows the version read from the server'
    )

    // The token is offered to copy and never shown.
    await card.locator('[data-install-copy-token]').click()
    await eventually(
      async () => (await card.locator('[data-install-copy-token]').innerText()) === 'Copied',
      'Copy token says it copied'
    )
    t.check(
      "what was copied is the server's token",
      await mac.app.evaluate(
        (_electron, token) => globalThis.__claveE2E?.serverSetup?.copiedToken === token,
        server.token
      )
    )
    t.check('the token never appears in the page', !(await page.innerText()).includes(server.token))
    const log = path.join(mac.dir, 'server-install', 'install.log')
    t.check(
      "the run was logged under the app's own data, without the token",
      existsSync(log) &&
        readFileSync(log, 'utf8').includes('--host 100.64.0.1') &&
        !readFileSync(log, 'utf8').includes(server.token)
    )

    // A failed run: the fixed sentence of the code, the exit and the log, nothing the script printed.
    // Install again, with Tailscale stopped meanwhile: the saved address is
    // kept (the script gets no host), and the answer carries no token.
    tailscale('Stopped')
    const again = await win.evaluate(() => window.electronAPI.serverSetupInstall())
    t.check(
      'a second install succeeds and answers the server and its state, never the token',
      again.ok === true &&
        again.url === server.url &&
        !JSON.stringify(again).includes(server.token),
      JSON.stringify(again).includes(server.token) ? 'token in the answer' : JSON.stringify(again)
    )
    // The stand-in records one `env` line per run and the arguments it got:
    // the second run brought none (an empty line, dropped by the reader).
    t.equal(
      'a later install keeps the saved address: the script gets no host',
      JSON.stringify({
        runs: calls(record).filter((line) => line.startsWith('env ')).length,
        args: calls(record).filter((line) => !line.startsWith('env '))
      }),
      JSON.stringify({ runs: 2, args: ['--host 100.64.0.1'] })
    )

    writeFileSync(failMarker, '')
    t.check(
      'an installed Mac offers to install again',
      (await card.locator('[data-install-server]').innerText()) === 'Install again'
    )
    await card.locator('[data-install-server]').click()
    await card.locator('[data-install-confirm]').click()
    const alert = card.locator('[role="alert"]')
    await alert.waitFor()
    t.equal(
      'the failure is the fixed sentence of the code, then the exit and the log',
      await alert.locator('.settings-callout-text').innerText(),
      `The build of the latest release did not produce the server.\nExit 3. Full log: ${log}`
    )
    t.check(
      'nothing the script printed reaches the page',
      !(await page.innerText()).includes(CANARY)
    )
    t.check(
      'the failed run is in the log',
      readFileSync(log, 'utf8').includes(`${CANARY} the build broke`)
    )
    t.equal(
      'the server list is unchanged by the failed run',
      (await win.evaluate(() => window.electronAPI.fleetList())).length,
      1
    )

    assert.deepEqual(mac.errors, [])
  } finally {
    await world.close()
  }
}
