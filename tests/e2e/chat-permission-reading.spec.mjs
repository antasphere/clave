import assert from 'node:assert/strict'
import path from 'node:path'
import { openChat, inject } from './chat-view.spec.mjs'
import { until, REPO } from './harness.mjs'
import {
  fleetWorld,
  clickReady,
  connectMac,
  eventually,
  owned,
  ownerReady,
  request,
  showServer
} from './fixtures/fleet-world.mjs'

/* A permission request anyone can read (PRDCT-4331). What this spec holds in
   the real app: the card shows the level the rules give on its first frame,
   says it is reading while the session's host reads it, then shows the plain
   sentence the host sent as a session event; the transcript says each change
   of permission mode once, who asked when this view did; a tab that could
   skip permissions offers the way back, and the way back sends the switch.
   Then the same reading on a tab of another server: the sentence is read on
   the server and crosses the wire to the Mac. No model runs: the reply is
   handed in CLAVE_E2E_EXPLAINER_REPLY (src/main/sessions/explain-permission.ts). */

const SENTENCE = 'Deletes the build folder of the project for good.'
const REPLY = JSON.stringify({ sentence: SENTENCE, level: 'reads', asked: 'yes' })
const MODES = [
  { id: 'default', label: 'Manual' },
  { id: 'acceptEdits', label: 'Accept edits' },
  { id: 'bypassPermissions', label: 'Bypass permissions' }
]

export async function run(t) {
  await onThisMac(t)
  await onAServerTab(t)
}

async function onThisMac(t) {
  const chat = await openChat('chat-permission-reading', [], undefined, {
    CLAVE_E2E_EXPLAINER_REPLY: REPLY,
    CLAVE_E2E_EXPLAINER_DELAY_MS: '1500'
  })
  const { win, record, fixture } = chat
  const view = win.locator('[data-testid="chat-view"]')
  try {
    await fixture.evaluate(() => {
      const host = globalThis.__claveE2E.sessionHost
      const write = host.write
      globalThis.__readingWrites = []
      host.write = (id, input) => {
        if (input.type === 'permission_response' || input.type === 'set_permission_mode') {
          globalThis.__readingWrites.push(input)
          return Promise.resolve()
        }
        return write.call(host, id, input)
      }
    })
    const writes = () => fixture.evaluate(() => globalThis.__readingWrites)

    // The tab starts with permissions skipped; the first word on the mode says nothing.
    await inject(fixture, record.id, [
      { type: 'permission_mode', mode: 'bypassPermissions', modes: MODES },
      { type: 'user_message', text: 'clean the build output' }
    ])
    await view.getByText('clean the build output').waitFor()
    assert.equal(await view.locator('.chat-mode-line').count(), 0, 'no line for the first word')
    // Something moved it to Manual (one Shift+Tab, on 10 Nov 2026): one line says so.
    await inject(fixture, record.id, [
      { type: 'permission_mode', mode: 'default', modes: MODES },
      { type: 'permission_mode', mode: 'default', modes: MODES }
    ])
    const lines = view.locator('.chat-mode-line')
    await lines.first().waitFor()
    assert.equal(await lines.count(), 1, 'a repeat of the same mode adds no line')
    assert.match(
      await lines.first().innerText(),
      /Switched permissions from Bypass permissions to Manual/
    )
    t.check('a change of permission mode is one line of the transcript, a repeat none', true)

    // The request: the level from the rules is on the card at once, and it is answerable.
    await inject(fixture, record.id, [
      {
        type: 'permission_request',
        id: 'reading-1',
        description: 'Allow Bash: Remove the build folder',
        toolName: 'Bash',
        input: { command: 'rm -rf build', description: 'Remove the build folder' },
        detail: 'Remove the build folder',
        options: [
          { id: 'allow-once', label: 'Allow once' },
          { id: 'deny', label: 'Deny' }
        ]
      }
    ])
    const dock = view.locator('.chat-prompt[data-kind="permission"]')
    await dock.waitFor()
    const reading = dock.locator('.chat-permission-reading')
    assert.equal(await reading.getAttribute('data-level'), 'irreversible')
    assert.match(await reading.innerText(), /Hard to undo/)
    assert.match(await reading.innerText(), /Reading what this does…/)
    assert.equal(
      await dock.getByRole('button', { name: /Allow once/ }).isDisabled(),
      false,
      'the card answers from its first frame'
    )
    t.check(
      'the level from the rules shows at once, with the reading state, and the card answers',
      true
    )

    // The host's reading lands; the model said "reads", the level stays where the rules put it.
    await dock.getByText(SENTENCE).waitFor({ timeout: 15_000 })
    assert.equal(await reading.getAttribute('data-level'), 'irreversible')
    assert.equal(await dock.getByText('Reading what this does…').count(), 0)
    t.check('the sentence follows, and the reading never lowers the level', true)

    // The way back to skipping permissions, on the card: it sends the switch.
    await clickReady(dock.getByRole('button', { name: 'Back to skipping permissions' }))
    assert.ok(
      await until(async () =>
        (await writes()).some(
          (w) => w.type === 'set_permission_mode' && w.mode === 'bypassPermissions'
        )
      ),
      'the switch is written to the session'
    )
    // The provider answers the switch twice (its answer, then its own report): one line, ours.
    await inject(fixture, record.id, [
      { type: 'permission_mode', mode: 'bypassPermissions', modes: MODES },
      { type: 'permission_mode', mode: 'bypassPermissions', modes: MODES }
    ])
    assert.ok(
      await until(async () => {
        const texts = await lines.allInnerTexts()
        return texts.length === 2 && /You switched permissions from Manual to Bypass/.test(texts[1])
      }),
      'one more line, saying the reader switched'
    )
    t.check('a tab started skipping permissions offers the way back, and says who switched', true)

    // Answered, the record keeps the level.
    await clickReady(dock.getByRole('button', { name: /Deny/ }))
    await until(async () => (await view.locator('.chat-prompt').count()) === 0)
    const row = view.locator('.chat-permission-row[data-kind="permission"]')
    assert.match(await row.innerText(), /Hard to undo/)
    t.check('the transcript row keeps the level', true)
  } finally {
    await chat.close()
  }
}

async function onAServerTab(t) {
  const world = await fleetWorld('permission-reading', {
    count: 1,
    env: {
      CLAVE_E2E_EXPLAINER_REPLY: JSON.stringify({
        sentence: 'Prints a word on the screen. Changes nothing.',
        level: 'reads',
        asked: 'unclear'
      }),
      CLAVE_E2E_EXPLAINER_DELAY_MS: '300'
    }
  })
  try {
    const server = world.servers[0]
    await request(server, '/launch-profiles', {
      profile: {
        id: 'fleet-reading-provider',
        name: 'Fleet recording protocol fixture',
        family: 'codex',
        command: [process.execPath, path.join(REPO, 'tests/e2e/fixtures/fleet-provider.mjs')],
        additionalArgs: []
      }
    })
    const provider = await request(server, '/sessions/start', {
      cwd: server.root,
      options: {
        claudeMode: false,
        codexMode: true,
        launchProfileId: 'chat:codex:fleet-reading-provider'
      }
    })
    await eventually(
      async () =>
        (await request(server, '/requests/pending')).pending.some(
          (r) => r.providerRequestId === '"fleet-native-approval"'
        ),
      'the approval waits on the server'
    )
    const mac = await world.mac('reading')
    await connectMac(mac, [server], { ui: false })
    const key = owned('session', mac.owners[0].id, provider.id)
    await showServer(mac, 0)
    await ownerReady(mac, mac.owners[0].id, key)
    await clickReady(mac.win.locator(`[data-sidebar-item-id="${key}"]`))
    const pane = mac.win.locator(`.chat-host[data-session-id="${key}"]`)
    const dock = pane.locator('.chat-prompt[data-kind="permission"]:visible')
    await dock.waitFor()
    assert.equal(await dock.locator('.chat-permission-reading').getAttribute('data-level'), 'reads')
    // Read on the server before the Mac attached: the reading is handed to the late view.
    await dock
      .getByText('Prints a word on the screen. Changes nothing.')
      .waitFor({ timeout: 15_000 })
    t.check('on a server tab, the reading made on the server reaches the Mac card', true)
  } finally {
    await world.close()
  }
}
