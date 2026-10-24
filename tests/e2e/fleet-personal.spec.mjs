import assert from 'node:assert/strict'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import {
  fleetWorld,
  connectMac,
  eventually,
  owned,
  request,
  ownerReady,
  clickReady,
  step
} from './fixtures/fleet-world.mjs'

const row = (win, id) => win.locator(`[data-sidebar-item-id="${id}"]`)
const chat = (win, id) => win.locator(`[data-session-id="${id}"] [data-testid="chat-view"]`)
async function send(win, id, text, expected = text) {
  await row(win, id).click()
  await chat(win, id).locator('textarea:not(:disabled)').fill(text)
  await chat(win, id).getByRole('button', { name: 'Send message', exact: true }).click()
  await chat(win, id)
    .locator('.chat-turn[data-role="assistant"]')
    .filter({ hasText: expected })
    .waitFor()
}
export async function run(t) {
  const world = await fleetWorld('personal')
  try {
    const [a, b] = world.servers
    const macA = await world.mac('a')
    const win = macA.win
    // Create the normal local terminal before any remote is focused.
    await win.getByTitle(/^New terminal .*workspace root/).click()
    const tile = win.locator('[data-terminal-tile]').first()
    await tile.locator('.xterm').waitFor()
    const localId = await tile.getAttribute('data-terminal-tile')
    await win.evaluate(
      (id) => window.electronAPI.writeSession(id, "printf 'LOCAL_ONLY\\n' > local-effect.txt\r"),
      localId
    )
    await eventually(
      () => existsSync(path.join(macA.root, 'local-effect.txt')),
      'local terminal executes'
    )
    assert.equal(readFileSync(path.join(macA.root, 'local-effect.txt'), 'utf8'), 'LOCAL_ONLY\n')
    await connectMac(macA, world.servers)
    t.check('normal local terminal executes beside two connected personal servers', true)

    const ownerA = macA.owners[0].id
    const ownerB = macA.owners[1].id
    const localBefore = await win.evaluate(() => window.electronAPI.listSessions())
    // The launch form's assertions move to lane B's normal-flow spec.
    await win.evaluate(
      ({ id, cwd }) =>
        window.electronAPI.fleetStart(id, cwd, {
          claudeMode: true,
          launchProfileId: 'dev-echo-adapter'
        }),
      { id: ownerA, cwd: a.root }
    )
    let created
    await eventually(async () => {
      created = (await request(a, '/sessions')).find((s) => s.adapterId === 'echo')
      return !!created
    }, 'first remote agent exists on empty owner')
    assert.equal(
      realpathSync(created.cwd),
      realpathSync(a.root),
      'created agent uses selected server cwd'
    )
    assert.notEqual(realpathSync(created.cwd), realpathSync(macA.root))
    assert.equal(created.adapterId, 'echo')
    assert.deepEqual(await request(b, '/sessions'), [])
    assert.deepEqual(
      await win.evaluate(() => window.electronAPI.listSessions()),
      localBefore,
      'remote creation adds no local agent'
    )
    const firstAgent = (
      await win.evaluate((id) => window.electronAPI.fleetSnapshot(id), ownerA)
    ).sessions.find((s) => s.adapterId === 'echo')
    assert.equal(firstAgent.id, owned('session', ownerA, created.id))
    await send(win, firstAgent.id, 'Created on the empty remote through Mac A')
    t.check(
      'Mac UI creates the first remote agent using owning cwd, profile and default account choice',
      true
    )

    const report = world.load()
    const id = report.values.first.sessionId
    const groupId = report.values.first.groupId
    const ka = owned('session', ownerA, id)
    const kb = owned('session', ownerB, id)
    for (const key of [ka, kb]) await row(win, key).waitFor()
    const macB = await world.mac('b')
    await macB.win.getByTitle(/^New terminal .*workspace root/).click()
    const localB = macB.win.locator('[data-terminal-tile]').first()
    await localB.locator('.xterm').waitFor()
    const localBId = await localB.getAttribute('data-terminal-tile')
    await connectMac(macB, world.servers)
    const ba = owned('session', macB.owners[0].id, id)
    const bb = owned('session', macB.owners[1].id, id)
    for (const key of [ba, bb]) await row(macB.win, key).waitFor()
    assert.notEqual(ka, kb)
    await send(win, ka, 'Mac A writes only to owner one')
    await row(macB.win, ba).click()
    await chat(macB.win, ba)
      .locator('.chat-turn[data-role="assistant"]')
      .filter({ hasText: 'Mac A writes only to owner one' })
      .waitFor()
    assert.equal(
      JSON.stringify(await request(b, `/sessions/history?id=${id}`)).includes(
        'Mac A writes only to owner one'
      ),
      false
    )
    t.check(
      'two real clients show distinct colliding owner IDs and share live history only within its owner',
      true
    )

    // Put the same conversation at different scroll positions on the two
    // devices, then preserve the second device's panes, draft and focus.
    const longTurn =
      '```text\n' +
      Array.from({ length: 100 }, (_, i) => `Personal fleet history line ${i}`).join('\n') +
      '\n```'
    await send(win, kb, longTurn, 'Personal fleet history line 99')
    await row(macB.win, bb).click()
    const scrollB = chat(macB.win, bb).locator('.chat-scroll')
    await eventually(
      () => scrollB.evaluate((element) => element.scrollHeight > element.clientHeight + 100),
      'conversation has a meaningful scroll range'
    )
    await scrollB.evaluate((element) => {
      element.scrollTop = 0
    })
    await chat(win, kb)
      .locator('.chat-scroll')
      .evaluate((element) => {
        element.scrollTop = element.scrollHeight
      })
    const panesBefore = await macB.win
      .locator('[data-terminal-tile]:not([aria-hidden="true"])')
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute('data-terminal-tile'))
      )
    const draft = chat(macB.win, bb).locator('textarea:not(:disabled)')
    await draft.fill('Mac B local draft')
    await draft.focus()
    await win.evaluate(
      async ({ owner, group }) => {
        const snapshot = await window.electronAPI.fleetSnapshot(owner)
        await window.electronAPI.fleetSaveLayout(
          owner,
          {
            groups: snapshot.layout.groups.map((g) =>
              g.id === group ? { ...g, name: 'Shared owner one name' } : g
            ),
            displayOrder: [...snapshot.layout.displayOrder].reverse()
          },
          snapshot.layout.revision
        )
      },
      { owner: ownerA, group: owned('group', ownerA, groupId) }
    )
    await macB.win.getByRole('button', { name: 'Shared owner one name', exact: true }).waitFor()
    assert.equal(await draft.inputValue(), 'Mac B local draft')
    assert.equal(await draft.evaluate((element) => element === document.activeElement), true)
    assert.equal(
      await scrollB.evaluate((element) => element.scrollTop),
      0,
      'the other Mac scroll does not move this reader'
    )
    assert.deepEqual(
      await macB.win
        .locator('[data-terminal-tile]:not([aria-hidden="true"])')
        .evaluateAll((elements) =>
          elements.map((element) => element.getAttribute('data-terminal-tile'))
        ),
      panesBefore,
      'shared sidebar changes preserve device-local panes'
    )
    const layouts = await Promise.all(
      [win, macB.win].map((page, i) =>
        page.evaluate(
          (owner) => window.electronAPI.fleetSnapshot(owner),
          i ? macB.owners[0].id : ownerA
        )
      )
    )
    assert.deepEqual(
      layouts[0].layout.displayOrder.map((key) => decodeURIComponent(key.split(':').at(-1))),
      layouts[1].layout.displayOrder.map((key) => decodeURIComponent(key.split(':').at(-1)))
    )
    t.check(
      'shared group name and order propagate while the other Mac retains its panes, scroll, draft and focus',
      true
    )

    // Both desktops stop consuming A. The process and history belong to A.
    await step('personal detach Mac B from owner one', async () => {
      await macB.win.evaluate(
        (owner) => window.electronAPI.fleetDisconnect(owner),
        macB.owners[0].id
      )
      await eventually(
        async () =>
          (await row(macB.win, ba)
            .locator('[data-fleet-owner]')
            .getAttribute('data-fleet-state')) === 'disconnected',
        'Mac B observed intentional disconnect'
      )
    })
    await step('personal quit original Mac A', () => macA.close())
    assert.ok((await request(a, '/sessions')).some((s) => s.id === id))
    await request(a, '/sessions/write', {
      id,
      input: { type: 'user_message', text: 'Produced with both Macs detached' }
    })
    assert.ok(
      JSON.stringify(await request(a, `/sessions/history?id=${id}`)).includes(
        'Produced with both Macs detached'
      )
    )
    await step('personal reconnect Mac B and catch up', async () => {
      await macB.win.evaluate((owner) => window.electronAPI.fleetConnect(owner), macB.owners[0].id)
      await ownerReady(macB, macB.owners[0].id, ba)
      await clickReady(row(macB.win, ba))
      await chat(macB.win, ba)
        .locator('.chat-turn[data-role="assistant"]')
        .filter({ hasText: 'Produced with both Macs detached' })
        .waitFor()
    })
    const returned = await step('personal reopen Mac A on saved data', () =>
      world.mac('a', { reuse: macA.dir })
    )
    returned.owners = await returned.win.evaluate(() => window.electronAPI.fleetList())
    await step('personal startup reconnect Mac A and catch up', async () => {
      await ownerReady(returned, ownerA, ka)
      await clickReady(row(returned.win, ka))
      await chat(returned.win, ka)
        .locator('.chat-turn[data-role="assistant"]')
        .filter({ hasText: 'Produced with both Macs detached' })
        .waitFor()
    })
    t.check(
      'quit, detached-client interval, reconnect and startup restore preserve running sessions and catch-up history',
      true
    )

    // One live owner and the local shell stay usable while A is unavailable.
    await a.stop()
    await send(macB.win, bb, 'Owner two remains usable while owner one is offline')
    assert.equal(await row(macB.win, ba).count(), 1)
    await macB.win.evaluate(
      (id) => window.electronAPI.writeSession(id, "printf 'STILL_LOCAL\\n' > offline-local.txt\r"),
      localBId
    )
    await eventually(
      () => existsSync(path.join(macB.root, 'offline-local.txt')),
      'local terminal survives a remote outage'
    )
    assert.equal(readFileSync(path.join(macB.root, 'offline-local.txt'), 'utf8'), 'STILL_LOCAL\n')
    await assert.rejects(macB.win.evaluate((key) => window.electronAPI.sessionsHistory(key), ba))
    t.check('one offline owner retains its rows while another owner remains usable', true)

    await macB.win.evaluate((key) => window.electronAPI.killSession(key), bb)
    await eventually(
      async () => (await row(macB.win, bb).count()) === 0,
      'close propagates on Mac B'
    )
    await eventually(
      async () => (await row(returned.win, kb).count()) === 0,
      'close propagates on returned Mac A'
    )
    assert.equal(await row(macB.win, ba).count(), 1)
    assert.deepEqual(macB.errors, [])
    assert.deepEqual(returned.errors, [])
    t.check('closing one colliding tab propagates to both Macs and preserves the other owner', true)
  } finally {
    await world.close()
  }
}
