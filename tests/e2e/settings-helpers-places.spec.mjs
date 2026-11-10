import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { sidebarRows, until, fixturePath } from './harness.mjs'
import { openChat } from './chat-view.spec.mjs'

// One preference governs every helper, whichever process runs it (PRDCT-4330,
// fix round 1). With the server separate (the packaged default), tab titles
// run in the server child while exchange digests and commit messages run in
// main; in-process all three run in main. This Mac's preference is written
// the way the page writes it (`helperSet`), and for each of the three helpers
// a picked model reaches the spawned arguments and "off" asks nothing of the
// CLI. A stub `claude` on the PATH records each call; nothing reaches a model.
// CLAVE_E2E_DIGEST_RUNNER=1 sends the digests through the runner rather than
// the harness's canned reply.

const BIN = fixturePath('helpers-places-bin')
const REPO = fixturePath('helpers-places-repo')
const LOG = `${BIN}/claude-calls.ndjson`
const TITLE = 'named by the stub'
const DIGEST = JSON.stringify({ needs_you: false, message: null, summary: 'All quiet.' })
const calls = () =>
  existsSync(LOG)
    ? readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : []
const kindOf = (call) =>
  call.prompt.includes('Clave exchange digest')
    ? 'digest'
    : call.prompt.includes('Clave git helper')
      ? 'git'
      : 'title'
const callsOf = (kind) => calls().filter((call) => kindOf(call) === kind)

export async function run(t) {
  rmSync(BIN, { recursive: true, force: true })
  rmSync(REPO, { recursive: true, force: true })
  mkdirSync(BIN, { recursive: true })
  mkdirSync(REPO, { recursive: true })
  writeFileSync(
    `${BIN}/bash`,
    '#!/bin/sh\nif [ "$1" = "-lic" ]; then env -0; else shift; exec /bin/bash --noprofile --norc "$@"; fi\n',
    { mode: 0o755 }
  )
  writeFileSync(
    `${BIN}/claude`,
    `#!${process.execPath}
const fs = require('node:fs');
let prompt = '';
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({ argv: process.argv.slice(2), prompt }) + '\\n');
  const reply = prompt.includes('Clave exchange digest') ? ${JSON.stringify(DIGEST)}
    : prompt.includes('Clave git helper') ? 'feat: stub message'
    : ${JSON.stringify(TITLE)};
  process.stdout.write(reply + '\\n');
});
`,
    { mode: 0o755 }
  )
  execFileSync('git', ['init', '-q', REPO])
  writeFileSync(`${REPO}/a.txt`, 'x\n')
  execFileSync('git', ['-C', REPO, 'add', '.'])

  const fixture = await openChat('helpers-places', [], undefined, {
    SHELL: `${BIN}/bash`,
    PATH: `${BIN}:${process.env.PATH}`,
    CLAVE_E2E_DIGEST_RUNNER: '1'
  })
  const { win, record } = fixture
  const set = (id, patch) =>
    win.evaluate(
      ([helperId, change]) => window.electronAPI.helperSet(helperId, change),
      [id, patch]
    )
  let key = 0
  const digest = () =>
    win.evaluate(
      ([sessionId, k]) =>
        window.electronAPI.exchangeDigest({
          sessionId,
          key: k,
          launch: {},
          messages: [{ from: 'Verifier', text: 'VERIFY-ACK: starting the review now.' }]
        }),
      [record.id, `helpers-places-${++key}`]
    )
  const commitMessage = () =>
    win.evaluate(async (cwd) => {
      try {
        return { ok: await window.electronAPI.gitGenerateCommitMessage(cwd) }
      } catch (error) {
        return { error: String(error?.message ?? error) }
      }
    }, REPO)
  const modelOf = (call) => call?.argv.slice(0, 3).join(' ')

  try {
    // ── A model picked for each reaches the spawned call ──
    await set('tab-title', { model: 'sonnet' })
    await set('exchange-digest', { model: 'opus' })
    await set('commit-message', { model: 'sonnet' })

    const input = win.getByRole('textbox', { name: 'Message', exact: true })
    await input.fill('please name this tab from the model picked for titles')
    await input.press('Enter')
    t.check(
      'the tab is named from the CLI',
      await until(async () => (await sidebarRows(win)).some((row) => row.includes(TITLE))),
      await sidebarRows(win)
    )
    t.equal('the title ran on the picked model', modelOf(callsOf('title')[0]), '-p --model sonnet')

    const read = await digest()
    t.check('the exchange digest answered', read?.ok === true, read)
    t.equal(
      'the exchange digest ran on the picked model',
      modelOf(callsOf('digest')[0]),
      '-p --model opus'
    )

    const written = await commitMessage()
    t.check('the commit message answered', written.ok === 'feat: stub message', written)
    t.equal(
      'the commit message ran on the picked model',
      modelOf(callsOf('git')[0]),
      '-p --model sonnet'
    )

    // ── Off: nothing is asked of the CLI, and each says so ──
    for (const id of ['tab-title', 'exchange-digest', 'commit-message'])
      await set(id, { enabled: false })
    const before = calls().length

    const off = await digest()
    t.check(
      'an exchange digest switched off says so',
      off?.ok === false && off.reason === 'disabled',
      off
    )
    const noMessage = await commitMessage()
    t.check(
      'a commit message switched off says so',
      /Switched off in Settings › Helpers \(Commit messages\)/.test(noMessage.error ?? ''),
      noMessage
    )

    const ids = (await win.evaluate(() => window.electronAPI.sessionsList())).map((s) => s.id)
    await win.locator('.launcher-split .launcher-btn').click()
    await until(async () =>
      (await win.evaluate(() => window.electronAPI.sessionsList())).some(
        (s) => s.adapterId === 'echo' && !ids.includes(s.id)
      )
    )
    const second = win.locator('[data-testid="chat-view"] textarea:not(:disabled):visible')
    await until(async () => (await second.count()) === 1)
    await second.fill('rename the second tab from its own words')
    await second.press('Enter')
    t.check(
      'a title switched off takes the first words',
      await until(async () =>
        (await sidebarRows(win)).some((row) => row.includes('rename the second tab'))
      ),
      await sidebarRows(win)
    )
    await new Promise((resolve) => setTimeout(resolve, 1000))
    t.equal('nothing was asked of the CLI while they were off', calls().length - before, 0)
  } finally {
    await fixture.close()
    rmSync(BIN, { recursive: true, force: true })
    rmSync(REPO, { recursive: true, force: true })
  }
}
