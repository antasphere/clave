/**
 * A Claude chat on a Clave server comes back live after its daemon restarts
 * (PRDCT-4191). One daemon, one Mac; the chat runs the real Claude chat
 * adapter on the daemon over a local stream-json stand-in
 * (`fixtures/claude-stream-stub.mjs`, a claude-family launch profile posted
 * to `/launch-profiles`) whose init frame reports `acceptEdits`. The Mac
 * shows the tab, a first message is typed in its composer, the daemon
 * restarts: the pane reads "Session ended" with a Resume button; Resume
 * relaunches the CLI on the same conversation in the mode it last reported,
 * the pane goes live again and a message typed in the composer reaches the
 * new process.
 *
 * Fails if: the pane stays on "Session ended" or keeps its composer disabled
 * after Resume (the subscribe answer's state not applied, what PRDCT-4191
 * reported), the resumed CLI is launched without `--resume <id>` or without
 * `--permission-mode acceptEdits` (the record not keeping the reported mode),
 * or the message typed after Resume never reaches the resumed process.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { REPO, fixturePath } from './harness.mjs'
import {
  fleetWorld,
  connectMac,
  eventually,
  owned,
  request,
  showServer
} from './fixtures/fleet-world.mjs'

const lines = (file) =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : []

export async function run(t) {
  // The daemon looks for a Claude conversation's transcript under this root
  // (`findTranscript`, CLAVE_TRANSCRIPTS_ROOT): the run's own, never ~/.claude.
  const transcripts = fixturePath(`chat-resume-transcripts-${process.pid}`)
  const world = await fleetWorld('chat-resume', {
    count: 1,
    env: { CLAVE_TRANSCRIPTS_ROOT: transcripts }
  })
  try {
    const [server] = world.servers
    const processes = () => lines(path.join(server.root, 'claude-stub-processes.jsonl'))
    const inputs = () => lines(path.join(server.root, 'claude-stub-input.jsonl'))
    const userTexts = (pid) =>
      inputs()
        .filter((i) => i.pid === pid && i.frame.type === 'user')
        .map((i) => JSON.stringify(i.frame.message?.content ?? ''))

    await request(server, '/launch-profiles', {
      profile: {
        id: 'chat-resume-stub',
        name: 'Chat resume stream stub',
        family: 'claude',
        command: [process.execPath, path.join(REPO, 'tests/e2e/fixtures/claude-stream-stub.mjs')],
        additionalArgs: []
      }
    })
    const started = await request(server, '/sessions/start', {
      cwd: server.root,
      options: { claudeMode: true, launchProfileId: 'chat:claude:chat-resume-stub' }
    })
    const rawId = started.id

    const mac = await world.mac('resume')
    await connectMac(mac, world.servers, { ui: false })
    const owner = mac.owners[0].id
    const key = owned('session', owner, rawId)
    const { win } = mac
    await showServer(mac, 0)
    await win.locator(`[data-sidebar-item-id="${key}"]`).click()
    const pane = win.locator(`[data-session-id="${key}"]`)
    const chat = pane.locator('[data-testid="chat-view"]')
    const composer = chat.getByRole('textbox', { name: 'Message', exact: true })
    await chat.waitFor()
    await eventually(() => composer.isEnabled(), 'the live chat’s composer is enabled')

    const first = `first message ${world.run.slice(-8)}`
    await composer.fill(first)
    await composer.press('Enter')
    await eventually(() => processes().length === 1, 'the stub CLI started once')
    const [launch] = processes()
    await eventually(
      () => userTexts(launch.pid).some((s) => s.includes(first)),
      'the first message reaches the CLI'
    )
    await chat
      .locator('.chat-turn[data-role="assistant"]')
      .filter({ hasText: `stub heard: ${first}` })
      .first()
      .waitFor()
    t.check('the first message reaches the stub CLI and its answer is drawn', true)
    const sessionArg = launch.argv[launch.argv.indexOf('--session-id') + 1]
    assert.ok(sessionArg, `the first launch names its conversation: ${launch.argv.join(' ')}`)
    // What the real CLI leaves behind after a turn, so the Resume has a
    // conversation to continue (a chat with no transcript relaunches fresh).
    const dashed = path.join(transcripts, server.root.replace(/[^a-zA-Z0-9]/g, '-'))
    mkdirSync(dashed, { recursive: true })
    writeFileSync(
      path.join(dashed, `${sessionArg}.jsonl`),
      JSON.stringify({
        type: 'user',
        sessionId: sessionArg,
        uuid: '00000000-0000-4000-8000-000000000001',
        cwd: server.root,
        message: { role: 'user', content: first }
      }) + '\n'
    )
    // The record keeps the mode the CLI reported (written back on `permission_mode`).
    const recordFile = path.join(server.dataDir, 'session-records', `${rawId}.json`)
    const recordMode = () => {
      try {
        return JSON.parse(readFileSync(recordFile, 'utf8')).permissionMode
      } catch {
        return undefined
      }
    }
    await eventually(
      () => recordMode() === 'acceptEdits',
      `the record keeps the reported mode (records: ${
        existsSync(path.dirname(recordFile)) ? readdirSync(path.dirname(recordFile)) : 'none'
      })`
    )
    t.check('the session record keeps the permission mode the CLI reported', true)

    await world.restart(0)
    assert.equal(
      (await request(server, '/sessions')).find((s) => s.id === rawId)?.state,
      'ended',
      'the restarted daemon holds the chat as a stopped record'
    )
    await eventually(async () => {
      try {
        const snapshot = await win.evaluate((id) => window.electronAPI.fleetSnapshot(id), owner)
        return snapshot.sessions.some((s) => s.id === key && s.state === 'ended')
      } catch {
        return false
      }
    }, 'the Mac reconnects and reads the chat as a stopped record')
    await eventually(
      async () => (await pane.locator('[data-chat-ended]').count()) > 0,
      'the pane reads the chat as ended after the restart'
    )
    const ended = await pane.locator('[data-chat-ended]').first().getAttribute('data-chat-ended')
    t.equal('after the restart the pane says the session ended', ended, 'exit')
    const resume = pane.getByRole('button', { name: 'Resume', exact: true })
    await resume.waitFor()
    t.check('and offers Resume', true)
    t.equal('the restart alone started no CLI', processes().length, 1)

    await resume.click()
    await eventually(() => processes().length === 2, 'Resume starts the CLI again')
    const relaunch = processes()[1]
    const argv = relaunch.argv
    t.check(
      'the resumed CLI continues the same conversation (--resume <id>)',
      argv.includes('--resume') && argv[argv.indexOf('--resume') + 1] === sessionArg,
      argv
    )
    t.check(
      'the resumed CLI runs in the mode it last reported (--permission-mode acceptEdits)',
      argv.includes('--permission-mode') &&
        argv[argv.indexOf('--permission-mode') + 1] === 'acceptEdits',
      argv
    )
    const live = await eventually(
      async () =>
        (await pane.locator('[data-chat-ended]').count()) === 0 && (await composer.isEnabled()),
      'the pane goes live after Resume'
    ).then(
      () => true,
      () => false
    )
    t.check('after Resume the ended notice is gone and the composer is enabled', live, {
      ended: await pane.locator('[data-chat-ended]').count(),
      enabled: await composer.isEnabled(),
      placeholder: await composer.getAttribute('placeholder')
    })
    t.check(
      'the Resume reported no failure',
      (await pane.locator('[data-fleet-resume-error]').count()) === 0
    )

    if (live) {
      const second = `after resume ${world.run.slice(-8)}`
      await composer.fill(second)
      await composer.press('Enter')
      const reached = await eventually(
        () => userTexts(relaunch.pid).some((s) => s.includes(second)),
        'the message typed after Resume reaches the resumed CLI'
      ).then(
        () => true,
        () => false
      )
      t.check('a message typed after Resume reaches the resumed CLI', reached, inputs())
      if (reached)
        await chat
          .locator('.chat-turn[data-role="assistant"]')
          .filter({ hasText: `stub heard: ${second}` })
          .first()
          .waitFor()
      t.check('and its answer is drawn in the pane', reached)
    }
    assert.deepEqual(mac.errors, [])
  } finally {
    await world.close()
  }
}
