// A look at the composer's attachments, not a check: launches the real app
// through the e2e harness, brings the drop overlay up for files and for a
// session, attaches an image, a file and a tab, and screenshots each state in
// the dark and the light theme into the folder named as the first argument.
// It runs through the runner, from the specs folder (the runner's alternate
// specs-dir mode boots no app, so copy it beside the specs for the run):
//   npx electron-vite build
//   sed -e "s#'../#'./#g" tests/e2e/look/chat-attachments.spec.mjs > tests/e2e/zz-look.spec.mjs
//   CLAVE_LOOK_OUT=/tmp/shots node tests/e2e/run.mjs zz-look; rm tests/e2e/zz-look.spec.mjs
// Nothing here asserts beyond having run; the screenshots are for eyes, and
// are never committed. It lives outside the specs folder so CI never runs it.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fixturePath, until } from '../harness.mjs'
import { openChat } from '../chat-view.spec.mjs'

const out = process.env.CLAVE_LOOK_OUT || '/tmp/clave-look'
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAYAAAC7UlqVAAAAJklEQVR42u3BAQEAAADCoPdPbQ43oAAAAAAAAAAAAAAAAAAAAAAA4DcB7QABqF2FVQAAAABJRU5ErkJggg=='
export async function run(t) {
  mkdirSync(out, { recursive: true })
  const { win, record, close } = await openChat('look-chat-attachments')
  try {
    const pane = '[data-testid="chat-view"]'
    const fire = (name, detail) =>
      win.evaluate(
        ({ selector, name, detail }) =>
          document.querySelector(selector).dispatchEvent(new CustomEvent(name, { detail })),
        { selector: pane, name, detail }
      )
    const drag = (type) =>
      win.evaluate(
        ({ selector, type, base64 }) => {
          const dt = new DataTransfer()
          const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
          dt.items.add(new File([bytes], 'screenshot.png', { type: 'image/png' }))
          document
            .querySelector(selector)
            .dispatchEvent(
              new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt })
            )
        },
        { selector: pane, type, base64: PNG }
      )
    // The skin writes its tokens inline on the root (lib/skin.ts), over the
    // theme's CSS: a look at another bundled theme clears them first.
    const theme = (name) =>
      win.evaluate((name) => {
        const root = document.documentElement
        for (const key of Array.from(root.style))
          if (key.startsWith('--')) root.style.removeProperty(key)
        root.dataset.theme = name
      }, name)
    const shot = (name) => win.screenshot({ path: path.join(out, `${name}.png`) })
    const root = fixturePath('look-chat-attachments-root')
    mkdirSync(root, { recursive: true })
    const notes = path.join(root, 'notes.md')
    writeFileSync(notes, '# notes\n')
    // Nine records plus the session: the cap is ten.
    const kinds = ['clip.mp4', 'voice.m4a', 'brief.pdf', 'sheet.xlsx', 'main.ts', 'bundle.zip']
    for (const name of kinds) writeFileSync(path.join(root, name), 'x')
    const folder = path.join(root, 'assets')
    mkdirSync(folder, { recursive: true })
    writeFileSync(path.join(folder, 'one.txt'), '1')
    for (const t of ['dark', 'light']) {
      await theme(t)
      await win.waitForTimeout(300)
      await drag('dragenter')
      await win.locator('.chat-drop-overlay').waitFor()
      await win.waitForTimeout(900)
      await shot(`${t}-overlay-files`)
      await drag('dragleave')
      await fire('clave:sessions-drag-enter')
      await win.waitForTimeout(900)
      await shot(`${t}-overlay-session`)
      await fire('clave:sessions-drag-leave')
    }
    await theme('dark')
    await drag('drop')
    await win
      .locator('.chat-composer .chat-attachment')
      .filter({ hasText: /Image #1/i })
      .waitFor()
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
    await win.locator('.chat-composer .chat-attachment').filter({ hasText: 'notes.md' }).waitFor()
    for (const name of [...kinds, 'assets']) {
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
        { selector: pane, url: `file://${path.join(root, name)}` }
      )
      await win.locator('.chat-composer .chat-attachment').filter({ hasText: name }).waitFor()
    }
    await fire('clave:sessions-drop', { sessionIds: [record.id] })
    await win
      .locator('.chat-composer .chat-attachment')
      .filter({ hasText: /Session #1/i })
      .waitFor()
    await until(async () =>
      (await win.locator('.chat-composer textarea').inputValue()).includes('Session')
    )
    await win.locator('.chat-composer textarea').press('End')
    await win
      .locator('.chat-composer textarea')
      .pressSequentially('when these are done, write the report')
    for (const t of ['dark', 'light']) {
      await theme(t)
      await win.waitForTimeout(400)
      await shot(`${t}-chips`)
    }
    // The preview dialog, for the folder (its listing) and the image (its picture).
    for (const [name, label] of [
      ['assets', 'folder'],
      ['screenshot.png', 'image']
    ]) {
      await win
        .locator('.chat-composer .chat-attachment')
        .filter({ hasText: name })
        .getByRole('button', { name: `Preview ${name}` })
        .click()
      await win.locator('.chat-attachment-dialog').waitFor()
      await win.waitForTimeout(500)
      for (const t of ['dark', 'light']) {
        await theme(t)
        await win.waitForTimeout(300)
        await shot(`${t}-dialog-${label}`)
      }
      await win.getByRole('button', { name: 'Close preview' }).click()
      await until(async () => (await win.locator('.chat-attachment-dialog').count()) === 0)
    }
    await theme('dark')
    await win.locator('.chat-composer textarea').press('Enter')
    await win.locator('.chat-turn-wrap[data-side="end"] .chat-attachment').first().waitFor()
    await win.waitForTimeout(600)
    await shot('dark-sent')
    console.log(`screenshots in ${out}`)
    t.check('the look ran', true)
  } finally {
    await close()
  }
}
