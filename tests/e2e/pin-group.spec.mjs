/**
 * Pinning a group keeps the group, never its tabs, and never makes a second
 * pin of one that has a pin already (PRDCT-4830).
 *
 * What Romain met on 21 November 2026: typing "clave" in the group picker
 * offered three "Clave". One came from the project's `.clave` file. The two
 * others were saved pins, made by dropping a live group onto the pins: each
 * was a photograph of the tabs open that day, in no workspace (so shown in
 * every one), and each launch brought the same throwaway tabs back. A group
 * launched from the picker kept no trace of its pin, which is how the copies
 * were made.
 *
 * The unit tests hold the rules (pinned-store.test.ts). This spec holds what
 * they cannot: that the menu and the drop reach those rules in the real app,
 * and that the removal of the copies is WRITTEN, so a second boot does not
 * bring them back. That last one is silent when wrong: a removal made in
 * memory alone looks right until the next launch.
 */
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  fixturePath,
  callMcp,
  until
} from './harness.mjs'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const DIR = userDataDir('pin-group')
const ROOT = fixturePath('pin-group-root')
const PROJECT = `${ROOT}/labs/widget`
const OWN = `${ROOT}/labs/own`
const SCRATCH = `${ROOT}/labs/scratch`
const CLAVE = `${ROOT}/project.clave`
const WS = {
  id: 'eeeeeeee-0000-4000-8000-00000000000e',
  name: 'Projects',
  rootDir: ROOT,
  profileFile: CLAVE,
  createdAt: 1
}
const STATE = path.join(DIR, 'workspace-state.json')

const shell = (name, cwd) => ({
  cwd,
  name,
  claudeMode: false,
  antigravityMode: false,
  codexMode: false,
  dangerousMode: false
})

/** A saved pin as the app wrote one before the fix: no file, a photograph of
 *  the tabs open when the group was pinned. */
const savedPin = (id, name, cwd, workspaceId) => ({
  id,
  name,
  cwd,
  color: 'blue',
  prompt: null,
  sessions: [
    shell('explore group placement', cwd),
    shell('.antasphere', ROOT),
    shell('Hackathon (resumed)', ROOT)
  ],
  terminals: [],
  createdAt: 1,
  filePath: null,
  rootDir: null,
  workspaceRoot: null,
  toolbar: false,
  logo: null,
  category: null,
  discoveredBy: null,
  workspaceId
})

const readPins = () => JSON.parse(readFileSync(STATE, 'utf8')).pins ?? []
const pinIds = () => readPins().map((p) => p.id)

/** The picker's cards: name, pin id, whether marked. The dialog is left open. */
const cards = (win) =>
  win.evaluate(() =>
    [...document.querySelectorAll('.group-picker-card')].map((c) => ({
      name: c.querySelector('span.truncate')?.textContent ?? null,
      id: c.getAttribute('data-pinned-id'),
      flashing: c.getAttribute('data-flashing') === 'true',
      text: c.textContent ?? ''
    }))
  )
const pickerOpen = (win) => win.evaluate(() => !!document.querySelector('.group-picker-panel'))

async function openPicker(win) {
  await win.click('button[aria-label="Add a group"]')
  await win.waitForSelector('.group-picker-panel', { timeout: 5000 })
  await win.waitForTimeout(300)
}
async function closePicker(win) {
  await win.keyboard.press('Escape')
  await until(async () => !(await pickerOpen(win)), { tries: 20, gapMs: 100 })
}

const groupHeader = (id) => `[data-sidebar-item-id="${id}"] > button`

/** The labels of the group's context menu, left open. */
async function openGroupMenu(win, groupId) {
  await win.click(groupHeader(groupId), { button: 'right' })
  await win.waitForSelector('.menu-surface .menu-item', { timeout: 5000 })
  await win.waitForTimeout(200)
  return win.evaluate(() =>
    [...document.querySelectorAll('.menu-surface .menu-item')].map((i) => i.textContent?.trim())
  )
}

export async function run(t) {
  for (const dir of [PROJECT, OWN, SCRATCH]) mkdirSync(dir, { recursive: true })
  writeFileSync(
    CLAVE,
    JSON.stringify(
      {
        $schema: 'clave/1.0',
        name: 'Widget',
        cwd: 'labs/widget',
        color: 'blue',
        category: 'Products',
        sessions: [shell('Widget', 'labs/widget')],
        terminals: []
      },
      null,
      2
    )
  )
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])
  // What a Mac held before the fix: two copies of the file's group (one in no
  // workspace, as the app made them; one stamped, as a migration may have
  // left it) and a saved pin of someone's own, with no file behind it.
  const seeded = JSON.parse(readFileSync(STATE, 'utf8'))
  seeded.pins = [
    savedPin('copy-unstamped', 'Widget', PROJECT, null),
    savedPin('copy-stamped', 'Widget', PROJECT, WS.id),
    savedPin('own', 'Own', OWN, null)
  ]
  writeFileSync(STATE, JSON.stringify(seeded, null, 2))

  let { app, win } = await launchApp(DIR)
  try {
    // ── 1. The copies are cleared at the first read of the workspace's file,
    //       and the clearing is written ──
    const cleared = await until(
      async () => {
        const ids = pinIds()
        return !ids.includes('copy-unstamped') && !ids.includes('copy-stamped') ? ids : null
      },
      { tries: 60, gapMs: 250 }
    )
    t.check('the state file no longer holds the two copies', !!cleared, pinIds())
    t.check("it still holds the saved pin of someone's own", pinIds().includes('own'), pinIds())
    const filePins = readPins().filter((p) => p.filePath === CLAVE)
    t.equal('and the one pin of the file', filePins.length, 1)
    const widgetPinId = filePins[0]?.id

    await openPicker(win)
    const atBoot = await cards(win)
    t.equal(
      'the picker offers one Widget and Own, nothing else',
      atBoot
        .map((c) => c.name)
        .sort()
        .join(' | '),
      'Own | Widget'
    )
    t.check(
      'the Widget left is the file’s, with its one session',
      atBoot.find((c) => c.name === 'Widget')?.id === widgetPinId &&
        /1 session\b/.test(atBoot.find((c) => c.name === 'Widget')?.text ?? ''),
      atBoot
    )

    // ── 2. A group launched from the picker has its pin: the menu shows it,
    //       and pinning makes no copy ──
    await win.click(`.group-picker-card[data-pinned-id="${widgetPinId}"]`)
    const launched = await until(
      async () => {
        const list = await callMcp(app, 'list', {})
        return list.groups.find((g) => g.name === 'Widget') ?? null
      },
      { tries: 60, gapMs: 250 }
    )
    t.check('the picker launched the Widget group', !!launched, 'no Widget group')
    await win.waitForTimeout(1500)
    const linked = (await callMcp(app, 'list', {})).pinnedGroups.find((p) => p.id === widgetPinId)
    t.equal('CONTROL: the picker’s launch leaves the pin unlinked', linked?.activeGroupId, null)
    // Renamed since its launch: its name no longer says which pin it came
    // from, so what follows holds on the stamp the launch left on the group.
    await callMcp(app, 'rename', { target: 'group', id: launched.id, name: 'Widget at work' })
    await win.waitForTimeout(500)

    const menu = await openGroupMenu(win, launched.id)
    t.check('the group’s menu offers Show pin', menu.includes('Show pin'), menu)
    t.check('and no Pin group', !menu.includes('Pin group'), menu)
    await win.locator('.menu-surface .menu-item', { hasText: 'Show pin' }).click()
    await win.waitForSelector('.group-picker-panel', { timeout: 5000 })
    const shown = await cards(win)
    t.check(
      'Show pin opens the picker on the Widget card, marked',
      shown.find((c) => c.id === widgetPinId)?.flashing === true,
      shown
    )
    t.equal('and no card was added', shown.length, 2)
    t.equal('the mark is on that card alone', shown.filter((c) => c.flashing).length, 1)
    await closePicker(win)

    // The same by the gesture Romain used: the group dropped onto the pins.
    const box = await win.locator(groupHeader(launched.id)).boundingBox()
    const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    await win.mouse.move(from.x, from.y)
    await win.mouse.down()
    for (let i = 1; i <= 6; i++) {
      await win.mouse.move(from.x, from.y + i * 3)
      await win.waitForTimeout(30)
    }
    const zone = win.locator('[data-pin-drop-zone]')
    await zone.waitFor({ timeout: 5000 })
    t.equal(
      'dragging the group shows a zone that will show its pin',
      await zone.getAttribute('data-pin-drop-zone'),
      'show'
    )
    for (let i = 0; i < 3; i++) {
      const zb = await zone.boundingBox()
      await win.mouse.move(zb.x + zb.width / 2, zb.y + zb.height / 2, { steps: 8 })
      await win.waitForTimeout(150)
    }
    t.equal(
      'over it, the zone says what the drop does',
      (await zone.textContent())?.trim(),
      'Drop to show its pin'
    )
    await win.mouse.up()
    await win.waitForSelector('.group-picker-panel', { timeout: 5000 })
    const dropped = await cards(win)
    t.check(
      'the drop opens the picker on the Widget card, marked',
      dropped.find((c) => c.id === widgetPinId)?.flashing === true,
      dropped
    )
    t.equal('and the drop made no copy', dropped.length, 2)
    await closePicker(win)
    t.equal(
      'no pin was written for the launched group',
      readPins().filter((p) => p.name === 'Widget').length,
      1
    )

    // ── 3. A group made by hand is pinned as the group and one tab, in its
    //       workspace ──
    // A group an agent makes has no folder of its own, and its + opens at the
    // workspace root: so does the pin's one tab.
    const scratch = await callMcp(app, 'createGroup', { name: 'Scratch' })
    for (let i = 0; i < 2; i++) {
      await callMcp(app, 'openSession', {
        cwd: SCRATCH,
        mode: 'terminal',
        groupId: scratch.groupId
      })
    }
    await win.waitForTimeout(1500)
    const tabsOpen = (await callMcp(app, 'list', {})).groups.find((g) => g.id === scratch.groupId)
      ?.sessionIds.length
    t.equal('CONTROL: the hand-made group has two tabs open', tabsOpen, 2)

    const before = await openGroupMenu(win, scratch.groupId)
    t.check('its menu offers Pin group', before.includes('Pin group'), before)
    await win.locator('.menu-surface .menu-item', { hasText: 'Pin group' }).click()
    const written = await until(async () => readPins().find((p) => p.name === 'Scratch') ?? null, {
      tries: 40,
      gapMs: 250
    })
    t.check('the pin is written', !!written, pinIds())
    t.equal('with ONE session, not the two tabs', written?.sessions?.length, 1)
    t.equal('named after the group', written?.sessions?.[0]?.name, 'Scratch')
    t.check(
      'opening where the group’s + opens: the workspace root, the group having no folder',
      written?.sessions?.[0]?.cwd === ROOT &&
        written?.sessions?.[0]?.rootSession === true &&
        written?.workspaceRoot === ROOT,
      written
    )
    t.equal('and stamped with the workspace it was made in', written?.workspaceId, WS.id)
    t.check('pinning opened no picker: a new pin has nothing to show', !(await pickerOpen(win)))

    const after = await openGroupMenu(win, scratch.groupId)
    t.check(
      'pinned, its two tabs against the pin’s one do not read as out of sync',
      !after.includes('Re-sync pin') && !after.includes('Pin group') && !after.includes('Show pin'),
      after
    )
    await win.keyboard.press('Escape')
    await win.waitForTimeout(300)
  } finally {
    await app.close()
  }

  // ── 4. A second boot: the copies stay gone, and the clearing does not run
  //       again on a pin made since ──
  const second = JSON.parse(readFileSync(STATE, 'utf8'))
  t.check(
    'CONTROL: between the boots the state file holds no copy',
    !second.pins.some((p) => p.id.startsWith('copy-')),
    second.pins.map((p) => p.id)
  )
  second.pins.push(savedPin('made-later', 'Widget', PROJECT, WS.id))
  writeFileSync(STATE, JSON.stringify(second, null, 2))
  ;({ app, win } = await launchApp(DIR))
  try {
    await win.waitForTimeout(4000)
    await openPicker(win)
    const names = (await cards(win)).map((c) => c.name).sort()
    t.equal(
      'the second boot offers Own, Scratch and the two Widget, the later one kept',
      names.join(' | '),
      'Own | Scratch | Widget | Widget'
    )
    t.check(
      'the state file still holds the pin made later',
      pinIds().includes('made-later'),
      pinIds()
    )
    t.check(
      'and neither of the first two copies',
      !pinIds().some((id) => id.startsWith('copy-')),
      pinIds()
    )
    await closePicker(win)

    // ── 5. The restart dropped every link between a pin and its group. What
    //       is left is the stamp saved with the sidebar: both groups still
    //       have their pin ──
    const list = await callMcp(app, 'list', {})
    const scratch = list.groups.find((g) => g.name === 'Scratch')
    const widget = list.groups.find((g) => g.name === 'Widget at work')
    t.check('both groups came back with the sidebar', !!scratch && !!widget, list.groups)
    t.check(
      'CONTROL: no pin is linked to a group after the restart',
      list.pinnedGroups.every((p) => p.activeGroupId === null),
      list.pinnedGroups.map((p) => [p.name, p.activeGroupId])
    )
    if (scratch && widget) {
      // Scratch has no folder and its pin has the root: only the stamp left
      // at pin time ties them. Widget was renamed: only the launch's stamp does.
      for (const [label, group] of [
        ['the group pinned by hand', scratch],
        ['the renamed group launched from the picker', widget]
      ]) {
        const menu = await openGroupMenu(win, group.id)
        t.check(
          `${label} still offers Show pin, not Pin group`,
          menu.includes('Show pin') && !menu.includes('Pin group'),
          menu
        )
        await win.keyboard.press('Escape')
        await win.waitForTimeout(300)
      }
    }
    t.equal('and the state file holds the same four pins', pinIds().length, 4)
  } finally {
    await app.close()
  }
}
