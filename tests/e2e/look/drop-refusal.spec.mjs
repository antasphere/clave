// A look at the drop refusal card and the notice card it is built on, not a
// check: launches the real app through the e2e harness against one Clave
// server, opens a chat of that server, drops this Mac's folders on its
// composer, and screenshots the card in the light and the dark theme, the
// plural, the composer right after Escape and a narrow pane; then lays the
// notice card's showcase into the same pane (rendered by the component,
// `notice-card-markup.ts`) for each tone docked and for the inline form.
// It runs through the runner, from the specs folder:
//   npx electron-vite build
//   sed -e "s#'../#'./#g" tests/e2e/look/drop-refusal.spec.mjs > tests/e2e/zz-look.spec.mjs
//   CLAVE_LOOK_OUT=/tmp/drop-card node tests/e2e/run.mjs zz-look; rm tests/e2e/zz-look.spec.mjs
// Nothing here asserts beyond having run; the screenshots are for eyes, and
// are never committed. It lives outside the specs folder so CI never runs it.
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { REPO, fixturePath } from '../harness.mjs'
import {
  fleetWorld,
  connectMac,
  clickReady,
  eventually,
  owned,
  request,
  showServer
} from '../fixtures/fleet-world.mjs'

const out = process.env.CLAVE_LOOK_OUT || '/tmp/clave-look'

export async function run(t) {
  mkdirSync(out, { recursive: true })
  const showcase = JSON.parse(
    execFileSync(
      'npx',
      ['vite-node', '--config', 'vitest.config.ts', 'tests/e2e/look/notice-card-markup.ts'],
      { cwd: REPO, encoding: 'utf8' }
    )
  )
  const world = await fleetWorld('look-drop-refusal', { count: 1 })
  try {
    const [server] = world.servers
    const folders = ['site', 'assets', 'notes'].map((name) => {
      const folder = fixturePath(`look-drop-refusal-${process.pid}/${name}`)
      mkdirSync(folder, { recursive: true })
      return folder
    })
    await request(server, '/launch-profiles', {
      profile: {
        id: 'look-drop-stub',
        name: 'Drop refusal look stub',
        family: 'claude',
        command: [process.execPath, path.join(REPO, 'tests/e2e/fixtures/claude-stream-stub.mjs')],
        additionalArgs: []
      }
    })
    const started = await request(server, '/sessions/start', {
      cwd: server.root,
      options: { claudeMode: true, launchProfileId: 'chat:claude:look-drop-stub' }
    })
    const mac = await world.mac('look')
    await connectMac(mac, world.servers, { ui: false })
    const key = owned('session', mac.owners[0].id, started.id)
    const { win, app } = mac
    const size = (width, height) =>
      app.evaluate(
        ({ BrowserWindow }, { width, height }) =>
          BrowserWindow.getAllWindows()[0]?.setContentSize(width, height),
        { width, height }
      )
    await size(1180, 820)
    await showServer(mac, 0)
    await clickReady(win.locator(`[data-sidebar-item-id="${key}"]`))
    const pane = win.locator(`[data-session-id="${key}"]`)
    const chat = pane.locator('[data-testid="chat-view"]')
    await chat.waitFor()
    const composer = chat.getByRole('textbox', { name: 'Message', exact: true })
    await eventually(() => composer.isEnabled(), 'the server chat’s composer is enabled')
    // One exchange, so the inline cards sit in a conversation.
    await composer.fill('Where do the deploy notes live?')
    await composer.press('Enter')
    await eventually(
      async () => (await chat.locator('[data-role="assistant"]').count()) > 0,
      'the stub answers'
    )

    const theme = (name) =>
      win.evaluate((name) => {
        const root = document.documentElement
        for (const key of Array.from(root.style))
          if (key.startsWith('--')) root.style.removeProperty(key)
        root.dataset.theme = name
      }, name)
    const settle = () => win.waitForTimeout(1400)
    const shot = async (name) => {
      await settle()
      await pane.screenshot({ path: path.join(out, `${name}.png`) })
      console.log(`  ${path.join(out, `${name}.png`)}`)
    }
    const drop = (kind, value) =>
      composer.evaluate(
        (el, { kind, value }) => {
          const dt = new DataTransfer()
          dt.setData(kind, value)
          el.dispatchEvent(
            new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })
          )
        },
        { kind, value }
      )
    const card = chat.locator('[data-drop-refusal]')

    await theme('light')
    await drop('text/uri-list', `file://${folders[0]}`)
    await card.waitFor()
    await shot('card-light')
    await theme('dark')
    await shot('card-dark')
    await composer.focus()
    await win.keyboard.press('Escape')
    await eventually(async () => (await card.count()) === 0, 'Escape takes the card away')
    await shot('after-esc')

    await theme('light')
    await drop('text/plain', folders.join('\n'))
    await eventually(
      async () => (await card.getAttribute('data-drop-refusal', { timeout: 100 })) === '3',
      'the plural card'
    )
    await shot('card-plural')
    await size(560, 820)
    await shot('card-narrow')
    await size(1180, 820)
    await composer.focus()
    await win.keyboard.press('Escape')
    await eventually(async () => (await card.count()) === 0, 'Escape takes the card away')

    // The showcase, laid into the pane by the component's own markup.
    for (const tone of ['info', 'warning', 'error']) {
      await chat.evaluate((root, html) => {
        const holder = document.createElement('div')
        holder.dataset.look = 'true'
        holder.innerHTML = html
        root.querySelector('.chat-composer-wrap form').before(holder)
      }, showcase.docked[tone])
      await shot(`tone-${tone}`)
      await chat.evaluate((root) => root.querySelector('[data-look]')?.remove())
    }
    await chat.evaluate((root, html) => {
      const holder = document.createElement('div')
      holder.dataset.look = 'true'
      holder.style.display = 'contents'
      holder.innerHTML = html
      root.querySelector('.chat-column').append(holder)
      const scroll = root.querySelector('.chat-scroll')
      scroll.scrollTop = scroll.scrollHeight
    }, showcase.inline)
    await shot('inline-light')
    await theme('dark')
    await shot('inline-dark')
    t.check('the look ran', true)
  } finally {
    await world.close()
  }
}
