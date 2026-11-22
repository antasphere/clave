// A look at Folio's updates (PRDCT-4832), not a check: launches the real app
// through the e2e harness with three Folio tabs on long invented names, files
// updates off the page and plays one, and screenshots the whole window in
// every bundled theme (light, dark, coffee, charcoal) for: (a) the toolbar
// with one update waiting, the card closed; (b) the card as a banner; (c)
// the card pinned with three updates, the names truncated; (d) a reading off
// screen, the chip playing with its progress rule, the card's player; (e)
// paused; (f) the same toolbar in a narrow window with the sidebar open.
// It runs through the runner, from the specs folder (copy it beside the
// specs for the run):
//   npx electron-vite build
//   sed -e "s#'../#'./#g" tests/e2e/look/folio-updates.spec.mjs > tests/e2e/zz-look.spec.mjs
//   CLAVE_LOOK_OUT=/tmp/clave-look-folio-updates node tests/e2e/run.mjs zz-look; rm tests/e2e/zz-look.spec.mjs
// Nothing here asserts beyond having run; the screenshots are for eyes, and
// are never committed. It lives outside the specs folder so CI never runs it.
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { callMcp, until } from '../harness.mjs'
import { openChat } from '../chat-view.spec.mjs'

const out = process.env.CLAVE_LOOK_OUT || '/tmp/clave-look-folio-updates'
const FOLIO = ['--dev-echo-view=clave.chat-view/lab']
const READY = '[data-testid="folio-view"] textarea:not(:disabled)'
const THEMES = ['light', 'dark', 'coffee', 'charcoal']
const answer = (word, blocks) =>
  Array.from({ length: blocks }, (_, i) => `${word} paragraph ${i + 1} of the answer.`).join('\n\n')

export async function run(t) {
  mkdirSync(out, { recursive: true })
  const chat = await openChat('look-folio-updates', FOLIO, READY, {}, null, {
    server: 'in-process'
  })
  const { app, win, record } = chat
  try {
    await app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) w.setSize(1360, 820)
    })
    const pane = (id) => win.locator(`[data-session-id="${id}"] [data-testid="folio-view"]`)
    const chip = win.locator('[data-testid="update-chip"]')
    const card = win.locator('[data-testid="update-card"]')
    const theme = (name) =>
      win.evaluate((name) => {
        const root = document.documentElement
        for (const key of Array.from(root.style))
          if (key.startsWith('--')) root.style.removeProperty(key)
        root.dataset.theme = name
      }, name)
    const shots = async (name) => {
      for (const th of THEMES) {
        await theme(th)
        await win.waitForTimeout(250)
        await win.screenshot({ path: path.join(out, `${name}-${th}.png`) })
      }
      await theme('light')
    }
    const write = (id, text) =>
      win.evaluate(
        ([sid, body]) =>
          window.electronAPI.sessionsWrite(sid, { type: 'user_message', text: body }),
        [id, text]
      )
    // The voice: a line is said at once, a block of an answer takes its time.
    await win.evaluate(() => {
      window.__spoken = []
      const stub = {
        speak(u) {
          window.__spoken.push(u.text)
          const ms = u.text.startsWith('I have') ? 300 : 6000
          const startAt = (window.__free ?? 0) > Date.now() ? window.__free : Date.now()
          window.__free = startAt + ms
          const at = window.__spoken.length
          setTimeout(
            () => {
              if (window.__cut >= at) return
              u.onstart?.()
              setTimeout(() => window.__cut >= at || u.onend?.(), ms - 20)
            },
            startAt - Date.now() + 10
          )
        },
        cancel() {
          window.__cut = window.__spoken.length
          window.__free = 0
        },
        pause: () => undefined,
        resume: () => undefined,
        getVoices: () => [],
        addEventListener: () => undefined,
        removeEventListener: () => undefined
      }
      Object.defineProperty(window, 'speechSynthesis', { value: stub, configurable: true })
    })

    const A = record.id
    const ids = [A]
    for (let i = 0; i < 3; i++) {
      await win.locator('.launcher-split .launcher-btn').click()
      const next = await until(async () =>
        (await win.evaluate(() => window.electronAPI.sessionsList())).find(
          (s) => s.adapterId === 'echo' && !ids.includes(s.id)
        )
      )
      ids.push(next.id)
      await pane(next.id).locator('textarea:not(:disabled)').waitFor()
    }
    const [, B, C, D] = ids
    const north = await callMcp(app, 'createGroup', { name: 'Northern tidal research collective' })
    await callMcp(app, 'moveSession', { sessionId: A, groupId: north.groupId })
    await callMcp(app, 'moveSession', { sessionId: B, groupId: north.groupId })
    const harbor = await callMcp(app, 'createGroup', { name: 'Harbor' })
    await callMcp(app, 'moveSession', { sessionId: C, groupId: harbor.groupId })
    await callMcp(app, 'rename', {
      target: 'session',
      id: B,
      name: 'Quarterly survey of the estuary'
    })
    await callMcp(app, 'rename', { target: 'session', id: C, name: 'Pier lights' })
    await callMcp(app, 'rename', {
      target: 'session',
      id: D,
      name: 'Atlas of the coastal weather stations and their keepers'
    })
    await callMcp(app, 'focus', { sessionId: A })
    await pane(A).locator('textarea[aria-label="Message"]').waitFor({ state: 'visible' })
    await pane(A).locator('.folio-voice-toggle').click()
    await pane(A).locator('textarea[aria-label="Message"]').click()

    // (b) the banner, (a) closed
    await write(B, answer('The estuary survey found the tide gauges drifting', 4))
    await card.waitFor()
    await win.waitForTimeout(400)
    await shots('b-banner-one-update')
    await win.mouse.click(700, 500)
    await until(async () => ((await card.count()) === 0 ? true : null))
    await shots('a-toolbar-one-waiting')

    // (c) three waiting, pinned
    await write(C, answer('Pier lights are back on the night schedule', 2))
    await until(async () =>
      (await win.evaluate(() => window.__spoken.filter((s) => s.startsWith('I have')).length)) >= 2
        ? true
        : null
    )
    await write(D, answer('The keepers sent their logbooks for the winter', 2))
    await until(async () =>
      (await win.evaluate(() => window.__spoken.filter((s) => s.startsWith('I have')).length)) >= 3
        ? true
        : null
    )
    await win.waitForTimeout(500)
    if ((await card.count()) === 0) await chip.locator('.update-chip-text').click()
    else await card.click({ position: { x: 20, y: 20 } })
    await until(async () => ((await card.getAttribute('data-open')) === 'pinned' ? true : null))
    await shots('c-pinned-three-waiting')

    // (d) a reading off screen, the second block in play
    await win.keyboard.press('Control+Shift+Space')
    // The second block in play: its utterance starts six seconds in.
    await until(async () => ((await chip.getAttribute('data-state')) === 'playing' ? true : null))
    await win.waitForTimeout(8000)
    if ((await card.count()) === 0) await chip.locator('.update-chip-text').click()
    await shots('d-playing-card-open')
    await chip.locator('.update-chip-text').click()
    await shots('d2-playing-card-closed')

    // (e) paused
    await win.keyboard.press('Control+Shift+Space')
    await until(async () => ((await chip.getAttribute('data-state')) === 'paused' ? true : null))
    await shots('e-paused')
    await chip.locator('.update-chip-text').click()
    await shots('e2-paused-card-open')
    await chip.locator('.update-chip-text').click()

    // (f) narrow, the sidebar open
    await app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) w.setSize(900, 720)
    })
    await win.waitForTimeout(600)
    await shots('f-narrow-paused')
    await win.keyboard.press('Control+Shift+Space')
    await win.waitForTimeout(600)
    await shots('f2-narrow-playing')
    t.check('the look ran', true)
  } finally {
    await chat.close()
  }
}
