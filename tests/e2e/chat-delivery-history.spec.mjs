// Pinned to the in-process server, for the reason chat-history-pages gives:
// this spec restores a CHAT tab, and a chat the separate server starts has no
// view until the plugin host serves the server's sessions (PRDCT-3433).
/**
 * A conversation restored from its transcript groups the way a live one does:
 * the messages other tabs sent stack in collapsed decks, and the agent's reply,
 * its tool run, its explanation with its numbered choices and its question to
 * the reader stay in the transcript, in both presentations.
 *
 * The live road is chat-delivery-stacks's; this is the history road, the one a
 * reader takes when Clave comes back with a past conversation: the view reads
 * the past as a page from the adapter, which replays the transcript on disk,
 * and the other presentation, picked from the pane's view picker, shows the
 * same past. On
 * 5 November 2026 a collapsed deck hid exactly this explanation and this
 * question, because the deck captured every reply after a message from
 * another tab until the reader wrote again.
 *
 * The flow is chat-history-pages's: a chat tab talks once so it has a record
 * and a transcript, the app quits, the transcript is replaced by the
 * conversation below, and the relaunch restores the tab on it. Nothing reaches
 * Anthropic: `claude` is a stub, and CLAVE_TRANSCRIPTS_ROOT points the lookup
 * at a fixture dir.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  callMcp,
  until,
  userDataDir,
  fixturePath
} from './harness.mjs'

const DIR = userDataDir('chat-delivery-history')
const ROOT = fixturePath('chat-delivery-history-root')
const TRANSCRIPTS = `${ROOT}/transcripts`
const ARGV_LOG = `${ROOT}/argv.jsonl`
const DAY_AGO = Date.now() - 86_400_000
const QUESTION = "So I'm waiting on one answer from you: option 1, 2 or 3."
const CHOICES = ['Merge the fix now.', 'Wait for the verifier.', 'Drop the change.']
const recordPath = (id) => path.join(DIR, 'session-records', `${id}.json`)
const readRecord = (id) => {
  try {
    return JSON.parse(readFileSync(recordPath(id), 'utf8'))
  } catch {
    return null
  }
}
const launches = () => {
  try {
    return readFileSync(ARGV_LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
  } catch {
    return []
  }
}
/** What clave_send_to_session writes into a Claude chat: the provenance header
 *  the view recognises, then the words. */
const delivered = (name, body) =>
  name
    ? `[Message from Clave tab "${name}" — reply with clave_send_to_session sessionId="${name}"]\n${body}`
    : `[Message from a Clave agent]\n${body}`

function writeFixtures() {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(`${ROOT}/bin`, { recursive: true })
  mkdirSync(TRANSCRIPTS, { recursive: true })
  seedWorkspaces(DIR, {
    workspaces: [
      { id: 'delivery-ws', name: 'Delivery', rootDir: ROOT, profileFile: null, createdAt: 1 }
    ],
    activeWorkspaceId: 'delivery-ws',
    fresh: true
  })
  seedTrustedRoots(DIR, [ROOT])
  writeFileSync(
    `${ROOT}/bin/bash`,
    '#!/bin/sh\nif [ "$1" = "-lic" ]; then env -0; else shift; exec /bin/bash --noprofile --norc "$@"; fi\n',
    { mode: 0o755 }
  )
  // The stub CLI writes one turn to the transcript per message and answers it.
  writeFileSync(
    `${ROOT}/bin/claude`,
    `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path'); const readline = require('node:readline');
const argv = process.argv.slice(2);
if (argv.includes('-p') && !argv.includes('--input-format')) process.exit(0);
fs.appendFileSync(${JSON.stringify(ARGV_LOG)}, JSON.stringify({ pid: process.pid, argv }) + '\\n');
const at = (flag) => argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null;
const sid = at('--resume') || at('--session-id');
const transcript = path.join(process.env.CLAVE_TRANSCRIPTS_ROOT, ${JSON.stringify(ROOT)}.replace(/[^a-zA-Z0-9]/g, '-'), sid + '.jsonl');
const emit = (f) => process.stdout.write(JSON.stringify(f) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const input = JSON.parse(line);
  if (input.type !== 'user') return;
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.appendFileSync(transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: input.message.content } }) + '\\n');
  emit({ type: 'system', subtype: 'init', session_id: sid, model: 'stub' });
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'CLAVE_OK' }] } });
  emit({ type: 'result', subtype: 'success', is_error: false, session_id: sid });
});
setInterval(() => {}, 1000);
`,
    { mode: 0o755 }
  )
}

/** The conversation of 5 November 2026, as a transcript: the reader's ask,
 *  a message from another tab, the agent's reply and its tool run, two more
 *  messages from other tabs back to back, then the agent's explanation with
 *  its three choices and its question to the reader. */
function transcript() {
  let n = 0
  const stamp = () => new Date(DAY_AGO + n++ * 60_000).toISOString()
  const user = (content) => ({
    type: 'user',
    timestamp: stamp(),
    message: { role: 'user', content }
  })
  const assistant = (content) => ({ type: 'assistant', timestamp: stamp(), message: { content } })
  const lines = [
    user('Keep my conversation readable.'),
    assistant([{ type: 'text', text: 'I will report progress here.' }]),
    user(delivered('Wave coordinator', 'First payload.\nRecovery details.')),
    assistant([
      { type: 'text', text: 'Reply to the coordinator.' },
      { type: 'tool_use', id: 'toolu_check', name: 'Bash', input: { command: 'echo checked' } }
    ]),
    user([{ type: 'tool_result', tool_use_id: 'toolu_check', content: 'checked' }]),
    user(delivered('Lane verifier', 'Second payload, no omitted words.')),
    user(delivered(null, 'Third anonymous payload.')),
    assistant([
      {
        type: 'text',
        text: `Here is where things stand.\n\n1. ${CHOICES[0]}\n2. ${CHOICES[1]}\n3. ${CHOICES[2]}\n\n${QUESTION}`
      }
    ])
  ]
  return lines.map((line) => JSON.stringify(line)).join('\n') + '\n'
}

export async function run(t) {
  writeFixtures()
  const env = {
    SHELL: `${ROOT}/bin/bash`,
    PATH: `${ROOT}/bin:${process.env.PATH}`,
    CLAVE_TRANSCRIPTS_ROOT: TRANSCRIPTS
  }
  let app = null
  try {
    // ── Launch 1: a chat tab talks once, so it has a record and a transcript ──
    let launched = await launchApp(DIR, { server: 'in-process', env })
    app = launched.app
    let win = launched.win
    await win.evaluate(async (command) => {
      await window.electronAPI.launchProfileUpsert({
        id: 'delivery-profile',
        name: 'Delivery profile',
        family: 'claude',
        command: [command],
        additionalArgs: []
      })
      await window.electronAPI.launchProfileSetGlobal('claude', 'chat:claude:delivery-profile')
    }, `${ROOT}/bin/claude`)
    await win.reload()
    await win.locator('.launcher-split .launcher-btn').waitFor()
    await win.click('.launcher-split .launcher-btn')
    const chat = await until(async () =>
      (await win.evaluate(() => window.electronAPI.sessionsList())).find(
        (s) => s.adapterId === 'claude-chat'
      )
    )
    if (!chat) throw new Error('the launcher never produced a claude-chat session')
    await win.evaluate(async (id) => {
      await window.electronAPI.sessionsSubscribe(id)
      await window.electronAPI.sessionsWrite(id, { type: 'user_message', text: 'hello' })
    }, chat.id)
    const record = await until(() => readRecord(chat.id)?.claudeSessionId && readRecord(chat.id))
    if (!record) throw new Error('no chat record after launch 1: nothing to restore')
    const file = path.join(
      TRANSCRIPTS,
      ROOT.replace(/[^a-zA-Z0-9]/g, '-'),
      `${record.claudeSessionId}.jsonl`
    )
    await until(() => existsSync(file))
    await app.close()
    app = null
    writeFileSync(file, transcript())

    // ── Launch 2: the tab comes back on the conversation; the reader then
    // switches it to the other presentation, which read the same past ──
    launched = await launchApp(DIR, { server: 'in-process', env, settleMs: 3000 })
    app = launched.app
    win = launched.win
    await until(async () => (await callMcp(app, 'list', {})).sessions.some((s) => s.id === chat.id))
    const host = win.locator(`section.chat-host[data-session-id="${chat.id}"]`)
    for (const mode of ['chat', 'terminal']) {
      if (mode === 'terminal') {
        // The pane's view picker is the reader's road to the other presentation.
        await host.getByRole('button', { name: 'Change view', exact: true }).click()
        await win.getByRole('menuitem', { name: /enclave/i }).click()
      }
      const view = host.locator(`[data-testid="${mode}-view"]`)
      const shown = await until(() => view.locator('textarea:not(:disabled)').isVisible(), {
        tries: 60
      })
      if (!shown) throw new Error(`${mode}: the restored tab does not show the ${mode} view`)
      const stacks = view.locator('.chat-delivery-stack')
      const toolRows = view.locator(mode === 'chat' ? '.chat-tool-run' : '.term-tools')
      const said = (text) => view.locator('.chat-turn[data-role="assistant"]', { hasText: text })
      const visible = (locator) => until(() => locator.isVisible())
      assert.ok(await visible(said(QUESTION)), `${mode}: the restored conversation shows its end`)
      const restored = {
        decks: await stacks.evaluateAll((els) => els.map((el) => el.dataset.messages)),
        closed: await view
          .locator('.exchange-card')
          .evaluateAll((els) => els.every((el) => !el.open)),
        explanation: await visible(said('Here is where things stand.')),
        choices: [],
        reply: await visible(said('Reply to the coordinator.')),
        toolRows: await toolRows.count(),
        bodies: await view.locator('.exchange-part').count()
      }
      for (const choice of CHOICES) restored.choices.push(await visible(said(choice)))
      t.check(
        `${mode}: restored from its transcript, the messages from other tabs sit in collapsed decks and the agent's reply, its tool run, its explanation, its three choices and its question are on screen`,
        restored.decks.join(',') === '1,2' &&
          restored.closed &&
          restored.explanation &&
          restored.choices.every(Boolean) &&
          restored.reply &&
          restored.toolRows === 1 &&
          restored.bodies === 0,
        restored
      )
      const deck = view.locator('.chat-delivery-stack[data-messages="2"]')
      const cards = deck.locator('.exchange-card')
      for (const index of [0, 1]) {
        await cards.nth(index).locator('> summary').click()
        await cards.nth(index).locator('.exchange-part').first().waitFor()
      }
      const opened = {
        bodies: await deck
          .locator('.exchange-part[data-theirs] .exchange-part-text')
          .allTextContents(),
        names: await deck
          .locator('.exchange-part[data-theirs] .exchange-part-who')
          .allTextContents(),
        agentWords: await deck.locator('.chat-turn[data-role="assistant"]').count()
      }
      t.check(
        `${mode}: the opened cards hold the two messages whole, with their senders and none of the agent's words`,
        opened.bodies.length === 2 &&
          /Second payload, no omitted words/.test(opened.bodies[0]) &&
          /Third anonymous payload/.test(opened.bodies[1]) &&
          opened.bodies.every((s) => !s.includes('[Message from')) &&
          opened.names.some((s) => s.includes('Lane verifier')) &&
          opened.agentWords === 0,
        opened
      )
      for (const index of [0, 1]) await cards.nth(index).locator('> summary').click()
    }
  } finally {
    if (app) await app.close()
    for (const { pid } of launches()) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch (error) {
        if (error.code !== 'ESRCH') console.error('Stub cleanup failed', error)
      }
    }
    rmSync(DIR, { recursive: true, force: true })
    rmSync(ROOT, { recursive: true, force: true })
  }
}
