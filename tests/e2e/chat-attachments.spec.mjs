import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { until, fixturePath } from './harness.mjs'
import { openChat } from './chat-view.spec.mjs'

/* Files and sessions into the chat composer: dropped on the pane, pasted,
   picked with the paperclip, or a sidebar tab dragged over. Each becomes a
   chip the reader can still remove and a marker in the text (`[Image #1]`,
   `[File #1]`, `[Session #1]`) that names it there; the marker and the chip
   are one thing, each removed with the other. Sending carries the attachment
   records through the real write IPC, main prepares the prompt from them,
   and the echo adapter's reply proves what the provider was actually handed
   — image bytes for an image, a path line for a reference, a session line
   for a tab. Every step asserts; a stubbed handler still delivers to the
   real one, so nothing here passes on the stub's word alone. */

// A 1x1 PNG: what a pasted screenshot is, at the smallest size that is one.
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

/** Dispatch a drag event carrying `files` (name → base64 bytes) on `target`. */
async function dragFiles(win, selector, type, files) {
  await win.evaluate(
    ({ selector, type, files }) => {
      const dt = new DataTransfer()
      for (const [name, base64] of Object.entries(files)) {
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
        dt.items.add(new File([bytes], name, { type: 'image/png' }))
      }
      document
        .querySelector(selector)
        .dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }))
    },
    { selector, type, files }
  )
}

export async function run(t) {
  const { app, win, record, fixture, close } = await openChat('chat-attachments')
  const root = fixturePath('chat-attachments-root')
  try {
    await fixture.evaluate(() => {
      const host = globalThis.__claveE2E.sessionHost
      const write = host.write
      globalThis.__chatWrites = []
      host.write = (id, input) => {
        globalThis.__chatWrites.push(input)
        return write.call(host, id, input)
      }
    })
    const pane = '[data-testid="chat-view"]'
    const input = win.locator(`${pane} textarea`)
    const send = win.getByRole('button', { name: 'Send message', exact: true })
    const composerChips = win.locator('.chat-composer .chat-attachment')
    const userMessages = () =>
      fixture.evaluate(() => globalThis.__chatWrites.filter((x) => x.type === 'user_message'))

    // 1. A files drag shows the overlay over the whole pane; the drop makes a chip.
    await dragFiles(win, pane, 'dragenter', { 'shot.png': PNG })
    await win.locator('.chat-drop-overlay').waitFor()
    assert.match(await win.locator('.chat-drop-overlay').innerText(), /Add files to the message/)
    assert.equal(await send.isDisabled(), true, 'nothing to send yet')
    await dragFiles(win, pane, 'drop', { 'shot.png': PNG })
    assert.ok(
      await until(async () => (await win.locator('.chat-drop-overlay').count()) === 0),
      'the overlay must leave on drop'
    )
    // The placeholder ("Preparing…") wears the same class as the chip that
    // replaces it; the chip is the one that names its delivery.
    const shotChip = composerChips.filter({ hasText: 'shot.png' }).filter({ hasText: 'Image ·' })
    await shotChip.waitFor()
    assert.match(await shotChip.innerText(), /Image · \d+ B/)
    // The thumbnail is main's render of the bytes it stored, not the File the
    // renderer dropped: it arriving proves the pasted-image path wrote a real PNG.
    await shotChip.locator('img.chat-attachment-thumb').waitFor()
    assert.match(await shotChip.innerText(), /Image #1/i, 'the chip shows its label as a tag')
    assert.equal(await input.inputValue(), '[Image #1] ', 'the marker lands in the text')
    t.check(
      'a dropped image becomes a labelled chip and a marker, behind a pane-wide overlay',
      true
    )

    // 2. An image alone is a message. The write carries the record, never the
    //    bytes; the echo reply says the provider received the image content.
    assert.equal(await send.isDisabled(), false, 'an attachment alone can be sent')
    await send.click()
    assert.ok(
      await until(async () => (await userMessages()).length === 1),
      'the image-only message must cross the write IPC'
    )
    const [imageWrite] = await userMessages()
    assert.equal(imageWrite.text, '[Image #1] ', 'the text goes as written, marker included')
    assert.equal(imageWrite.attachments.length, 1)
    assert.equal(imageWrite.attachments[0].delivery, 'image')
    assert.equal(imageWrite.attachments[0].label, 'Image #1')
    assert.equal(imageWrite.attachments[0].mimeType, 'image/png')
    assert.equal('prepared' in imageWrite, false, 'the renderer never supplies the prompt')
    assert.equal(
      JSON.stringify(imageWrite).includes(PNG),
      false,
      'no base64 crosses from the renderer'
    )
    const sentChip = win.locator('.chat-turn-wrap[data-side="end"] .chat-attachment')
    await sentChip.filter({ hasText: 'shot.png' }).waitFor()
    assert.equal(
      await sentChip.getByRole('button', { name: /^Remove/ }).count(),
      0,
      'a sent chip cannot be removed'
    )
    await win
      .locator('.chat-turn[data-role="assistant"]')
      .filter({ hasText: '(1 image received)' })
      .waitFor()
    assert.ok(
      await until(async () => (await composerChips.count()) === 0),
      'the composer must clear its chips with the send'
    )
    t.check(
      'an image-only message sends; main reads the bytes and the provider receives them',
      true
    )

    // 3. A file URL from another app is a reference: the provider gets its path
    //    appended to the text, the reader sees text and chip together.
    mkdirSync(root, { recursive: true })
    const notes = path.join(root, 'notes.txt')
    writeFileSync(notes, 'the notes')
    await win.evaluate(
      ({ selector, url }) => {
        const dt = new DataTransfer()
        dt.setData('text/uri-list', url)
        document
          .querySelector(selector)
          .dispatchEvent(
            new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })
          )
      },
      { selector: pane, url: `file://${notes}` }
    )
    const notesChip = composerChips
      .filter({ hasText: 'notes.txt' })
      .filter({ hasText: 'File reference' })
    await notesChip.waitFor()
    assert.equal(await input.inputValue(), '[File #1] ', 'a file is labelled by its delivery')
    await input.press('End')
    await input.pressSequentially('read this')
    await input.press('Enter')
    assert.ok(
      await until(async () => (await userMessages()).length === 2),
      'the reference message must cross the write IPC'
    )
    const referenceWrite = (await userMessages())[1]
    assert.equal(referenceWrite.text, '[File #1] read this')
    assert.equal(referenceWrite.attachments[0].delivery, 'reference')
    assert.equal(referenceWrite.attachments[0].name, 'notes.txt')
    assert.equal(referenceWrite.attachments[0].label, 'File #1')
    const reply = win.locator('.chat-turn[data-role="assistant"]').filter({ hasText: 'read this' })
    await reply.waitFor()
    const replyText = await reply.innerText()
    assert.match(replyText, /Attachments, by the marker/)
    assert.match(replyText, /\[File #1\] \{"name":"notes\.txt"/)
    assert.equal(await input.inputValue(), '', 'the draft clears with the send')
    t.check('a dropped file URL is a reference the provider receives as a path line', true)

    // 4. A pasted screenshot is a file on the clipboard; the chip can be
    //    removed again, and removing the only attachment disables send.
    await input.evaluate((el, base64) => {
      const dt = new DataTransfer()
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
      dt.items.add(new File([bytes], 'image.png', { type: 'image/png' }))
      el.dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt })
      )
    }, PNG)
    const pasted = composerChips.filter({ hasText: 'image.png' }).filter({ hasText: 'Image ·' })
    await pasted.waitFor()
    assert.equal(await input.inputValue(), '[Image #1] ', 'a paste types only its marker')
    assert.ok(
      await until(async () => !(await send.isDisabled())),
      'a pasted image alone must enable send'
    )
    await pasted.getByRole('button', { name: 'Remove image.png', exact: true }).click()
    assert.ok(
      await until(async () => (await composerChips.count()) === 0),
      'removing the only chip must empty the composer'
    )
    assert.equal(await input.inputValue(), '', 'the chip leaving takes its marker with it')
    assert.equal(await send.isDisabled(), true)
    t.check('a pasted image is a chip that can be removed, and its marker goes with it', true)

    // 4b. The other way round: the marker edited out of the text takes the
    //     chip with it — `[Image #1] ` to `[Image #1` is no marker any more.
    await input.evaluate((el, base64) => {
      const dt = new DataTransfer()
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
      dt.items.add(new File([bytes], 'again.png', { type: 'image/png' }))
      el.dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt })
      )
    }, PNG)
    await composerChips.filter({ hasText: 'again.png' }).filter({ hasText: 'Image ·' }).waitFor()
    assert.equal(await input.inputValue(), '[Image #1] ', 'a cleared composer numbers from one')
    await input.press('End')
    await input.press('Backspace')
    await input.press('Backspace')
    assert.equal(await input.inputValue(), '[Image #1')
    assert.ok(
      await until(async () => (await composerChips.count()) === 0),
      'a marker broken in the text must remove its chip'
    )
    await input.fill('')
    t.check('a marker edited out of the text removes its attachment', true)

    // 5. A folder is a path to talk about, never a file to attach, and a drop
    //    never fails. Dropped from Finder, the item's entry names the folder:
    //    its path lands at the caret, no chip, nothing sent to main. From an
    //    app that hands only a URL, main refuses the folder as a file and the
    //    path lands anyway, with the reason reported beside it.
    const folder = path.join(root, 'drop folder')
    mkdirSync(folder, { recursive: true })
    await app.evaluate(({ ipcMain }) => {
      const original = ipcMain._invokeHandlers.get('sessions:files')
      globalThis.__prepared = []
      ipcMain._invokeHandlers.set('sessions:files', (event, request) => {
        if (request.type === 'prepare') globalThis.__prepared.push(request.source?.path ?? '')
        return original(event, request)
      })
    })
    const prepared = () => app.evaluate(() => globalThis.__prepared)
    // The desktop's own drop, through the devtools protocol: real File
    // objects with paths and entries, the way Finder hands them.
    const cdp = await app.context().newCDPSession(win)
    const box = await win.locator(pane).boundingBox()
    const at = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }
    const data = { items: [], files: [folder], dragOperationsMask: 1 }
    for (const type of ['dragEnter', 'dragOver', 'drop'])
      await cdp.send('Input.dispatchDragEvent', { type, ...at, data })
    await cdp.detach()
    assert.ok(
      await until(async () => (await input.inputValue()) !== ''),
      "the folder's path must reach the composer"
    )
    assert.equal(await input.inputValue(), `'${folder}' `)
    assert.equal(await composerChips.count(), 0, 'a folder attaches nothing')
    assert.equal(await win.getByRole('alert').count(), 0, 'a folder Finder names is no error')
    assert.deepEqual(await prepared(), [], 'a folder Finder names is never sent to main as a file')
    t.check(
      'a folder dropped from the desktop lands as its path at the caret, no chip, no error',
      true
    )

    await input.fill('')
    await win.evaluate(
      ({ selector, url }) => {
        const dt = new DataTransfer()
        dt.setData('text/uri-list', url)
        document
          .querySelector(selector)
          .dispatchEvent(
            new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })
          )
      },
      { selector: pane, url: `file://${folder}` }
    )
    assert.ok(
      await until(async () => (await input.inputValue()) !== ''),
      'the refused folder must still reach the composer as a path'
    )
    assert.equal(await input.inputValue(), `'${folder}' `)
    assert.deepEqual(await prepared(), [folder], 'a folder named only by URL is tried as a file')
    assert.equal(await composerChips.count(), 0, 'and leaves no chip behind, errored or not')
    await win
      .getByRole('alert')
      .filter({ hasText: 'Folders and special files cannot be attached.' })
      .filter({ hasText: 'drop folder is in the message as a path.' })
      .waitFor()
    await input.fill('')
    t.check('a folder main refuses lands as its path anyway, the reason reported beside it', true)

    // 6. The paperclip opens the native picker; a picker answering with more
    //    than the cap fills the cap and says so, adding nothing past it.
    const many = Array.from({ length: 11 }, (_, i) => {
      const file = path.join(root, `pick-${i}.txt`)
      writeFileSync(file, `pick ${i}`)
      return file
    })
    await app.evaluate(({ ipcMain }, paths) => {
      const original = ipcMain._invokeHandlers.get('sessions:files')
      ipcMain._invokeHandlers.set('sessions:files', (event, request) =>
        request.type === 'pick' ? paths : original(event, request)
      )
    }, many)
    await win.getByRole('button', { name: 'Add files', exact: true }).click()
    assert.ok(
      await until(async () => (await composerChips.count()) === 10),
      'the picker must fill the cap'
    )
    await win.getByRole('alert').filter({ hasText: 'Attach up to 10 files' }).waitFor()
    assert.equal(await composerChips.filter({ hasText: 'pick-10.txt' }).count(), 0)
    // The draft is the host's and follows the chips by a render.
    assert.ok(
      await until(async () => (await input.inputValue()).match(/\[File #\d+\] /g)?.length === 10),
      'ten files, ten markers, in the text'
    )
    t.check('the paperclip picks files, and the cap holds at ten with a visible reason', true)

    // 7. The paths Clave's own panels drag as text still land at the caret,
    //    quoted when a shell would need it: a folder is something to talk
    //    about, not a file to attach.
    await win.evaluate((selector) => {
      const dt = new DataTransfer()
      dt.setData('text/plain', '/Users/example/src dir\n/Users/example/src/c.ts')
      document
        .querySelector(selector)
        .dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
    }, pane)
    assert.ok(
      await until(async () =>
        (await input.inputValue()).includes("'/Users/example/src dir' /Users/example/src/c.ts ")
      ),
      'the dropped paths must reach the composer, beside the markers'
    )
    assert.equal(await composerChips.count(), 10, 'a text drop attaches nothing')
    t.check('paths dragged from the file and git panels still paste at the caret', true)

    // 8. A sidebar tab dragged onto the pane. The sidebar's drag is pointer
    //    based, so the pane is reached through the session-drag events
    //    (`lib/session-drag.ts`): hovering shows the overlay, the drop makes
    //    a session chip and a marker, and the provider receives a session
    //    line it can act on with the Clave tools. The composer is cleared
    //    first: the cap is full.
    await input.fill('')
    assert.ok(
      await until(async () => (await composerChips.count()) === 0),
      'emptying the text must empty the chips'
    )
    const fire = (name, detail) =>
      win.evaluate(
        ({ selector, name, detail }) =>
          document.querySelector(selector).dispatchEvent(new CustomEvent(name, { detail })),
        { selector: pane, name, detail }
      )
    await fire('clave:sessions-drag-enter')
    await win.locator('.chat-drop-overlay').waitFor()
    assert.match(await win.locator('.chat-drop-overlay').innerText(), /Add the session/)
    await fire('clave:sessions-drag-leave')
    assert.ok(
      await until(async () => (await win.locator('.chat-drop-overlay').count()) === 0),
      'the overlay must leave with the drag'
    )
    await input.pressSequentially('finish when ')
    await fire('clave:sessions-drop', { sessionIds: [record.id] })
    const sessionChip = composerChips.filter({ hasText: 'Session ·' })
    await sessionChip.waitFor()
    assert.match(await sessionChip.innerText(), /Session #1/i)
    assert.equal(await input.inputValue(), 'finish when [Session #1] ')
    await fire('clave:sessions-drop', { sessionIds: [record.id] })
    assert.equal(await sessionChip.count(), 1, 'a tab is attached once')
    await input.press('End')
    await input.pressSequentially('is done')
    await input.press('Enter')
    assert.ok(
      await until(async () => (await userMessages()).length === 3),
      'the session message must cross the write IPC'
    )
    const sessionWrite = (await userMessages())[2]
    assert.equal(sessionWrite.text, 'finish when [Session #1] is done')
    assert.deepEqual(
      sessionWrite.attachments.map((a) => [a.delivery, a.sessionId, a.label]),
      [['session', record.id, 'Session #1']]
    )
    const sessionReply = win
      .locator('.chat-turn[data-role="assistant"]')
      .filter({ hasText: 'is done' })
    await sessionReply.waitFor()
    const sessionReplyText = await sessionReply.innerText()
    assert.match(sessionReplyText, /clave_read_session/)
    assert.match(
      sessionReplyText,
      new RegExp(`\\[Session #1\\] \\{"session":"${record.id}"`),
      'the provider gets the session id under its marker'
    )
    await win
      .locator('.chat-turn-wrap[data-side="end"] .chat-attachment')
      .filter({ hasText: 'Session ·' })
      .waitFor()
    t.check('a sidebar tab dropped on the pane is a session the agent can address', true)

    // 9. The real gesture: a sidebar row dragged with the pointer and released
    //    over the pane goes through the same events, from the sidebar's own
    //    drag hook. The row must move past the drag threshold first.
    const row = win.locator(`[data-sidebar-item-id="${record.id}"] button`).first()
    const rowBox = await row.boundingBox()
    const paneBox = await win.locator(pane).boundingBox()
    assert.ok(rowBox && paneBox, 'the row and the pane are on screen')
    await win.mouse.move(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2)
    await win.mouse.down()
    await win.mouse.move(rowBox.x + rowBox.width / 2 + 12, rowBox.y + rowBox.height / 2 + 12, {
      steps: 4
    })
    await win.mouse.move(paneBox.x + paneBox.width / 2, paneBox.y + paneBox.height / 2, {
      steps: 8
    })
    await win.locator('.chat-drop-overlay').waitFor()
    await win.mouse.up()
    await sessionChip.waitFor()
    assert.equal(await input.inputValue(), '[Session #1] ')
    assert.ok(
      await until(async () => (await win.locator('.chat-drop-overlay').count()) === 0),
      'the overlay must leave with the drop'
    )
    t.check('a sidebar row dragged with the pointer and released on the pane attaches it', true)
    assert.ok(record.id)
  } finally {
    await close()
  }
}
