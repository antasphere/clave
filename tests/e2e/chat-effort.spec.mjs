// The reasoning-effort chip beside the model chip, in both composers: it lists
// the levels the model takes, switches through the write IPC, names the level
// the adapter reports, disappears for a model that takes none, and the pick is
// remembered for the next chat. The echo fixture's Echo 1 takes Low and High,
// Echo 2 none.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { openChat } from './chat-view.spec.mjs'
import { until } from './harness.mjs'

async function exercise(t, fixture, testId, label) {
  const { app, win } = fixture
  const view = win.locator(`[data-testid="${testId}"]`)
  const chip = view.getByRole('button', { name: 'Reasoning effort', exact: true })
  await app.evaluate(({ ipcMain }) => {
    globalThis.__effortWrites = []
    const original = ipcMain._invokeHandlers.get('sessions:write')
    ipcMain._invokeHandlers.set('sessions:write', (event, id, input) => {
      globalThis.__effortWrites.push(input)
      return original(event, id, input)
    })
  })
  const written = () => app.evaluate(() => globalThis.__effortWrites)

  await chip.filter({ hasText: 'Low' }).waitFor()
  t.check(`${label}: the chip names the level the adapter reported at ready`, true)

  await chip.click()
  const menu = win.locator('.chat-model-menu').filter({ hasText: 'Reasoning effort' })
  await menu.waitFor()
  const items = await menu.getByRole('menuitem').allInnerTexts()
  assert.deepEqual(
    items.map((text) => text.split('\n')[0]),
    ['Low', 'High'],
    'the menu lists exactly the levels the model takes'
  )
  await menu.getByRole('menuitem', { name: /High/ }).click()
  assert.ok(
    await until(async () =>
      (await written()).some((x) => x.type === 'set_effort' && x.effort === 'high')
    ),
    'the pick goes out as a set_effort write'
  )
  await chip.filter({ hasText: 'High' }).waitFor()
  t.check(`${label}: picking High writes set_effort and the chip follows the report`, true)

  const userData = await app.evaluate(({ app }) => app.getPath('userData'))
  const prefs = await until(() => {
    const read = JSON.parse(readFileSync(path.join(userData, 'preferences.json'), 'utf8'))
    return read.chatEfforts?.echo === 'high' ? read : null
  })
  assert.ok(prefs, 'the pick is remembered for the next chat on this adapter')
  t.check(`${label}: the pick is remembered per adapter`, true)

  await view.getByRole('button', { name: 'Model', exact: true }).click()
  await win.getByRole('menuitem', { name: /Echo 2/ }).click()
  await view.locator('.chat-model-trigger').filter({ hasText: 'Echo 2' }).waitFor()
  assert.ok(
    await until(async () => (await chip.count()) === 0),
    'a model that takes no effort shows no chip'
  )
  t.check(`${label}: the chip leaves for a model that takes no effort`, true)

  // The model menu that picked Echo 2 must be gone before it is opened again:
  // a menu opened while the last one is still closing closes with it.
  assert.ok(await until(async () => (await win.locator('[role="menu"]').count()) === 0))

  await view.getByRole('button', { name: 'Model', exact: true }).click()
  await win.getByRole('menuitem', { name: /Echo 1/ }).click()
  await chip.filter({ hasText: 'Low' }).waitFor()
  t.check(`${label}: it comes back with the model's own level`, true)
}

export async function run(t) {
  const chat = await openChat('chat-effort')
  try {
    await exercise(t, chat, 'chat-view', 'chat view')
  } finally {
    await chat.close()
  }
  const terminal = await openChat(
    'chat-effort-terminal',
    ['--dev-echo-view=clave.chat-view/terminal'],
    '[data-testid="terminal-view"] textarea:not(:disabled)'
  )
  try {
    await exercise(t, terminal, 'terminal-view', 'terminal view')
  } finally {
    await terminal.close()
  }
}
