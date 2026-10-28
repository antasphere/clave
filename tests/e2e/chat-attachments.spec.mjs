import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { until, fixturePath } from './harness.mjs'
import { openChat } from './chat-view.spec.mjs'

/* Files into the chat composer: dropped on the pane, pasted, or picked with
   the paperclip. Each becomes a chip the reader can still remove; sending
   carries the attachment records through the real write IPC, main prepares
   the prompt from the files, and the echo adapter's reply proves what the
   provider was actually handed — image bytes for an image, a path line for
   a reference. Every step asserts; a stubbed handler still delivers to the
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
    t.check('a dropped image becomes a chip with a thumbnail, behind a pane-wide overlay', true)

    // 2. An image alone is a message. The write carries the record, never the
    //    bytes; the echo reply says the provider received the image content.
    assert.equal(await send.isDisabled(), false, 'an attachment alone can be sent')
    await send.click()
    assert.ok(
      await until(async () => (await userMessages()).length === 1),
      'the image-only message must cross the write IPC'
    )
    const [imageWrite] = await userMessages()
    assert.equal(imageWrite.text, '')
    assert.equal(imageWrite.attachments.length, 1)
    assert.equal(imageWrite.attachments[0].delivery, 'image')
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
    await input.fill('read this')
    await input.press('Enter')
    assert.ok(
      await until(async () => (await userMessages()).length === 2),
      'the reference message must cross the write IPC'
    )
    const referenceWrite = (await userMessages())[1]
    assert.equal(referenceWrite.text, 'read this')
    assert.equal(referenceWrite.attachments[0].delivery, 'reference')
    assert.equal(referenceWrite.attachments[0].name, 'notes.txt')
    const reply = win.locator('.chat-turn[data-role="assistant"]').filter({ hasText: 'read this' })
    await reply.waitFor()
    const replyText = await reply.innerText()
    assert.match(replyText, /Attached local files/)
    assert.match(replyText, /notes\.txt/)
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
    assert.equal(await input.inputValue(), '', 'a file paste types nothing')
    assert.ok(
      await until(async () => !(await send.isDisabled())),
      'a pasted image alone must enable send'
    )
    await pasted.getByRole('button', { name: 'Remove image.png', exact: true }).click()
    assert.ok(
      await until(async () => (await composerChips.count()) === 0),
      'removing the only chip must empty the composer'
    )
    assert.equal(await send.isDisabled(), true)
    t.check('a pasted image is a chip that can be removed, and send follows', true)

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
      await until(async () => (await input.inputValue()) !== ''),
      'the dropped paths must reach the composer'
    )
    assert.equal(await input.inputValue(), "'/Users/example/src dir' /Users/example/src/c.ts ")
    assert.equal(await composerChips.count(), 10, 'a text drop attaches nothing')
    t.check('paths dragged from the file and git panels still paste at the caret', true)
    assert.ok(record.id)
  } finally {
    await close()
  }
}
