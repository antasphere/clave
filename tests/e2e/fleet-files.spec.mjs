import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fleetWorld, connectMac, eventually, owned } from './fixtures/fleet-world.mjs'

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
export async function run(t) {
  const world = await fleetWorld('files')
  try {
    const report = world.load()
    const [a, b] = world.servers
    const value = report.values.first
    const other = report.values.second
    const mac = await world.mac('a')
    await connectMac(mac, world.servers)
    const macB = await world.mac('b')
    await connectMac(macB, world.servers, { ui: false })
    const owner = mac.owners[0].id
    const session = owned('session', owner, value.sessionId)
    await mac.win.locator(`[data-sidebar-item-id="${session}"]`).click()
    const tree = mac.win.locator(`[data-fleet-files="${owner}"]`)
    if (!(await tree.count())) await mac.win.getByTitle(/^File tree/).click()
    await tree.getByRole('button', { name: value.directory, exact: true }).click()
    await tree.getByRole('button', { name: 'notes.txt', exact: true }).click()
    const editor = mac.win.locator('.cm-content[contenteditable="true"]:visible')
    await editor.waitFor()
    await editor.fill('Edited on owner one through the desktop')
    await editor.press('Meta+s')
    await eventually(
      () =>
        readFileSync(path.join(a.root, value.file), 'utf8') ===
        'Edited on owner one through the desktop',
      'UI editor saves on owning filesystem'
    )
    assert.equal(readFileSync(path.join(b.root, other.file), 'utf8'), other.content)
    const peerRead = await macB.win.evaluate(
      ({ root, file }) => window.electronAPI.readFile(root, file),
      { root: owned('file', macB.owners[0].id, a.root), file: value.file }
    )
    assert.equal(peerRead.content, 'Edited on owner one through the desktop')
    t.check('remote file editor writes real owner bytes and the second Mac reads the edit', true)

    await mac.win.locator(`[data-sidebar-item-id="${session}"]`).click()
    if (!(await tree.count())) await mac.win.getByTitle(/^File tree/).click()
    await tree.getByRole('button', { name: value.directory, exact: true }).click()

    const source = path.join(mac.root, 'mac-upload.txt')
    writeFileSync(source, 'Mac upload byte sentinel')
    // Only the native picker is a test adapter. The real preload, owning
    // Files API and descriptor-relative writer perform the transfer.
    await mac.app.evaluate(({ dialog }, source) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] })
    }, source)
    await tree.getByRole('button', { name: 'Upload', exact: true }).click()
    const uploaded = `${value.directory}/mac-upload.txt`
    let uploadComplete = false
    try {
      await eventually(() => existsSync(path.join(a.root, uploaded)), 'remote upload completes')
      uploadComplete = true
    } catch (error) {
      t.check(
        'UI upload transfers exact bytes to the owning server',
        false,
        `${error.message}; ${await tree.innerText()}`
      )
    }
    if (uploadComplete) {
      assert.equal(readFileSync(path.join(a.root, uploaded), 'utf8'), 'Mac upload byte sentinel')
      assert.equal(existsSync(path.join(b.root, uploaded)), false)
      t.check('UI upload transfers exact bytes to the owning server', true)
    }
    const downloaded = path.join(mac.root, 'downloaded-notes.txt')
    await mac.app.evaluate(({ dialog }, target) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: target })
    }, downloaded)
    await tree.getByLabel('Download notes.txt', { exact: true }).click()
    await eventually(() => existsSync(downloaded), 'remote download reaches selected Mac path')
    assert.equal(readFileSync(downloaded, 'utf8'), 'Edited on owner one through the desktop')
    t.check('UI download transfers exact owner bytes to the selected Mac path', true)

    await mac.win.locator(`[data-sidebar-item-id="${session}"]`).click()
    const localImage = path.join(mac.root, 'mac-local.png')
    writeFileSync(localImage, Buffer.from(PNG, 'base64'))
    const attachment = await mac.win.evaluate(
      ({ session, source }) => window.electronAPI.sessionsFiles.prepare(session, { path: source }),
      { session, source: localImage }
    )
    const remotePath = decodeURIComponent(attachment.path.split(':').at(-1))
    assert.ok(
      remotePath.startsWith(path.join(realpathSync(a.dataDir), 'session-attachments') + '/')
    )
    assert.notEqual(remotePath, realpathSync(localImage))
    assert.equal(readFileSync(remotePath).toString('base64'), PNG)
    const preview = await mac.win.evaluate(
      (file) => window.electronAPI.sessionsFiles.preview(file),
      attachment
    )
    assert.equal(preview.image.split(',').at(-1), PNG)
    await mac.win.evaluate(
      ({ session, attachment }) =>
        window.electronAPI.sessionsWrite(session, {
          type: 'user_message',
          text: 'Local image delivered to its remote agent',
          attachments: [attachment]
        }),
      { session, attachment }
    )
    await mac.win
      .locator(`[data-session-id="${session}"] .chat-turn[data-role="assistant"]`)
      .filter({ hasText: '(1 image received)' })
      .waitFor()
    const peerSession = owned('session', macB.owners[0].id, value.sessionId)
    const history = await macB.win.evaluate(
      (id) => window.electronAPI.sessionsHistory(id),
      peerSession
    )
    assert.ok(JSON.stringify(history).includes('Local image delivered to its remote agent'))
    assert.deepEqual(mac.errors, [])
    assert.deepEqual(macB.errors, [])
    t.check(
      'Mac image is uploaded as real remote bytes, previews correctly and reaches the owner adapter',
      true
    )
  } finally {
    await world.close()
  }
}
