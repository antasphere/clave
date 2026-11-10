import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { sidebarRows, until, fixturePath } from './harness.mjs'
import { openChat } from './chat-view.spec.mjs'

// Settings → Helpers on this Mac (PRDCT-4330): the page lists the machine's
// helpers, a model picked there is the one the tab-title one-shot is asked
// for, and a helper switched off asks nothing of the CLI: the tab is named
// by its message's first words. A stub `claude` on the PATH records what it
// was asked, so nothing here reaches a model. The server's page is driven in
// `fleet-settings-helpers.spec.mjs`.

const BIN = fixturePath('settings-helpers-bin')
const LOG = `${BIN}/claude-calls.ndjson`
const TITLE = 'named by the stub'
const calls = () =>
  existsSync(LOG)
    ? readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : []

async function openHelpers(win) {
  await win.locator('.sidebar-footer-btn[aria-label="Settings"]').click()
  await win.locator('[data-settings-nav-row="helpers"]').click()
  const page = win.locator('[data-settings-page="helpers"]')
  await page.waitFor()
  await page.locator('[data-helper-row="tab-title"]').waitFor()
  return page
}

/** Pick an option of a settings select; the menu animates in, so the open is waited for. */
async function pick(win, select, name) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await select.click()
    const item = win.getByRole('menuitem', { name })
    const offered = await item.waitFor({ state: 'visible', timeout: 1500 }).then(
      () => true,
      () => false
    )
    if (offered) {
      await item.click({ timeout: 3000 }).catch(() => undefined)
      return
    }
    await win.keyboard.press('Escape')
  }
  throw new Error(`the select never offered ${String(name)}`)
}

const backToSessions = (win) =>
  win.getByRole('button', { name: 'Back to sessions', exact: true }).click()

export async function run(t) {
  rmSync(BIN, { recursive: true, force: true })
  mkdirSync(BIN, { recursive: true })
  writeFileSync(
    `${BIN}/bash`,
    '#!/bin/sh\nif [ "$1" = "-lic" ]; then env -0; else shift; exec /bin/bash --noprofile --norc "$@"; fi\n',
    { mode: 0o755 }
  )
  writeFileSync(
    `${BIN}/claude`,
    `#!${process.execPath}
const fs = require('node:fs');
let prompt = '';
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({ argv: process.argv.slice(2), prompt }) + '\\n');
  process.stdout.write(${JSON.stringify(TITLE)} + '\\n');
});
`,
    { mode: 0o755 }
  )
  const fixture = await openChat('settings-helpers', [], undefined, {
    SHELL: `${BIN}/bash`,
    PATH: `${BIN}:${process.env.PATH}`
  })
  const { win } = fixture
  try {
    // ── The page lists this Mac's helpers, each on, each on its default ──
    let page = await openHelpers(win)
    const ids = await page
      .locator('[data-helper-row]')
      .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-helper-row')))
    t.check(
      'the page has a row per built-in helper',
      ['commit-message', 'tab-title', 'push-summary', 'exchange-digest', 'work-digest'].every(
        (id) => ids.includes(id)
      ),
      ids
    )
    const modelSelect = page.locator('[data-settings-select="helper-model-tab-title"]')
    t.equal('tab titles start on haiku', await modelSelect.getAttribute('data-value'), 'haiku')

    // ── A model picked on the page is the one the CLI is asked for ──
    await pick(win, modelSelect, /^Sonnet/)
    await until(async () => (await modelSelect.getAttribute('data-value')) === 'sonnet')
    t.equal('the select shows the pick', await modelSelect.getAttribute('data-value'), 'sonnet')
    const stored = await win.evaluate(() => window.electronAPI.helpersList())
    t.equal(
      "the pick is this Mac's preference",
      stored.find((h) => h.id === 'tab-title')?.model,
      'sonnet'
    )
    await backToSessions(win)
    const input = win.getByRole('textbox', { name: 'Message', exact: true })
    await input.fill('please make the first tab follow the model picked in settings')
    await input.press('Enter')
    const named = await until(async () =>
      (await sidebarRows(win)).some((row) => row.includes(TITLE))
    )
    t.check('the first tab is named from the CLI', named, await sidebarRows(win))
    const first = calls()
    t.equal('the CLI was asked once', first.length, 1)
    t.check(
      'it was asked on the model picked in Settings',
      first[0]?.argv.slice(0, 3).join(' ') === '-p --model sonnet',
      first[0]?.argv
    )

    // ── Switched off: nothing is asked, the tab takes the first words ──
    page = await openHelpers(win)
    const row = page.locator('[data-helper-row="tab-title"]')
    await row.getByRole('switch', { name: 'Tab titles' }).click()
    await until(
      async () =>
        (await row.getByRole('switch', { name: 'Tab titles' }).getAttribute('aria-checked')) ===
        'false'
    )
    t.check(
      'the row says what an off helper gives instead',
      /first words/.test((await row.locator('[data-helper-when-off]').textContent()) ?? '')
    )
    await backToSessions(win)
    const before = (await win.evaluate(() => window.electronAPI.sessionsList())).map((s) => s.id)
    await win.locator('.launcher-split .launcher-btn').click()
    await until(async () =>
      (await win.evaluate(() => window.electronAPI.sessionsList())).some(
        (s) => s.adapterId === 'echo' && !before.includes(s.id)
      )
    )
    const second = win.locator('[data-testid="chat-view"] textarea:not(:disabled):visible')
    await until(async () => (await second.count()) === 1)
    await second.fill('rename the second tab from its own words')
    await second.press('Enter')
    const fallback = await until(async () =>
      (await sidebarRows(win)).some((r) => r.includes('rename the second tab'))
    )
    t.check('the second tab takes its first words', fallback, await sidebarRows(win))
    await new Promise((resolve) => setTimeout(resolve, 1000))
    t.equal('nothing more was asked of the CLI', calls().length, 1)
  } finally {
    await fixture.close()
    rmSync(BIN, { recursive: true, force: true })
  }
}
