/**
 * A long conversation restored into a chat tab opens on its end at once, and
 * reads further back only as the reader scrolls there, without moving them.
 *
 * The bug: a resumed Claude chat replayed its whole transcript down the
 * session stream, one IPC message per event, and the view reduced and
 * re-rendered on each — the transcript visibly rebuilt itself turn by turn and
 * every turn of it ended up in the renderer. Now main keeps the past and the
 * view asks for it a page at a time (`sessions:history`), newest first.
 *
 * The flow is chat-tab-restore's: a chat tab talks once so it has a record and
 * a transcript, the app quits, the transcript is replaced by a long one, and
 * the relaunch restores the tab on it. Nothing reaches Anthropic: `claude` is
 * a stub, and CLAVE_TRANSCRIPTS_ROOT points the lookup at a fixture dir.
 */
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

const DIR = userDataDir('chat-history-pages')
const ROOT = fixturePath('chat-history-pages-root')
const TRANSCRIPTS = `${ROOT}/transcripts`
const ARGV_LOG = `${ROOT}/argv.jsonl`
const TURNS = 600
/** A day before the run: a replayed turn must read as then, never "just now". */
const DAY_AGO = Date.now() - 86_400_000
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

function writeFixtures() {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(`${ROOT}/bin`, { recursive: true })
  mkdirSync(TRANSCRIPTS, { recursive: true })
  seedWorkspaces(DIR, {
    workspaces: [
      { id: 'history-ws', name: 'History', rootDir: ROOT, profileFile: null, createdAt: 1 }
    ],
    activeWorkspaceId: 'history-ws',
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

/** TURNS turns, each a question, a step with a tool call and its result, and
 *  an answer, dated a minute apart ending a day ago. */
function longTranscript() {
  const lines = []
  for (let n = 0; n < TURNS; n++) {
    const timestamp = new Date(DAY_AGO - (TURNS - n) * 60_000).toISOString()
    const id = `toolu_${n}`
    lines.push(
      { type: 'user', timestamp, message: { role: 'user', content: `question ${n}` } },
      {
        type: 'assistant',
        timestamp,
        message: {
          content: [
            { type: 'text', text: `Looking into ${n}.` },
            { type: 'tool_use', id, name: 'Read', input: { file_path: `/f${n}` } }
          ]
        }
      },
      {
        type: 'user',
        timestamp,
        message: { content: [{ type: 'tool_result', tool_use_id: id, content: `line ${n}` }] }
      },
      {
        type: 'assistant',
        timestamp,
        message: { content: [{ type: 'text', text: `answer ${n}` }] }
      }
    )
  }
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
    let launched = await launchApp(DIR, { env })
    app = launched.app
    let win = launched.win
    await win.evaluate(async (command) => {
      await window.electronAPI.launchProfileUpsert({
        id: 'history-profile',
        name: 'History profile',
        family: 'claude',
        command: [command],
        additionalArgs: []
      })
      await window.electronAPI.launchProfileSetGlobal('claude', 'chat:claude:history-profile')
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
    const transcript = path.join(
      TRANSCRIPTS,
      ROOT.replace(/[^a-zA-Z0-9]/g, '-'),
      `${record.claudeSessionId}.jsonl`
    )
    await until(() => existsSync(transcript))
    await app.close()
    app = null
    writeFileSync(transcript, longTranscript())

    // ── Launch 2: the tab comes back on a long conversation ──
    launched = await launchApp(DIR, { env, settleMs: 3000 })
    app = launched.app
    win = launched.win
    const restore = win.getByRole('button', { name: 'Restore', exact: true })
    if (!(await until(() => restore.isVisible().catch(() => false))))
      throw new Error('no restore prompt at launch 2')
    await restore.click()
    await until(async () => (await callMcp(app, 'list', {})).sessions.some((s) => s.id === chat.id))

    const view = win.locator('[data-testid="chat-view"]')
    const scroller = view.locator('.chat-scroll')
    const userTurns = view.locator('.chat-turn[data-role="user"]')
    const newest = await until(
      async () =>
        (await userTurns
          .last()
          .innerText()
          .catch(() => '')) === `question ${TURNS - 1}`
    )
    t.check('the restored tab shows the newest turn', !!newest)
    const geometry = () =>
      scroller.evaluate((el) => ({
        top: el.scrollTop,
        height: el.scrollHeight,
        client: el.clientHeight
      }))
    const atEnd = async () => {
      const g = await geometry()
      return g.height - g.top - g.client < 2
    }
    t.check('and opens scrolled to its end', await until(atEnd), await geometry())
    const shown = await userTurns.count()
    t.check(
      'only the end of the conversation is in the view, not all of it',
      shown > 0 && shown < TURNS / 3,
      { shown, of: TURNS }
    )
    t.check(
      'the first turn is not rendered yet',
      !(await view.getByText('question 0', { exact: true }).count())
    )
    const meta = await userTurns
      .last()
      .locator('xpath=..')
      .locator('.chat-turn-meta span')
      .innerText()
    t.check('a replayed turn is dated by its transcript, not "just now"', meta !== 'just now', meta)

    // ── Scrolling up reads further back without moving the reader ──
    const oldestText = await userTurns.first().innerText()
    // Scrolled and measured in one task, before the scroll event can ask for a page.
    const placed = await scroller.evaluate((el, text) => {
      el.scrollTop = 0
      const turn = [...el.querySelectorAll('.chat-turn[data-role="user"]')].find(
        (node) => node.textContent === text
      )
      return turn.getBoundingClientRect().top
    }, oldestText)
    const grew = await until(async () => ((await userTurns.count()) > shown ? true : null))
    t.check('scrolling to the top brings earlier turns in', !!grew, {
      before: shown,
      after: await userTurns.count()
    })
    const anchored = view.getByText(oldestText, { exact: true })
    const stayed = await anchored.evaluate((el) => el.getBoundingClientRect().top)
    t.check(
      'and the turn the reader was on stays where it was on screen',
      Math.abs(stayed - placed) < 2,
      { placed, stayed, geometry: await geometry() }
    )

    // ── All the way back: every turn, once, in order ──
    const complete = await until(
      async () => {
        await scroller.evaluate((el) => {
          el.scrollTop = 0
        })
        return (await userTurns.first().innerText()) === 'question 0'
      },
      { tries: 120 }
    )
    t.check('the reader reaches the first turn by scrolling', !!complete)
    const texts = await userTurns.allInnerTexts()
    t.check(
      'every turn is there once, in order',
      texts.length === TURNS && texts.every((text, n) => text === `question ${n}`),
      { count: texts.length, head: texts.slice(0, 3) }
    )
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
