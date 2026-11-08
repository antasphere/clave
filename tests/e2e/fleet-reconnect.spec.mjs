/**
 * The agent tools follow a server's connection as the window does, a
 * reconnect made in Settings reaches them without an app restart, and a
 * failed connection says why in the main log (PRDCT-4165). On the fleet
 * harness: one standalone server, stopped when the Mac saves it, started
 * again later; two windows of the Mac, the second one the caller of the
 * tools, the first the one where Settings is used.
 *
 * Fails if: the tools answer a transport error instead of the window's own
 * words for an unreachable server, the main log carries no line saying why,
 * the server coming back is not reached again without a click, or a
 * disconnect and a reconnect made in one window leave the tools of another
 * window on the old state until a restart (what 7 November 2026 showed).
 */
import assert from 'node:assert/strict'
import { fleetWorld, openServersPage } from './fixtures/fleet-world.mjs'
import { callMcpIn, openWindow, until } from './harness.mjs'

/** `until` over a longer window: a dead server is said offline after the
 *  client's 10 s welcome deadline, and reached again within its socket's
 *  10 s backoff cap once it listens. */
const slowly = (fn, message) =>
  until(fn, { tries: 240, gapMs: 250 }).then((value) => {
    assert.ok(value, message)
    return value
  })

export async function run(t) {
  const world = await fleetWorld('reconnect', { count: 1 })
  try {
    const [server] = world.servers
    const token = server.token
    const mac = await world.mac('a')
    const { win, app } = mac
    const fleetLog = () => app.evaluate(() => globalThis.__claveE2E?.fleetLog ?? [])
    const listedState = async (windowId, serverId) => {
      const list = await callMcpIn(app, windowId, 'list', {})
      return list.servers.find((s) => s.id === serverId)?.state ?? null
    }
    const openOn = (windowId, serverId) =>
      callMcpIn(app, windowId, 'openSession', {
        server: serverId,
        cwd: server.root,
        mode: 'terminal',
        name: `opened from window ${windowId}`
      })
    const windowA = await app.evaluate(({ BrowserWindow }) =>
      Math.min(...BrowserWindow.getAllWindows().map((w) => w.id))
    )

    // ── The server is down when this Mac saves it ──
    await server.stop()
    const saved = await win.evaluate(
      ({ url, token }) => window.electronAPI.fleetSave({ name: 'Studio', url, token }),
      { url: server.url, token }
    )
    await openServersPage(win)
    const row = win.locator(`[data-server-id="${saved.id}"]`)
    await slowly(
      async () => (await row.locator('.status-text').innerText()) === 'Unreachable',
      'the window says the server is unreachable'
    )
    t.equal(
      'the agent tools list the server in the state the window shows',
      await listedState(windowA, saved.id),
      'offline'
    )
    const refused = await openOn(windowA, saved.id).then(
      () => null,
      (error) => error.message
    )
    t.check(
      'opening a tab there is refused in the window’s own words, the reason included',
      typeof refused === 'string' &&
        refused.includes('Studio is Unreachable') &&
        refused.includes('did not answer at this address'),
      refused
    )
    const offlineLine = (await fleetLog()).find(
      (line) => line.includes(`Studio (${saved.id})`) && line.includes('offline')
    )
    t.check(
      'the main log says why the connection failed',
      !!offlineLine && offlineLine.includes('unreachable'),
      await fleetLog()
    )
    t.check('and never the token', !(await fleetLog()).some((line) => line.includes(token)))

    // ── A second window: the caller of the tools from here on ──
    const { page: winB, windowId: windowB } = await openWindow(app, win)
    assert.notEqual(windowB, windowA)
    t.equal(
      'a window opened meanwhile holds the same state',
      await slowly(
        async () => ((await listedState(windowB, saved.id)) === 'offline' ? 'offline' : null),
        'window B says offline'
      ),
      'offline'
    )

    // ── The server comes back: reached again with no click, in both windows ──
    await world.restart(0)
    assert.equal(world.servers[0].token, token, 'the restarted server keeps its token')
    await slowly(
      async () => (await listedState(windowA, saved.id)) === 'connected',
      'window A reaches the server again by itself'
    )
    await slowly(
      async () => (await listedState(windowB, saved.id)) === 'connected',
      'window B reaches the server again by itself'
    )
    t.check('the server coming back is reached again without a restart or a click', true)
    t.check(
      'and the log says it connected',
      (await fleetLog()).some(
        (line) => line.includes(`Studio (${saved.id})`) && line.endsWith(': connected')
      ),
      await fleetLog()
    )
    const opened = await openOn(windowB, saved.id)
    t.check(
      'the tools of the other window open a tab on the server',
      typeof opened?.sessionId === 'string' && opened.serverId === saved.id,
      opened
    )

    // ── Disconnected and reconnected in window A's Settings: window B's tools follow ──
    await win.evaluate((id) => window.electronAPI.fleetDisconnect(id), saved.id)
    await slowly(
      async () => (await listedState(windowB, saved.id)) === 'disconnected',
      'window B’s tools see the disconnect made in window A'
    )
    const whileOff = await openOn(windowB, saved.id).then(
      () => null,
      (error) => error.message
    )
    // The target resolver refuses a disconnected server by name before the
    // state check does; either sentence says the server and that it is off.
    t.check(
      'and refuse a tab while the server is disconnected',
      typeof whileOff === 'string' && whileOff.includes('Studio') && /disconnected/i.test(whileOff),
      whileOff
    )
    await win.evaluate((id) => window.electronAPI.fleetConnect(id), saved.id)
    await slowly(
      async () => (await listedState(windowB, saved.id)) === 'connected',
      'window B’s tools see the reconnect made in window A'
    )
    const again = await openOn(windowB, saved.id)
    t.check(
      'a reconnect made in Settings reaches the tools of another window without a restart',
      typeof again?.sessionId === 'string',
      again
    )
    const lines = (await fleetLog()).filter((l) => l.includes(`Studio (${saved.id})`))
    t.check(
      'the log carries the disconnect and the reconnect, once per window',
      lines.some((l) => l.endsWith(': disconnected')) &&
        lines.filter((l) => l.endsWith(': connected')).length >= 2,
      lines
    )

    assert.deepEqual(mac.errors, [])
    await winB.close().catch(() => undefined)
  } finally {
    await world.close()
  }
}
