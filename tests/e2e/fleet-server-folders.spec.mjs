/**
 * A folder for a tab or a group on a Clave server is the SERVER's folder
 * (PRDCT-4329). One daemon, one Mac, this Mac's native folder dialog stubbed
 * to count its calls and answer a path the server does not have.
 *
 * 1. A server group's "Add terminal": the folder button opens the server's
 *    picker, the dialog steps aside so the picker can be used, the folder
 *    picked there comes back into the dialog; this Mac's dialog never opens.
 * 2. The side panel of a server tab: "Another folder…" picks on the server.
 * 3. A folder of this Mac dropped on a server tab's composer, as a desktop
 *    drop (the composer's attachments) and as a path dragged as text (the
 *    Chat view's and the Enclave view's own drop), never lands in the
 *    message as this Mac's path: the refusal card says so above the
 *    composer instead, naming the server, in the plural for several, and
 *    goes with Escape or with the next file that lands; the caret stays in
 *    the composer meanwhile, and the conversation gets no line of its own.
 * 4. A server's file tab offers no "Reveal in Finder".
 *
 * Fails if: either picker opens this Mac's dialog (or the group dialog is not
 * told its group's server), the server picker cannot be clicked over the
 * dialog, a dropped Mac folder's path is typed into a server tab's message,
 * the refusal card is missing, wrong or unmovable (or a line in the
 * conversation repeats it), or "Reveal in Finder" is offered for a server's
 * file.
 */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { REPO, fixturePath, stubFolderDialog } from './harness.mjs'
import {
  fleetWorld,
  connectMac,
  clickReady,
  eventually,
  owned,
  request,
  showServer
} from './fixtures/fleet-world.mjs'

const MAC_ANSWER = '/Users/nobody/mac-folder'

/** Pick `folder` in the server folder picker on screen, by typing its path. */
async function pickInServerPicker(win, folder) {
  // The picker's pencil button (its path bar's own crumbs take a click as
  // a navigation).
  const edit = win.locator('button.btn-icon[title="Edit path"]:visible').first()
  await edit.waitFor({ state: 'visible' })
  await edit.click({ timeout: 5000 })
  const input = win.locator('input[placeholder="/path/to/directory"]:visible').first()
  await input.fill(folder)
  await input.press('Enter')
  const current = win.locator('span.font-mono[title]').last()
  await eventually(
    async () => (await current.getAttribute('title')) === folder,
    'the server picker opens the typed folder'
  )
  await win
    .locator('button.btn-primary:visible', { hasText: /^Open$/ })
    .first()
    .click({ timeout: 5000 })
  await eventually(
    async () => (await win.locator('button[title="Edit path"]:visible').count()) === 0,
    'the server picker closes once the folder is chosen'
  )
}

export async function run(t) {
  const world = await fleetWorld('server-folders', { count: 1 })
  try {
    const [server] = world.servers
    const picked = path.join(server.root, 'picked-folder')
    mkdirSync(picked, { recursive: true })
    writeFileSync(path.join(picked, 'inside-picked.txt'), 'in the picked folder\n')
    writeFileSync(path.join(server.root, 'reveal-probe.txt'), 'on the server\n')
    // A real folder of this Mac, so the upload's refusal is a folder's.
    const macFolder = fixturePath(`server-folders-mac-${process.pid}`)
    mkdirSync(macFolder, { recursive: true })
    // Two more for a drop of several, and a plain file that does go.
    const macFolders = [macFolder, `${macFolder}-b`, `${macFolder}-c`]
    for (const folder of macFolders) mkdirSync(folder, { recursive: true })
    const macFile = path.join(macFolder, 'goes-to-the-server.txt')
    writeFileSync(macFile, 'a plain file of this Mac\n')

    await request(server, '/launch-profiles', {
      profile: {
        id: 'server-folders-stub',
        name: 'Server folders stream stub',
        family: 'claude',
        command: [process.execPath, path.join(REPO, 'tests/e2e/fixtures/claude-stream-stub.mjs')],
        additionalArgs: []
      }
    })
    const started = await request(server, '/sessions/start', {
      cwd: server.root,
      options: { claudeMode: true, launchProfileId: 'chat:claude:server-folders-stub' }
    })
    await request(server, '/sidebar/groups', {
      windowKey: 'server',
      group: { name: 'Folder group', sessionIds: [], cwd: server.root }
    })

    const mac = await world.mac('folders')
    await connectMac(mac, world.servers, { ui: false })
    const owner = mac.owners[0].id
    const key = owned('session', owner, started.id)
    const { win, app } = mac
    await showServer(mac, 0)
    const nativeCalls = await stubFolderDialog(app, { returns: MAC_ANSWER })

    // ── 1. The group's Add terminal ─────────────────────────────────────────
    const header = win.getByText('Folder group', { exact: true }).first()
    await eventually(() => header.isVisible(), 'the server group is drawn')
    await header.click({ button: 'right' })
    await win.getByText('Add terminal', { exact: true }).first().click()
    const dialog = win.getByRole('dialog', { name: 'Add terminal' })
    await dialog.waitFor()
    const folderButton = dialog.locator('[data-group-terminal-folder]')
    // The form filled before the picker opens: it must be there when the
    // dialog comes back.
    const commandInput = dialog.locator('input[placeholder^="e.g., npm run dev"]')
    await commandInput.fill('npm run kept')
    await dialog.getByRole('button', { name: 'Auto-execute', exact: true }).click()
    await dialog.locator('button[title="bolt"]').click()
    const focusedIsFolderButton = () =>
      win.evaluate(
        () => document.activeElement?.hasAttribute('data-group-terminal-folder') === true
      )
    await folderButton.click()
    const pickerShown = await eventually(
      async () => (await win.locator('button[title="Edit path"]').count()) > 0,
      'the server folder picker opens'
    ).then(
      () => true,
      () => false
    )
    t.check('Add terminal on a server group opens the server’s folder picker', pickerShown)
    let usable = false
    if (pickerShown) {
      usable = await pickInServerPicker(win, picked).then(
        () => true,
        (error) => {
          console.log(`  the picker could not be used: ${String(error.message).split('\n')[0]}`)
          return false
        }
      )
    }
    t.check('the server picker can be used while the Add terminal dialog is open', usable)
    if (usable) {
      await dialog.waitFor()
      t.equal(
        'the folder picked on the server comes back into the dialog',
        await folderButton.getAttribute('title'),
        picked
      )
      const form = {
        command: await commandInput.inputValue(),
        auto: await dialog
          .getByRole('button', { name: 'Auto-execute', exact: true })
          .getAttribute('aria-pressed'),
        bolt: await dialog.locator('button[title="bolt"]').getAttribute('aria-pressed')
      }
      t.check(
        'the command, the mode and the icon chosen before the pick are all still in the form',
        form.command === 'npm run kept' && form.auto === 'true' && form.bolt === 'true',
        form
      )
      // Focus goes back to the control that opened the picker: after a pick,
      // after Escape, after the picker's X.
      const focusBack = (how) =>
        eventually(focusedIsFolderButton, `focus returns to the folder button after ${how}`).then(
          () => true,
          () => false
        )
      t.check('after a pick, focus is back on the folder button', await focusBack('a pick'))
      const pickerOpen = () => win.locator('button.btn-icon[title="Edit path"]:visible').count()
      await folderButton.click()
      await eventually(async () => (await pickerOpen()) > 0, 'the picker opens again')
      await win.keyboard.press('Escape')
      await eventually(async () => (await pickerOpen()) === 0, 'Escape closes the picker')
      t.check('after Escape, focus is back on the folder button', await focusBack('Escape'))
      await folderButton.click()
      await eventually(async () => (await pickerOpen()) > 0, 'the picker opens a third time')
      await win
        .locator('div:has(> h3:text-is("Open folder")) > button.btn-icon-sm:visible')
        .first()
        .click()
      await eventually(async () => (await pickerOpen()) === 0, 'the X closes the picker')
      t.check('after the picker’s X, focus is back on the folder button', await focusBack('the X'))
      t.equal(
        'a cancelled pick leaves the picked folder in the dialog',
        await folderButton.getAttribute('title'),
        picked
      )
    }
    t.equal('Add terminal never opened this Mac’s folder dialog', await nativeCalls(), 0)
    await win.keyboard.press('Escape')
    await eventually(async () => !(await dialog.isVisible()), 'the dialog is closed')

    // ── 2. The side panel's Another folder… ─────────────────────────────────
    await clickReady(win.locator(`[data-sidebar-item-id="${key}"]`))
    const pane = win.locator(`[data-session-id="${key}"]`)
    const chat = pane.locator('[data-testid="chat-view"]')
    await chat.waitFor()
    const scope = win.locator('.panel-scope-btn')
    if (!(await scope.isVisible())) await clickReady(win.getByTitle(/^File tree/))
    await clickReady(scope)
    await clickReady(win.locator('[data-scope-option="folder"]'))
    const sidePicker = await eventually(
      async () => (await win.locator('button[title="Edit path"]').count()) > 0,
      'the side panel opens the server folder picker'
    ).then(
      () => true,
      () => false
    )
    t.check('the side panel’s Another folder… opens the server’s folder picker', sidePicker)
    if (sidePicker) {
      const ok = await pickInServerPicker(win, picked).then(
        () => true,
        () => false
      )
      t.check('the side panel’s server picker can be used', ok)
      // The panel adopts the folder: its path line names it, and its file
      // tree lists that folder's content, read from the server.
      // The path line: the plain path button names the folder in its title,
      // or (a folder under the panel's root) the breadcrumb ends with it.
      const pathLine = () =>
        win.evaluate((folder) => {
          const plain = document.querySelector('.panel-path')
          if (plain)
            return plain.getAttribute('title') === folder ? folder : plain.getAttribute('title')
          const crumbs = document.querySelector('div[title^="Double-click to go back to"]')
          const last = crumbs ? [...crumbs.querySelectorAll('button')].pop() : null
          return last?.textContent === folder.split('/').pop()
            ? folder
            : (last?.textContent ?? null)
        }, picked)
      const adopted = await eventually(
        async () => (await pathLine()) === picked,
        'the path line names the picked folder'
      ).then(
        () => true,
        () => false
      )
      t.check('the side panel’s path line shows the folder picked on the server', adopted, {
        pathLine: await pathLine()
      })
      const pickedTree = win.locator(`[data-file-tree-root="${owned('file', owner, picked)}"]`)
      const listed = await pickedTree
        .locator('[data-tree-name="inside-picked.txt"]')
        .waitFor({ state: 'visible', timeout: 15_000 })
        .then(
          () => true,
          () => false
        )
      t.check(
        'the side panel’s file tree lists the picked folder’s content from the server',
        listed
      )
    }
    t.equal('Another folder… never opened this Mac’s folder dialog', await nativeCalls(), 0)

    // ── 3. A folder of this Mac dropped on the server tab's composer ────────
    const composer = chat.getByRole('textbox', { name: 'Message', exact: true })
    await eventually(() => composer.isEnabled(), 'the server chat’s composer is enabled')
    const drop = (target, kind, value) =>
      target.evaluate(
        (el, { kind, value }) => {
          const dt = new DataTransfer()
          dt.setData(kind, value)
          el.dispatchEvent(
            new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })
          )
        },
        { kind, value }
      )
    const settled = () => new Promise((resolve) => setTimeout(resolve, 2500))
    const serverName = mac.owners[0].name
    const card = chat.locator('.chat-composer-wrap [data-drop-refusal]')
    const cardShown = (count) =>
      eventually(
        async () =>
          (await card.getAttribute('data-drop-refusal', { timeout: 100 }).catch(() => null)) ===
          count,
        `the refusal card counts ${count}`
      ).then(
        () => true,
        () => false
      )
    const cardGone = (how) =>
      eventually(async () => (await card.count()) === 0, `the card goes on ${how}`).then(
        () => true,
        () => false
      )
    // A missing card fails its check at once rather than waiting out the spec.
    const text = (locator) => locator.textContent({ timeout: 3000 }).catch(() => null)
    const composerFocused = () =>
      chat.evaluate((root) => {
        const active = document.activeElement
        return active?.getAttribute('aria-label') === 'Message' && root.contains(active)
      })
    await composer.fill('')
    await drop(composer, 'text/uri-list', `file://${macFolder}`)
    await settled()
    t.check(
      'a Mac folder dropped from the desktop puts no path of this Mac in a server tab’s message',
      !(await composer.inputValue()).includes(macFolder),
      await composer.inputValue()
    )
    t.check('the refusal card comes up above the composer for the folder', await cardShown('1'))
    t.equal(
      'its title says the folders stay on this Mac',
      await text(card.locator('.notice-card-title')),
      'Folders stay on this Mac'
    )
    t.equal(
      'its sentence names the server the tab runs on',
      await text(card.locator('.notice-card-body')),
      `This session runs on ${serverName}, which can't open the folders on your Mac. Drop files instead: they are copied to the server.`
    )
    t.check(
      'it is a warning, said by its icon and its word',
      (await card.getAttribute('data-tone', { timeout: 3000 }).catch(() => null)) === 'warning' &&
        (await text(card.locator('.notice-card-tone'))) === 'Warning' &&
        (await card.locator('.notice-card-eyebrow svg').count()) === 1
    )
    t.equal(
      'the conversation gets no line of its own for it',
      await chat.locator('.chat-notice', { hasText: path.basename(macFolder) }).count(),
      0
    )
    t.check('the caret stays in the composer under the card', await composerFocused())
    await win.keyboard.type('still typing')
    t.equal('typing goes on with the card up', await composer.inputValue(), 'still typing')
    await win.keyboard.press('Escape')
    t.check('Escape from the composer takes the card away', await cardGone('Escape'))
    t.equal('Escape leaves what was typed', await composer.inputValue(), 'still typing')

    await composer.fill('')
    await drop(composer, 'text/plain', macFolders.join('\n'))
    await settled()
    const typed = await composer.inputValue()
    t.check(
      'Mac folders dragged as text put no path of this Mac in a server chat’s message',
      !macFolders.some((folder) => typed.includes(folder)),
      typed
    )
    t.check('several folders of one drop make one card', await cardShown('3'))
    t.equal(
      'its title is in the plural',
      await text(card.locator('.notice-card-title')),
      '3 folders stay on this Mac'
    )
    // A plain file of this Mac does go to the server, and takes the card away.
    await drop(composer, 'text/uri-list', `file://${macFile}`)
    const landed = await eventually(
      async () =>
        (await text(chat.locator('.chat-composer-files')))?.includes('goes-to-the-server.txt'),
      'the file is attached'
    ).then(
      () => true,
      () => false
    )
    t.check('a plain file dropped next is attached', landed)
    t.check('the next file that lands takes the card away', await cardGone('an attach'))

    // The same tab in the Enclave view: its own drop of a path as text.
    await win.getByLabel('Session menu', { exact: true }).click()
    const enclave = win.locator('.view-tile', { hasText: /^Enclave$/ })
    await enclave.waitFor()
    await win.waitForTimeout(500)
    await enclave.click({ force: true })
    const terminalComposer = pane.locator('.terminal-view textarea:not(:disabled)')
    await terminalComposer.waitFor()
    await terminalComposer.fill('')
    await drop(terminalComposer, 'text/plain', macFolder)
    await settled()
    t.check(
      'a Mac folder dragged as text puts no path of this Mac in a server tab’s Enclave message',
      !(await terminalComposer.inputValue()).includes(macFolder),
      await terminalComposer.inputValue()
    )
    const termCard = pane.locator('.term-composer-wrap [data-drop-refusal]')
    const termShown = await eventually(
      async () => (await termCard.count()) === 1,
      'the Enclave view’s refusal card comes up'
    ).then(
      () => true,
      () => false
    )
    t.check('the Enclave view raises the same card above its composer', termShown)
    if (termShown) {
      t.check(
        'it names the server too',
        (await text(termCard.locator('.notice-card-body')))?.includes(serverName),
        await text(termCard.locator('.notice-card-body'))
      )
      await termCard.getByRole('button', { name: 'Dismiss', exact: true }).click({ timeout: 3000 })
      t.check(
        'its X takes it away',
        await eventually(async () => (await termCard.count()) === 0, 'the X closes the card').then(
          () => true,
          () => false
        )
      )
    }

    // ── 4. A server's file tab offers no Reveal in Finder ───────────────────
    const tree = win.locator(`[data-file-tree-root="${owned('file', owner, server.root)}"]`)
    if (!(await tree.isVisible())) {
      await clickReady(scope)
      await clickReady(win.locator('[data-scope-option="workspace"]'))
    }
    const probe = tree.locator('[data-tree-name="reveal-probe.txt"]')
    await probe.waitFor({ state: 'visible' })
    await probe.click({ button: 'right' })
    await clickReady(win.getByRole('menuitem', { name: 'Open in Tab', exact: true }))
    const fileRow = win.locator('.sidebar-item', { hasText: 'reveal-probe.txt' }).first()
    await fileRow.waitFor({ state: 'visible' })
    await fileRow.click({ button: 'right' })
    await win.getByRole('menuitem', { name: 'Copy Path', exact: true }).waitFor()
    t.equal(
      'a server’s file tab offers no Reveal in Finder',
      await win.getByRole('menuitem', { name: 'Reveal in Finder', exact: true }).count(),
      0
    )
    await win.keyboard.press('Escape')
    assert.deepEqual(mac.errors, [])
  } finally {
    await world.close()
  }
}
