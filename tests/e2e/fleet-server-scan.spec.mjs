// Settings → Servers → Add lists the Mac's tailnet (PRDCT-4153, lane B of the
// server wave): the machines of `tailscale status --json`, read here from an
// invented status file under `--test-tailscale-status`, the ones answering
// as a Clave server on the scan's port marked (the harness's loopback daemon
// on `--test-scan-port`), a pick filling the name and the address, the
// token still pasted by hand. A tailnet whose Tailscale is stopped says so.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fixturePath } from './harness.mjs'
import { eventually, fleetWorld, openServersPage } from './fixtures/fleet-world.mjs'

const node = (id, hostName, ip, os, online) => ({
  ID: id,
  HostName: hostName,
  DNSName: `${hostName}.tail-example.ts.net.`,
  OS: os,
  TailscaleIPs: [ip, `fd7a:115c:a1e0::${id}`],
  Online: online
})

function status(backendState) {
  return {
    BackendState: backendState,
    Self: node('1', 'this-mac', '100.64.0.1', 'macOS', true),
    Peer: {
      key2: node('2', 'studio-mini', '127.0.0.1', 'macOS', true),
      key3: node('3', 'build-box', '127.0.0.2', 'linux', true),
      key4: node('4', 'old-laptop', '100.64.0.9', 'macOS', false)
    }
  }
}

export async function run(t) {
  const world = await fleetWorld('server-scan', { count: 1 })
  try {
    const [a] = world.servers
    const port = Number(new URL(a.url).port)
    const dir = fixturePath(`server-scan-${process.pid}-status`)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = path.join(dir, 'status.json')
    writeFileSync(file, JSON.stringify(status('Running')))

    const mac = await world.mac('a', {
      args: [`--test-tailscale-status=${file}`, `--test-scan-port=${port}`]
    })
    const { win } = mac
    await openServersPage(win)
    const page = win.locator('[data-settings-page="servers"]')
    await page.locator('[data-tailnet-scan-button]').click()
    const machine = (ip) => page.locator(`[data-tailnet-machine="${ip}"]`)
    await eventually(
      async () => (await machine('127.0.0.1').count()) === 1,
      'the scan lists the tailnet'
    )
    t.equal(
      'every machine with an address is listed',
      await page.locator('[data-tailnet-machine]').count(),
      3
    )
    t.equal(
      'the machine answering as a Clave server is marked',
      await machine('127.0.0.1').getAttribute('data-clave-server'),
      'true'
    )
    t.check(
      'the mark is the Clave server badge',
      await machine('127.0.0.1').getByText('Clave server', { exact: true }).isVisible()
    )
    t.equal(
      'an online machine with nothing on the port is not marked',
      await machine('127.0.0.2').getAttribute('data-clave-server'),
      null
    )
    t.check(
      'an offline machine says so and cannot be picked',
      (await machine('100.64.0.9').getByText('Offline', { exact: true }).isVisible()) &&
        (await machine('100.64.0.9').locator('[data-tailnet-use]').isDisabled())
    )
    t.equal(
      'online machines come first',
      await page.locator('[data-tailnet-machine]').last().getAttribute('data-tailnet-machine'),
      '100.64.0.9'
    )
    t.check(
      'the rows show the name, the address and the system',
      (await machine('127.0.0.1').innerText()).includes('studio-mini') &&
        (await machine('127.0.0.1').innerText()).includes('127.0.0.1 · macOS')
    )

    await machine('127.0.0.1').locator('[data-tailnet-use]').click()
    const nameInput = win.getByLabel('Server name', { exact: true })
    const urlInput = win.getByLabel('Server address', { exact: true })
    const tokenInput = win.getByLabel('Server bearer token', { exact: true })
    t.equal('a pick fills the name', await nameInput.inputValue(), 'studio-mini')
    t.equal(
      'a pick fills the address on the scan port',
      await urlInput.inputValue(),
      `http://127.0.0.1:${port}`
    )
    t.equal('the token stays to be pasted by hand', await tokenInput.inputValue(), '')
    t.check(
      'Add server waits for the token',
      await win.getByRole('button', { name: 'Add server', exact: true }).isDisabled()
    )
    await tokenInput.fill(a.token)
    await win.getByRole('button', { name: 'Add server', exact: true }).click()
    await eventually(
      async () => (await win.evaluate(() => window.electronAPI.fleetList())).length === 1,
      'the picked server is saved'
    )
    const [saved] = await win.evaluate(() => window.electronAPI.fleetList())
    const row = page.locator(`[data-server-id="${saved.id}"]`)
    await eventually(
      async () => (await row.locator('.status-text').innerText()) === 'Connected',
      'the picked server connects with the pasted token'
    )
    t.check('the token never appears in the page', !(await page.innerText()).includes(a.token))

    // Tailscale stopped: the scan says so instead of listing anything.
    writeFileSync(file, JSON.stringify(status('Stopped')))
    await page.locator('[data-tailnet-scan-button]').click()
    await page.locator('[data-tailnet-unavailable="not-running"]').waitFor()
    t.check(
      'a stopped Tailscale is said in one sentence',
      (await page.locator('[data-tailnet-unavailable]').innerText()).includes(
        'Tailscale is not running on this Mac'
      )
    )
    t.equal('and no machine is listed', await page.locator('[data-tailnet-machine]').count(), 0)

    assert.deepEqual(mac.errors, [])
  } finally {
    await world.close()
  }
}
