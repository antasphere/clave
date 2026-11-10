/**
 * A window whose sessions run on a server of their own never reads a digest
 * in main, even before that server is up (PRDCT-4327). Pinned to `separate`:
 * the app starts its server as a child on `userData/server`, here 5 s late
 * (`CLAVE_E2E_SERVER_BOOT_DELAY_MS`). From the window's first paint a digest
 * is asked every 50 ms until the server has answered a few.
 *
 * Which process read a digest: under the harness each read is journaled in
 * the data folder of the process that made it (`e2e-digest-reads.jsonl`,
 * `src/main/exchange-digest.ts`, `journalRead`): main's is the app's user
 * data, the child's is `userData/server`.
 *
 * Fails if: a digest asked before the server is named goes to main over IPC
 * (main's journal has a line, and that answer is main's reading rather than
 * the server's "no record of that tab"); or the calls asked early are lost
 * rather than answered by the server once it is up.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  fixturePath,
  until
} from './harness.mjs'

const DIR = userDataDir('chat-digest-early')
const ROOT = fixturePath('chat-digest-early-root')
const BOOT_DELAY_MS = 5000
const REPLY = JSON.stringify({ needs_you: false, message: null, summary: 'Read.' })

/** `digestKey` of `src/shared/exchange-digest.ts`: the key the host checks. */
const digestKey = (messages) => {
  const text = JSON.stringify(messages)
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${messages.length}-${(hash >>> 0).toString(36)}`
}
const MESSAGES = [{ from: 'Verifier', text: 'asked from the first paint' }]

/** In the page, from its first paint: a digest every 50 ms, each answer kept. */
function startAsking({ key, messages }) {
  const answers = []
  window.__digestAnswers = answers
  let n = 0
  const tick = () => {
    if (n >= 200) return
    const index = n++
    const at = performance.now()
    window.electronAPI
      .exchangeDigest({ sessionId: 'not-a-tab-of-this-server', key, launch: {}, messages })
      .then(
        (answer) => answers.push({ index, at, answer }),
        (error) => answers.push({ index, at, error: String(error) })
      )
    setTimeout(tick, 50)
  }
  tick()
}

const journal = (file) =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : []

export async function run(t) {
  rmSync(DIR, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
  seedWorkspaces(DIR, {
    workspaces: [{ id: 'early', name: 'Early', rootDir: ROOT, profileFile: null, createdAt: 1 }],
    activeWorkspaceId: 'early',
    fresh: true
  })
  seedTrustedRoots(DIR, [ROOT])
  const { app } = await launchApp(DIR, {
    server: 'separate',
    env: { CLAVE_E2E_SERVER_BOOT_DELAY_MS: String(BOOT_DELAY_MS), CLAVE_E2E_DIGEST_REPLY: REPLY },
    beforeBoot: (win) => win.evaluate(startAsking, { key: digestKey(MESSAGES), messages: MESSAGES })
  })
  try {
    const win = await app.firstWindow()
    // Every call asked answered: 200 calls, 10 s of asking, the server up at 5 s.
    const all = await until(
      async () => {
        const answers = await win.evaluate(() => window.__digestAnswers ?? [])
        return answers.length >= 200 ? answers : null
      },
      { tries: 120, gapMs: 250 }
    )
    const answers = all ?? (await win.evaluate(() => window.__digestAnswers ?? []))
    const main = journal(path.join(DIR, 'e2e-digest-reads.jsonl'))
    const child = journal(path.join(DIR, 'server', 'e2e-digest-reads.jsonl'))
    const early = answers.filter((a) => a.at < BOOT_DELAY_MS)
    const fromServer = answers.filter(
      (a) => a.answer?.ok === false && a.answer.reason === 'unknown-session'
    )
    t.check('separate: no digest asked from the first paint is read in main', main.length === 0, {
      mainReads: main.length,
      childReads: child.length
    })
    t.check(
      'separate: every call, the ones asked before the server was up included, is answered by the server',
      answers.length === 200 && early.length > 0 && fromServer.length === answers.length,
      {
        answered: answers.length,
        early: early.length,
        fromServer: fromServer.length,
        other: answers.filter((a) => !fromServer.includes(a)).slice(0, 3)
      }
    )
  } finally {
    await app.close()
  }
}
