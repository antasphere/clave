import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { bunBinary } from '../../../scripts/server-process.mjs'
import { namespaceOf } from '../namespace.mjs'
import { observeDaemon } from './fleet-http-observer.mjs'
import {
  REPO,
  fixturePath,
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  startE2eServer,
  serverFixture,
  until
} from '../harness.mjs'

export const owned = (kind, owner, id) =>
  `clave-owner:${kind}:${encodeURIComponent(owner)}:${encodeURIComponent(id)}`
export async function eventually(fn, message) {
  assert.ok(await until(fn, { tries: 120, gapMs: 100 }), message)
}
export async function step(name, action) {
  const started = performance.now()
  console.log(JSON.stringify({ step: name, state: 'begin' }))
  try {
    const value = await action()
    console.log(
      JSON.stringify({ step: name, state: 'complete', ms: Math.round(performance.now() - started) })
    )
    return value
  } catch (error) {
    console.error(
      JSON.stringify({ step: name, state: 'failed', ms: Math.round(performance.now() - started) })
    )
    throw error
  }
}
export async function clickReady(locator) {
  await locator.waitFor({ state: 'visible' })
  let previous
  let stable = 0
  await eventually(async () => {
    if (!(await locator.isEnabled())) return false
    const box = await locator.boundingBox()
    const current = box && JSON.stringify(box)
    stable = current && current === previous ? stable + 1 : 0
    previous = current
    return stable >= 2
  }, 'intended control has a stable visible layout')
  // Keep Playwright's normal hit-target/actionability checks enabled.
  await locator.click()
}
export async function ownerReady(mac, owner, session) {
  const row = mac.win.locator(`[data-sidebar-item-id="${session}"]`)
  await eventually(async () => {
    try {
      const snapshot = await mac.win.evaluate((id) => window.electronAPI.fleetSnapshot(id), owner)
      return snapshot.sessions.some((s) => s.id === session)
    } catch {
      return false
    }
  }, 'fresh owner snapshot contains the intended session')
  await eventually(
    async () =>
      (await row.locator('[data-fleet-owner]').getAttribute('data-fleet-state')) === 'connected',
    'intended owner is connected in the renderer'
  )
}
export async function request(server, route, body) {
  const response = await fetch(server.url + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000)
  })
  assert.ok(
    response.status === 200 || response.status === 204,
    `${route} on owning server answered ${response.status}`
  )
  if (response.status === 204) return undefined
  return response.json()
}

export async function fleetWorld(label) {
  const run = `${label}-${randomUUID()}`
  const servers = []
  const clients = new Set()
  const observers = []
  const seedProfiles = (dir) => {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(
      path.join(dir, 'agent-launch-profiles.json'),
      JSON.stringify({
        version: 1,
        customProfiles: [
          {
            id: 'fleet-title-fixture',
            name: 'Fleet title fixture',
            family: 'claude',
            command: [process.execPath, path.join(REPO, 'tests/e2e/fixtures/fleet-title.mjs')],
            additionalArgs: []
          }
        ],
        globalDefaults: { claude: 'fleet-title-fixture' },
        workspaceOverrides: {}
      }),
      { mode: 0o600 }
    )
  }
  const seed = fixturePath(`${run}-settings`)
  seedProfiles(seed)
  const options = {
    env: { SHELL: '/bin/sh' },
    seedFrom: seed,
    args: ['--daemon', '--host', '127.0.0.1', '--test-no-activate', '--dev-echo-adapter']
  }
  const world = {
    run,
    servers,
    async observeFiles() {
      for (const server of servers) {
        const observer = await observeDaemon(server.url)
        observers.push(observer)
        server.desktopUrl = observer.url
      }
      return observers
    },
    async restart(index) {
      const old = servers[index]
      await old.stop()
      const next = await startE2eServer(`${run}-${index}`, {
        ...options,
        keep: true,
        port: Number(new URL(old.url).port)
      })
      Object.assign(old, next)
      old.fixture = serverFixture(next.url, next.token)
      return old
    },
    load({
      enabled = true,
      generation = 'one',
      receipt = fixturePath(`${run}-${generation}-${randomUUID()}-receipt.json`)
    } = {}) {
      const input = {
        enabled,
        namespace: namespaceOf(),
        receipt,
        owners: servers.map((s) => ({ url: s.url, token: s.token, root: s.root }))
      }
      const child = spawnSync(
        bunBinary(process.env, REPO),
        [path.join(REPO, 'tests/e2e/fixtures/personal-fleet.mjs'), '--load'],
        {
          cwd: REPO,
          input: JSON.stringify(input),
          encoding: 'utf8',
          timeout: 45_000,
          env: { ...process.env, SHELL: '/bin/sh' }
        }
      )
      if (!enabled) {
        assert.equal(child.status, 1)
        return null
      }
      const diagnostic = servers.reduce(
        (message, server) => message.replaceAll(server.token, '[redacted]'),
        child.stderr ?? ''
      )
      assert.equal(
        child.status,
        0,
        `fixture load failed, inspect its private progress receipt: ${diagnostic}`
      )
      const report = JSON.parse(readFileSync(receipt, 'utf8'))
      assert.equal(report.completed.length, 3)
      world.report = report
      console.log(
        JSON.stringify({ scenario: report.scenario, runId: report.runId, receipt, ids: report.ids })
      )
      return report
    },
    async mac(label, { reuse = null } = {}) {
      const dir = reuse ?? fixturePath(`${run}-mac-${label}`)
      const root = fixturePath(`${run}-local-${label}`)
      mkdirSync(root, { recursive: true })
      if (!reuse) {
        seedWorkspaces(dir, {
          workspaces: [
            {
              id: `mac-${label}`,
              name: `Mac ${label}`,
              rootDir: root,
              profileFile: null,
              createdAt: 1
            }
          ],
          activeWorkspaceId: `mac-${label}`,
          fresh: true
        })
        seedTrustedRoots(dir, [root])
        seedProfiles(dir)
      }
      const launched = await launchApp(dir, {
        server: 'in-process',
        env: { SHELL: '/bin/sh' },
        args: ['--dev-echo-adapter']
      })
      const mac = { ...launched, dir, root, owners: [], errors: [] }
      launched.win.on('pageerror', (error) => mac.errors.push(error.message))
      clients.add(mac)
      mac.close = async () => {
        clients.delete(mac)
        await mac.app.close()
      }
      assert.equal(
        await mac.app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().some((w) => w.isVisible())
        ),
        false
      )
      return mac
    },
    async close() {
      try {
        for (const mac of clients) await mac.close()
      } finally {
        try {
          for (const observer of observers) await observer.close()
        } finally {
          for (const server of [...servers].reverse()) await server.stop()
        }
      }
    }
  }
  try {
    for (let index = 0; index < 2; index++) {
      const server = await startE2eServer(`${run}-${index}`, options)
      servers.push(server)
      server.root = path.join(server.dataDir, 'repo')
      mkdirSync(server.root, { recursive: true })
      server.fixture = serverFixture(server.url, server.token)
    }
    return world
  } catch (error) {
    await world.close()
    throw error
  }
}

export async function connectMac(mac, servers, { ui = true } = {}) {
  const { win } = mac
  if (ui) await win.getByLabel('Manage Clave servers', { exact: true }).click()
  for (const [index, server] of servers.entries()) {
    const name = `Personal VPS ${index + 1}`
    if (ui) {
      await win.getByLabel('Server name', { exact: true }).fill(name)
      await win.getByLabel('Server address', { exact: true }).fill(server.desktopUrl ?? server.url)
      await win.getByLabel('Server bearer token', { exact: true }).fill(server.token)
      await win.getByRole('button', { name: 'Add server', exact: true }).click()
      await eventually(
        async () => (await win.evaluate(() => window.electronAPI.fleetList())).length === index + 1,
        'saved server appears'
      )
      assert.equal(await win.getByLabel('Server bearer token', { exact: true }).inputValue(), '')
    } else {
      await win.evaluate(
        ({ name, url, token }) => window.electronAPI.fleetSave({ name, url, token }),
        { name, url: server.desktopUrl ?? server.url, token: server.token }
      )
    }
  }
  if (ui) await win.getByRole('button', { name: 'Close', exact: true }).click()
  mac.owners = await win.evaluate(() => window.electronAPI.fleetList())
  assert.ok(mac.owners.every((o) => !('token' in o)))
  for (const owner of mac.owners)
    await eventually(async () => {
      try {
        return !!(await win.evaluate((id) => window.electronAPI.fleetSnapshot(id), owner.id))
      } catch {
        return false
      }
    }, 'saved owner connects')
}
