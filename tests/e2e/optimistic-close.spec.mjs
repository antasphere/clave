// Closing a tab removes its row at once (PRDCT-5315). A Claude chat's process
// takes about a second to exit after its stop signal, and every close used to
// wait for it before the row left the sidebar (974 to 1236 ms measured on
// 27 November 2026). The chat here runs a stand-in CLI on a Clave server that
// waits 900 ms after its stop signal, as the real CLI does.
//
// Fails if: closed from the sidebar's « Delete », the chat header's « Close
// session » or the keyboard, the row is still in the sidebar 400 ms later,
// comes back at any point in the 2.5 s after, or its stand-in is never
// stopped; or a tab whose server is gone when it is closed does not come
// back with the mark before its title and a tooltip naming the server and
// saying the tab is still open; or a group deleted then does not come back
// in its place with its three tabs in their old order, each with its mark.
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { REPO } from './harness.mjs'
import {
  connectMac,
  eventually,
  fleetWorld,
  owned,
  request,
  showServer
} from './fixtures/fleet-world.mjs'

const EXIT_DELAY_MS = 900
const ROW_GONE_WITHIN_MS = 400

const lines = (file) => {
  try {
    return readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  } catch {
    return []
  }
}
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Arm a watch on the row: `window.__rowGone` resolves, `watchMs` after the
 *  arm, with when it left the DOM (ms from the arm, or -1) and when it came
 *  back after leaving (ms, or null). A row that flashes back for the length
 *  of the stop fails the second figure. */
const armRowGone = (win, key, watchMs = 2500) =>
  win.evaluate(
    ({ key, watchMs }) => {
      const start = performance.now()
      const at = () => Math.round(performance.now() - start)
      const present = () => !!document.querySelector(`[data-sidebar-item-id="${CSS.escape(key)}"]`)
      let gone = -1
      let back = null
      const obs = new MutationObserver(() => {
        if (gone < 0 && !present()) gone = at()
        else if (gone >= 0 && back === null && present()) back = at()
      })
      obs.observe(document.body, { subtree: true, childList: true })
      window.__rowGone = new Promise((resolve) =>
        setTimeout(() => {
          obs.disconnect()
          resolve({ gone, back })
        }, watchMs)
      )
    },
    { key, watchMs }
  )

/** A chat on the server, its stand-in CLI started by a first message; the
 *  CLI's pid, read from the message reaching it. */
async function liveChat(win, key, inputs, text) {
  await win.locator(`[data-sidebar-item-id="${key}"]`).click()
  const composer = win
    .locator(`[data-session-id="${key}"] [data-testid="chat-view"]`)
    .getByRole('textbox', { name: 'Message', exact: true })
  await eventually(() => composer.isEnabled(), 'the chat composer is enabled')
  await composer.fill(text)
  await composer.press('Enter')
  const reached = () =>
    inputs().find(
      (i) =>
        i.frame.type === 'user' && JSON.stringify(i.frame.message?.content ?? '').includes(text)
    )
  await eventually(() => !!reached(), `the message "${text}" reaches its stand-in CLI`)
  return reached().pid
}

async function closeFromSidebar(win, key) {
  const row = win.locator(`[data-sidebar-item-id="${key}"] .sidebar-item`)
  await row.hover()
  await row.locator('.sidebar-item-close').click()
  const confirm = win.getByRole('button', { name: 'Delete', exact: true })
  await confirm.waitFor()
  await armRowGone(win, key)
  await confirm.click()
}

export async function run(t) {
  const world = await fleetWorld('optimistic-close', { count: 1 })
  try {
    const [server] = world.servers
    await request(server, '/launch-profiles', {
      profile: {
        id: 'slow-exit-stub',
        name: 'Slow exit stream stub',
        family: 'claude',
        command: [process.execPath, path.join(REPO, 'tests/e2e/fixtures/claude-stream-stub.mjs')],
        additionalArgs: ['--stub-exit-delay', String(EXIT_DELAY_MS)]
      }
    })
    const start = () =>
      request(server, '/sessions/start', {
        cwd: server.root,
        options: { claudeMode: true, launchProfileId: 'chat:claude:slow-exit-stub' }
      })
    const chat = await start()
    const headerChat = await start()
    const keyboardChat = await start()
    const spare = await start()
    // A group of three chats on the server, for its Delete once the server is gone.
    const grouped = [await start(), await start(), await start()]
    const made = await request(server, '/sidebar/groups', {
      windowKey: 'server',
      group: { name: 'Order group', sessionIds: grouped.map((c) => c.id), cwd: server.root }
    })

    const mac = await world.mac('close')
    await connectMac(mac, world.servers, { ui: false })
    const owner = mac.owners[0].id
    const { win } = mac
    const key = owned('session', owner, chat.id)
    const spareKey = owned('session', owner, spare.id)
    const headerKey = owned('session', owner, headerChat.id)
    const keyboardKey = owned('session', owner, keyboardChat.id)
    await showServer(mac, 0)

    const inputs = () => lines(path.join(server.root, 'claude-stub-input.jsonl'))

    // Three ways to close a chat whose CLI takes 900 ms to stop: the sidebar's
    // « Delete », the chat header's « Close session », the keyboard.
    const roads = [
      {
        name: 'the sidebar',
        key,
        close: () => closeFromSidebar(win, key)
      },
      {
        name: "the chat header's « Close session »",
        key: headerKey,
        close: async () => {
          await win
            .locator(`[data-session-id="${headerKey}"]`)
            .getByRole('button', { name: 'Close session' })
            .first()
            .click()
          const confirm = win.getByRole('button', { name: 'Delete', exact: true })
          await confirm.waitFor()
          await armRowGone(win, headerKey)
          await confirm.click()
        }
      },
      {
        name: 'the keyboard',
        key: keyboardKey,
        close: async () => {
          await win.evaluate(() => document.activeElement?.blur?.())
          await armRowGone(win, keyboardKey)
          await win.keyboard.press('Meta+Backspace')
        }
      }
    ]
    for (const road of roads) {
      const pid = await liveChat(win, road.key, inputs, `hello from ${road.name}`)
      t.check(`${road.name}: the chat runs on a stand-in CLI that is alive`, alive(pid))
      await road.close()
      const { gone, back } = await win.evaluate(() => window.__rowGone)
      t.check(
        `${road.name}: the row leaves within ${ROW_GONE_WITHIN_MS} ms, its CLI taking ${EXIT_DELAY_MS} ms to stop`,
        gone >= 0 && gone < ROW_GONE_WITHIN_MS,
        `row gone after ${gone} ms`
      )
      t.check(`${road.name}: the row never comes back`, back === null, `back after ${back} ms`)
      await eventually(() => !alive(pid), `${road.name}: the stand-in CLI is stopped`)
      t.check(`${road.name}: the stand-in CLI was stopped behind the row`, !alive(pid))
    }
    await eventually(
      async () =>
        !(await win.evaluate((id) => window.electronAPI.fleetSnapshot(id), owner)).sessions.some(
          (s) => [chat.id, headerChat.id, keyboardChat.id].some((id) => s.id.endsWith(id))
        ),
      'the server no longer lists the three chats'
    )
    t.check(
      'no row comes back once the stops returned',
      (await win
        .locator(
          `[data-sidebar-item-id="${key}"], [data-sidebar-item-id="${headerKey}"], [data-sidebar-item-id="${keyboardKey}"]`
        )
        .count()) === 0
    )

    // The server goes away; closing its tab cannot be done, so the tab comes
    // back where it was, with the mark and the reason.
    await server.stop()
    await closeFromSidebar(win, spareKey)
    const spareGone = await win.evaluate(() => window.__rowGone)
    t.check(
      'the row of a tab whose server is gone still leaves at once',
      spareGone.gone >= 0 && spareGone.gone < ROW_GONE_WITHIN_MS,
      `row gone after ${spareGone.gone} ms`
    )
    const mark = win.locator(`[data-sidebar-item-id="${spareKey}"] [data-testid="tab-close-error"]`)
    await eventually(async () => (await mark.count()) === 1, 'the tab comes back with the mark')
    t.check('the tab comes back with the mark before its title', (await mark.count()) === 1)
    await mark.hover()
    // Radix draws the content twice, once for screen readers.
    const tooltip = win
      .getByText('Personal VPS 1 could not close this tab', { exact: false })
      .first()
    await eventually(() => tooltip.isVisible(), 'the tooltip names the server')
    t.check('hovering the mark names the server that could not close it', await tooltip.isVisible())
    t.check(
      'the tooltip says the tab is still open',
      await win.getByText('The tab is still open. Close it again to retry.').first().isVisible()
    )
    console.log(`the mark says: ${await tooltip.textContent()}`)

    // A group deleted while its server is gone comes back in its place, its
    // tabs in their old order, each with its mark.
    const groupedKeys = grouped.map((c) => owned('session', owner, c.id))
    const orderOf = () =>
      win.evaluate(
        (keys) =>
          [...document.querySelectorAll('[data-sidebar-item-id]')]
            .map((e) => e.getAttribute('data-sidebar-item-id'))
            .filter((k) => keys.includes(k))
            .map((k) => keys.indexOf(k)),
        groupedKeys
      )
    const groupKey = owned('group', owner, made.group.id)
    await win.click(`[data-sidebar-item-id="${groupKey}"] > button`, { button: 'right' })
    await win.locator('.menu-surface .menu-item', { hasText: 'Delete' }).click()
    const modal = win.locator('.modal-card button', { hasText: 'Delete' })
    if (await modal.count()) await modal.click()
    const groupMarks = () =>
      win
        .locator(
          groupedKeys
            .map((k) => `[data-sidebar-item-id="${k}"] [data-testid="tab-close-error"]`)
            .join(', ')
        )
        .count()
    await eventually(
      async () => (await groupMarks()) === 3,
      'the three tabs come back with their marks'
    )
    await new Promise((r) => setTimeout(r, 1500))
    t.check(
      'a group deleted while its server is gone comes back',
      (await win.locator(`[data-sidebar-item-id="${groupKey}"]`).count()) === 1
    )
    t.check('each of its tabs carries the mark', (await groupMarks()) === 3)
    const after = await orderOf()
    t.check(
      'its tabs come back in their old order',
      JSON.stringify(after) === JSON.stringify([0, 1, 2]),
      `order after ${JSON.stringify(after)}`
    )
    t.check('no page error', mac.errors.length === 0, mac.errors.join('\n'))
  } finally {
    await world.close()
  }
}
