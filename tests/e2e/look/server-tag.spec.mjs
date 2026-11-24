// A look script (PRDCT-5033), not a spec: it builds a Mac workspace paired
// with a server's workspace, nests two of the server's tabs under a third, and
// takes the pictures a person judges, into the folder named by
// CLAVE_LOOK_OUT, in the dark and the light theme: the Mac workspace's rows
// (the count, then the server's tag), the server workspace's rows (no server
// mark), the workspace switcher with the server's tag, and its list.
//
// Nothing here asserts beyond having run; the pictures are for eyes, and are
// never committed. Run it alone, on a build, copied beside the specs:
//   npx electron-vite build
//   sed -e "s#'../#'./#g" tests/e2e/look/server-tag.spec.mjs > tests/e2e/zz-look-server-tag.spec.mjs
//   CLAVE_LOOK_OUT=/tmp/shots node tests/e2e/run.mjs zz-look-server-tag; rm tests/e2e/zz-look-server-tag.spec.mjs
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fixturePath, until, mcpEndpoint, toolPayload } from '../harness.mjs'
import { fleetWorld, connectMac, eventually, clickReady } from '../fixtures/fleet-world.mjs'
import { mcpClient } from '../nest-helpers.mjs'

const out = process.env.CLAVE_LOOK_OUT || '/tmp/clave-look-server-tag'
const row = (win, id) => win.locator(`[data-sidebar-item-id="${id}"]`)
const item = (win, id) => win.locator(`[data-workspace-id="${id}"]`)

export async function run(t) {
  mkdirSync(out, { recursive: true })
  const world = await fleetWorld('look-server-tag', { gitRepo: true })
  try {
    const [server] = world.servers
    const rootA = fixturePath(`${world.run}-local-a`)
    execFileSync('git', ['clone', '-q', server.origin, rootA], { stdio: 'inherit' })
    const mac = await world.mac('a')
    await connectMac(mac, world.servers, { ui: false })
    const owner = mac.owners[0]
    const { win } = mac

    for (const name of ['Turn off', 'Dismiss'])
      await win
        .getByRole('button', { name })
        .click({ timeout: 4000 })
        .catch(() => {})

    // The server's tree becomes a server workspace, paired with this Mac's.
    const serverWs = await win.evaluate(
      ({ owner, root }) => window.electronAPI.fleetAddWorkspace(owner, { rootDir: root }),
      { owner: owner.id, root: server.root }
    )
    const notice = win.getByTestId('pairing-proposal')
    await notice.waitFor()
    await clickReady(notice.getByRole('button', { name: 'Combine', exact: true }))
    await notice.waitFor({ state: 'hidden' })

    // Four tabs on the server, named as a lane after two handovers.
    const state = JSON.parse(readFileSync(path.join(mac.dir, 'mcp-server.json'), 'utf8'))
    const shared = mcpClient(mcpEndpoint(mac.dir), state.token)
    await shared.init()
    const open = async (name) =>
      toolPayload(
        await shared.call('clave_open_session', {
          server: owner.name,
          cwd: server.root,
          mode: 'terminal',
          name
        })
      )?.sessionId
    const lead = await open('Lane · Invoice export')
    const gen1 = await open('Lane · Invoice export · gen 1')
    const gen2 = await open('Lane · Invoice export · gen 2')
    const notes = await open('Release notes')
    for (const id of [lead, gen1, gen2, notes]) await row(win, id).waitFor()
    for (const id of [gen1, gen2]) {
      const nested = await win.evaluate(
        ([id, under]) => window.__claveSessionStoreForTests.getState().nestSession(id, under),
        [id, lead]
      )
      assert.deepEqual(nested, { ok: true })
    }
    await win.evaluate(
      (id) => window.__claveSessionStoreForTests.getState().setNestExpanded(id, false),
      lead
    )
    await win
      .locator('body')
      .click({ position: { x: 900, y: 500 } })
      .catch(() => {})

    const theme = (name) =>
      win.evaluate((name) => {
        const root = document.documentElement
        for (const key of Array.from(root.style))
          if (key.startsWith('--')) root.style.removeProperty(key)
        root.dataset.theme = name
      }, name)
    const boxOf = (selectors, pad = 10) =>
      win.evaluate(
        ({ selectors, pad }) => {
          const boxes = selectors
            .flatMap((s) => [...document.querySelectorAll(s)])
            .filter((el) => !el.closest('[data-nest-collapsed="true"]'))
            .map((el) => el.getBoundingClientRect())
            .filter((b) => b.width > 0 && b.height > 0)
          const left = Math.min(...boxes.map((b) => b.left))
          const top = Math.min(...boxes.map((b) => b.top))
          const right = Math.max(...boxes.map((b) => b.right))
          const bottom = Math.max(...boxes.map((b) => b.bottom))
          return {
            x: Math.max(0, Math.floor(left - pad)),
            y: Math.max(0, Math.floor(top - pad)),
            width: Math.ceil(right - left + 2 * pad),
            height: Math.ceil(bottom - top + 2 * pad)
          }
        },
        { selectors, pad }
      )
    const shot = async (name, selectors, pad) => {
      await win.waitForTimeout(250)
      await win.screenshot({
        path: path.join(out, `${name}.png`),
        clip: await boxOf(selectors, pad)
      })
    }
    const rows = [lead, notes].map((id) => `[data-sidebar-item-id="${id}"] > .sidebar-item`)

    for (const name of ['dark', 'light']) {
      await theme(name)
      // The Mac workspace: the server's tabs carry its tag, the count first.
      await shot(`01-mac-workspace-${name}`, ['[data-sidebar-item-id]'], 12)
      await shot(`02-mac-row-close-${name}`, rows, 6)
    }

    // The server's own workspace.
    await eventually(async () => {
      if (
        !(await item(win, serverWs.id)
          .isVisible()
          .catch(() => false))
      )
        await win.getByLabel('Switch workspace', { exact: true }).click()
      await item(win, serverWs.id)
        .click({ timeout: 2000 })
        .catch(() => {})
      return (await win.getByLabel('Switch workspace', { exact: true }).innerText()).includes(
        owner.name
      )
    }, 'the window shows the server workspace')
    await until(async () => ((await row(win, lead).count()) > 0 ? true : null))
    await win.keyboard.press('Escape').catch(() => {})
    for (const name of ['dark', 'light']) {
      await theme(name)
      await shot(`03-server-workspace-${name}`, ['[data-sidebar-item-id]'], 12)
      await shot(`04-switcher-tag-${name}`, ['[aria-label="Switch workspace"]'], 14)
      await win.getByLabel('Switch workspace', { exact: true }).click()
      await item(win, serverWs.id).waitFor()
      await shot(`05-switcher-list-${name}`, ['[data-workspace-id]', '.menu-label'], 10)
      await win.keyboard.press('Escape')
      await win.waitForTimeout(300)
    }
    writeFileSync(path.join(out, 'done.txt'), 'ok\n')
    t.check('the pictures are taken', true)
  } finally {
    await world.close()
  }
}
