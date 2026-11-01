import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
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
    const shotChip = composerChips.filter({ hasText: 'shot.png' }).filter({ hasText: /Image #1/i })
    await shotChip.waitFor()
    assert.match(await shotChip.innerText(), /\d+ B/)
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
    const notesChip = composerChips.filter({ hasText: 'notes.txt' }).filter({ hasText: 'Text ·' })
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
    const pasted = composerChips.filter({ hasText: 'image.png' }).filter({ hasText: /Image #1/i })
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
    await composerChips
      .filter({ hasText: 'again.png' })
      .filter({ hasText: /Image #1/i })
      .waitFor()
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

    // 5. A folder is a record of its own. Dropped from the desktop (the
    //    desktop's own drop, through the devtools protocol: real File objects
    //    with their paths) it becomes a chip naming its item count, a marker
    //    in the text, and a line the provider gets under that marker. What
    //    main refuses, a named pipe here, still lands as its path with the
    //    reason beside it: a drop never fails. And a file's chip names its
    //    family, from the media type its name says.
    const folder = path.join(root, 'drop folder')
    mkdirSync(folder, { recursive: true })
    writeFileSync(path.join(folder, 'inside.txt'), 'in')
    await app.evaluate(({ ipcMain }) => {
      const original = ipcMain._invokeHandlers.get('sessions:files')
      globalThis.__prepared = []
      ipcMain._invokeHandlers.set('sessions:files', (event, request) => {
        if (request.type === 'prepare') globalThis.__prepared.push(request.source?.path ?? '')
        return original(event, request)
      })
    })
    const prepared = () => app.evaluate(() => globalThis.__prepared)
    const cdp = await app.context().newCDPSession(win)
    const box = await win.locator(pane).boundingBox()
    const at = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }
    const data = { items: [], files: [folder], dragOperationsMask: 1 }
    for (const type of ['dragEnter', 'dragOver', 'drop'])
      await cdp.send('Input.dispatchDragEvent', { type, ...at, data })
    await cdp.detach()
    const folderChip = composerChips
      .filter({ hasText: 'drop folder' })
      .filter({ hasText: /Folder #1/i })
    await folderChip.waitFor()
    // The tag says Folder; the hint adds only the count.
    assert.match(await folderChip.innerText(), /Folder #1\s*1 item\b/i, 'the chip counts its items')
    assert.equal(await input.inputValue(), '[Folder #1] ', 'the folder marker lands in the text')
    assert.deepEqual(await prepared(), [folder], 'main made the folder record')
    assert.equal(await win.getByRole('alert').count(), 0, 'a folder is no error')
    await input.press('End')
    await input.pressSequentially('list it')
    await input.press('Enter')
    assert.ok(
      await until(async () => (await userMessages()).length === 3),
      'the folder message must cross the write IPC'
    )
    const folderWrite = (await userMessages())[2]
    assert.equal(folderWrite.text, '[Folder #1] list it')
    assert.deepEqual(
      folderWrite.attachments.map((a) => [a.delivery, a.name, a.entries, a.label]),
      [['folder', 'drop folder', 1, 'Folder #1']]
    )
    const folderReply = win
      .locator('.chat-turn[data-role="assistant"]')
      .filter({ hasText: 'list it' })
    await folderReply.waitFor()
    const folderReplyText = await folderReply.innerText()
    // The reply is Markdown: the legend's bullets render as a list, their dashes gone.
    assert.match(folderReplyText, /a local folder: list and read its contents at its path\./)
    assert.match(folderReplyText, /\[Folder #1\] \{"folder":"drop folder"/)
    assert.ok(
      await until(async () => (await composerChips.count()) === 0),
      'the composer must clear its chips with the send'
    )
    t.check(
      'a folder dropped from the desktop is a chip with its item count and a marker the provider lists',
      true
    )

    const pipe = path.join(root, 'pipe')
    execFileSync('mkfifo', [pipe])
    const dropUrl = (url) =>
      win.evaluate(
        ({ selector, url }) => {
          const dt = new DataTransfer()
          dt.setData('text/uri-list', url)
          document
            .querySelector(selector)
            .dispatchEvent(
              new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })
            )
        },
        { selector: pane, url }
      )
    await dropUrl(`file://${pipe}`)
    assert.ok(
      await until(async () => (await input.inputValue()) !== ''),
      'the refused pipe must still reach the composer as a path'
    )
    assert.ok((await input.inputValue()).endsWith('/pipe '), 'as the path it was dropped with')
    assert.equal(await composerChips.count(), 0, 'and leaves no chip behind, errored or not')
    await win
      .getByRole('alert')
      .filter({ hasText: 'Special files cannot be attached.' })
      .filter({ hasText: 'pipe is in the message as a path.' })
      .waitFor()
    await input.fill('')
    t.check('what main refuses lands as its path anyway, the reason reported beside it', true)

    const clip = path.join(root, 'clip.mp4')
    writeFileSync(clip, '')
    await dropUrl(`file://${clip}`)
    const clipChip = composerChips.filter({ hasText: 'clip.mp4' }).filter({ hasText: 'Video ·' })
    await clipChip.waitFor()
    assert.match(await clipChip.innerText(), /File #\d+/i, 'a video goes as a path: a File')
    await input.fill('')
    assert.ok(
      await until(async () => (await composerChips.count()) === 0),
      'emptying the text must empty the chips'
    )
    t.check("a file's chip names its family from its media type", true)

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
    const sessionChip = composerChips.filter({ hasText: /Session #\d+/i })
    await sessionChip.waitFor()
    assert.match(await sessionChip.innerText(), /Session #1/i)
    assert.equal(await input.inputValue(), 'finish when [Session #1] ')
    await fire('clave:sessions-drop', { sessionIds: [record.id] })
    assert.equal(await sessionChip.count(), 1, 'a tab is attached once')
    await input.press('End')
    await input.pressSequentially('is done')
    await input.press('Enter')
    assert.ok(
      await until(async () => (await userMessages()).length === 4),
      'the session message must cross the write IPC'
    )
    const sessionWrite = (await userMessages())[3]
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
      .filter({ hasText: /Session #1/i })
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
