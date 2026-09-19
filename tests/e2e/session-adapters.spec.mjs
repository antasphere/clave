import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { _electron as electron } from 'playwright-core'
import { REPO, seedWorkspaces, seedTrustedRoots, callMcp, until, userDataDir } from './harness.mjs'

const DIR = userDataDir('session-adapters')
const ROOT = '/tmp/clave-e2e-session-adapters-root'

export async function run(t) {
  mkdirSync(ROOT, { recursive: true })
  const workspace = {
    id: 'adapter-workspace',
    name: 'Adapters',
    rootDir: ROOT,
    profileFile: null,
    createdAt: 1
  }
  seedWorkspaces(DIR, { workspaces: [workspace], activeWorkspaceId: workspace.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])
  let app = await electron.launch({
    executablePath: path.join(
      REPO,
      'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
    ),
    args: ['.', `--user-data-dir=${DIR}`, '--test-no-activate', '--dev-echo-adapter'],
    cwd: REPO,
    env: { ...process.env }
  })
  const win = await app.firstWindow()
  try {
    await win.waitForLoadState('domcontentloaded')
    await win.evaluate(() =>
      window.electronAPI.launchProfileSetGlobal('claude', 'dev-echo-adapter')
    )
    await win.reload()
    await win.waitForLoadState('domcontentloaded')
    await win.locator('.launcher-split .launcher-btn').waitFor()
    await win.click('.launcher-split .launcher-btn')
    const record = await until(async () =>
      (await win.evaluate(() => window.electronAPI.sessionsList())).find(
        (s) => s.adapterId === 'echo'
      )
    )
    assert.ok(record, 'Normal launcher must create the development echo session')
    t.equal('normal launcher creates events transport', record.transport, 'events')
    t.equal('normal launcher retains workspace root', record.cwd, ROOT)
    t.equal('session provider is echo', record.provider, 'echo')

    const subscribed = await win.evaluate(async (id) => {
      window.__adapterMessages = []
      window.__adapterMirror = []
      window.__stopAdapterStream = window.electronAPI.onSessionStream(id, (value) => {
        window.__adapterMessages.push({ value })
      })
      window.electronAPI.onSessionStream(id, (value) => window.__adapterMirror.push({ value }))
      window.electronAPI.onSessionStreamExit(id, (code) => {
        window.__adapterExit = code
      })
      const session = await window.electronAPI.sessionsSubscribe(id)
      await window.electronAPI.sessionsSubscribe(id)
      return session
    }, record.id)
    t.equal('subscription returns the same session', subscribed.id, record.id)
    await win.evaluate(
      (id) =>
        window.electronAPI.sessionsWrite(id, {
          type: 'user_message',
          text: 'echo round trip'
        }),
      record.id
    )
    const messages = await until(async () => {
      const received = await win.evaluate(() => window.__adapterMessages)
      return received.length >= 6 ? received : null
    })
    assert.ok(messages, 'Renderer must receive typed events through the preload bridge')
    const events = messages.map((m) => m.value.event)
    assert.deepEqual(
      events.map((event) => event.type),
      [
        'user_message',
        'state_change',
        'assistant_text',
        'tool_call',
        'tool_result',
        'state_change'
      ],
      'Typed events must arrive in provider order'
    )
    t.check('typed events arrive in order', true)
    assert.deepEqual(events[2], { type: 'assistant_text', delta: 'echo round trip', final: true })
    assert.equal(events[3].id, events[4].id)
    assert.equal(events[4].output, 'echo round trip')
    assert.equal(events[1].state, 'working')
    assert.equal(events[5].state, 'done')
    t.check('assistant text, tool correlation and state are preserved', true)

    const mirrored = await win.evaluate(() => window.__adapterMirror)
    assert.deepEqual(mirrored, messages, 'Both renderer consumers receive the same event stream')
    await win.evaluate(async (id) => {
      window.__stopAdapterStream()
      await window.electronAPI.sessionsUnsubscribe(id)
      await window.electronAPI.sessionsWrite(id, { type: 'user_message', text: 'second consumer' })
    }, record.id)
    assert.ok(
      await until(async () => (await win.evaluate(() => window.__adapterMirror.length)) >= 12)
    )
    assert.equal(await win.evaluate(() => window.__adapterMessages.length), 6)
    t.check('unsubscribing one renderer consumer leaves the second streaming', true)

    await callMcp(app, 'closeSession', { sessionId: record.id })
    assert.ok(
      await until(async () => (await win.evaluate(() => window.__adapterExit)) === 0),
      'Closing the real tab must deliver exit through the preload bridge'
    )
    t.equal(
      'closing the tab emits successful exit',
      await win.evaluate(() => window.__adapterExit),
      0
    )
    await win.evaluate((id) => window.electronAPI.sessionsUnsubscribe(id), record.id)
    const remaining = await win.evaluate(() => window.electronAPI.sessionsList())
    t.check('closed session leaves the live registry', !remaining.some((s) => s.id === record.id))

    await app.close()
    app = null
    app = await electron.launch({
      executablePath: path.join(
        REPO,
        'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
      ),
      args: ['.', `--user-data-dir=${DIR}`, '--test-no-activate'],
      cwd: REPO,
      env: { ...process.env }
    })
    const normalWindow = await app.firstWindow()
    await normalWindow.waitForLoadState('domcontentloaded')
    const normalProfiles = await normalWindow.evaluate(() =>
      window.electronAPI.launchProfilesList()
    )
    assert.ok(
      !normalProfiles.customProfiles.some((profile) => profile.id === 'dev-echo-adapter'),
      'Ordinary launches must hide echo even with a persisted development default'
    )
    t.check('echo profile stays hidden without its development flag', true)
    await assert.rejects(
      () =>
        normalWindow.evaluate(
          (cwd) =>
            window.electronAPI.spawnSession(cwd, {
              launchProfileId: 'dev-echo-adapter'
            }),
          ROOT
        ),
      /Echo adapter is disabled/,
      'Explicit echo launches must reject without the development flag'
    )
    t.check('explicit echo spawn rejects without its development flag', true)
    const ordinarySessions = await normalWindow.evaluate(() => window.electronAPI.sessionsList())
    t.check('rejected echo spawn creates no live process record', ordinarySessions.length === 0)
  } finally {
    if (app) await app.close()
    rmSync(DIR, { recursive: true, force: true })
    rmSync(ROOT, { recursive: true, force: true })
  }
}
