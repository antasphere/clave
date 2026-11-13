import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { serverMode, sidebarRows, until, fixturePath } from './harness.mjs'
import { openChat } from './chat-view.spec.mjs'

// Where this Mac's helpers run, and on what (PRDCT-4330, fix round 2). With a
// server behind the window (the separate child, the packaged default) every
// helper of this Mac runs on that server, with its preference and its
// accounts, and main runs none; in-process main is the server and runs them.
// For the five helpers (a tab title, an exchange digest, a work-card title, a
// commit message, a push summary): a picked model reaches the arguments, an
// account added through Settings after boot and picked for them reaches the
// CLI as its token, and "off" asks nothing of the CLI. A stub `claude` on the
// PATH records each call, its token and the chain of processes above it;
// nothing reaches a model. CLAVE_E2E_DIGEST_RUNNER=1 sends the digests through
// the runner rather than the harness's canned reply.

const BIN = fixturePath('helpers-places-bin')
const REPO = fixturePath('helpers-places-repo')
const LOG = `${BIN}/claude-calls.ndjson`
const TITLE = 'named by the stub'
const TOKEN = `sk-ant-oat01-${'h'.repeat(80)}`
const calls = () =>
  existsSync(LOG)
    ? readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : []
const kindOf = (call) => {
  if (call.prompt.includes('Clave exchange digest')) return 'exchange-digest'
  if (call.prompt.includes('Clave work digest')) return 'work-digest'
  if (call.argv.join(' ').includes('pushed together')) return 'push-summary'
  if (call.prompt.includes('Clave git helper')) return 'commit-message'
  return 'tab-title'
}
const callsOf = (kind) => calls().filter((call) => kindOf(call) === kind)

const MODELS = {
  'tab-title': 'sonnet',
  'exchange-digest': 'opus',
  'work-digest': 'sonnet',
  'commit-message': 'opus',
  'push-summary': 'sonnet'
}

export async function run(t) {
  const mode = serverMode()
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
const { execFileSync } = require('node:child_process');
const chain = [];
let pid = process.ppid;
for (let i = 0; i < 8 && pid > 1; i++) {
  chain.push(pid);
  try { pid = Number(execFileSync('/bin/ps', ['-o', 'ppid=', '-p', String(pid)]).toString().trim()); } catch { break; }
}
let prompt = '';
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({
    argv: process.argv.slice(2), prompt, token: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null, chain
  }) + '\\n');
  const argv = process.argv.slice(2).join(' ');
  const reply = prompt.includes('Clave exchange digest') ? '{"needs_you": false, "message": null, "summary": "All quiet."}'
    : prompt.includes('Clave work digest') ? '{"title": "Read the files", "needs_you": false, "note": null}'
    : argv.includes('pushed together') ? 'Push title\\nPush description'
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
  const { app, win, record } = fixture
  const set = (id, patch) =>
    win.evaluate(
      ([helperId, change]) => window.electronAPI.helperSet(helperId, change),
      [id, patch]
    )
  // The keys the window computes (`digestKey`, `workDigestKey`), which the
  // server checks against what is sent. Each call reads new words, so none
  // is answered from a digest filed earlier.
  const hashOf = (value) => {
    const text = JSON.stringify(value)
    let hash = 0x811c9dc5
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i)
      hash = Math.imul(hash, 0x01000193)
    }
    return (hash >>> 0).toString(36)
  }
  let round = 0
  const exchange = () => {
    const messages = [{ from: 'Verifier', text: `VERIFY-ACK: review round ${++round}.` }]
    return win.evaluate((request) => window.electronAPI.exchangeDigest(request), {
      sessionId: record.id,
      key: `${messages.length}-${hashOf(messages)}`,
      launch: {},
      messages
    })
  }
  const work = () => {
    const notes = ['Reading the files', `Running the tests, round ${++round}`]
    return win.evaluate((request) => window.electronAPI.workDigest(request), {
      sessionId: record.id,
      key: `work-${notes.length}-${hashOf(notes)}`,
      launch: {},
      notes,
      tools: 2
    })
  }
  const attempt = (run) =>
    win.evaluate(async (which) => {
      try {
        return which.kind === 'commit'
          ? { ok: await window.electronAPI.gitGenerateCommitMessage(which.cwd) }
          : { ok: await window.electronAPI.gitSummarizePush(which.cwd, ['feat: a'], '1 file') }
      } catch (error) {
        return { error: String(error?.message ?? error) }
      }
    }, run)
  const commit = () => attempt({ kind: 'commit', cwd: REPO })
  const push = () => attempt({ kind: 'push', cwd: REPO })

  // Who may spawn a helper: main's pid, and the server child's in separate mode.
  const mainPid = await app.evaluate(() => process.pid)
  const serverPid = await app.evaluate(({ app: electronApp }) => {
    const fs = process.getBuiltinModule('fs')
    const path = process.getBuiltinModule('path')
    const file = path.join(electronApp.getPath('userData'), 'clave-server.json')
    return fs.existsSync(file)
      ? (JSON.parse(fs.readFileSync(file, 'utf-8')).serverPid ?? null)
      : null
  })
  const ranIn = (call) => call.chain.find((pid) => pid === mainPid || pid === serverPid)

  try {
    t.check(
      `${mode}: the server child is known when separate`,
      mode !== 'separate' || typeof serverPid === 'number',
      { serverPid }
    )
    // ── An account added through Settings after boot, picked for every helper ──
    const account = await win.evaluate(async (token) => {
      const added = await window.electronAPI.claudeAccountAdd({ label: 'Helpers after boot' })
      await window.electronAPI.claudeAccountSetToken(added.id, token)
      return added.id
    }, TOKEN)
    for (const [id, model] of Object.entries(MODELS))
      await set(id, { model, account: { kind: 'account', accountId: account } })
    const listed = await win.evaluate(() => window.electronAPI.helpersList())
    t.check(
      'the page lists the five on their picked model and account',
      Object.entries(MODELS).every(([id, model]) => {
        const row = listed.find((h) => h.id === id)
        return row?.model === model && row?.account?.accountId === account && !row.accountRemoved
      }),
      listed
    )

    const input = win.getByRole('textbox', { name: 'Message', exact: true })
    await input.fill('please name this tab from the model picked for titles')
    await input.press('Enter')
    t.check(
      'the tab is named from the CLI',
      await until(async () => (await sidebarRows(win)).some((row) => row.includes(TITLE))),
      await sidebarRows(win)
    )
    const read = await exchange()
    t.check('the exchange digest answered', read?.ok === true, {
      read,
      calls: callsOf('exchange-digest').length
    })
    const titled = await work()
    t.check('the work-card title answered', titled?.ok === true, titled)
    const message = await commit()
    t.check('the commit message answered', message.ok === 'feat: stub message', message)
    const summary = await push()
    t.check('the push summary answered', summary.ok?.title === 'Push title', summary)

    for (const [id, model] of Object.entries(MODELS)) {
      const [call] = callsOf(id)
      t.equal(`${id}: on the picked model`, call?.argv.slice(0, 3).join(' '), `-p --model ${model}`)
      t.check(`${id}: on the account added after boot`, call?.token === TOKEN, {
        token: call?.token ? `${call.token.slice(0, 16)}…` : call?.token
      })
      t.equal(
        `${id}: run by ${mode === 'separate' ? 'the server child, never main' : 'main'}`,
        call && ranIn(call),
        mode === 'separate' ? serverPid : mainPid
      )
    }
    t.check(
      `${mode}: no helper call at all was spawned by ${mode === 'separate' ? 'main' : 'another process'}`,
      calls().every((call) => ranIn(call) === (mode === 'separate' ? serverPid : mainPid)),
      calls().map((call) => [kindOf(call), ranIn(call)])
    )

    // ── Sync all writes its commit message where the helpers run ──
    const syncAll = async (file) => {
      writeFileSync(`${REPO}/${file}`, `${file}\n`)
      const [result] = await win.evaluate((repo) => window.electronAPI.gitMagicSync([repo]), REPO)
      return result
    }
    const commitsIn = () =>
      Number(
        execFileSync('git', ['-C', REPO, 'rev-list', '--count', '--all']).toString().trim() || 0
      )
    const beforeSync = calls().length
    const synced = await syncAll('b.txt')
    const syncCall = calls()
      .slice(beforeSync)
      .find((call) => kindOf(call) === 'commit-message')
    t.check(
      'Sync all generated and committed (the push has no remote to go to)',
      synced?.actions?.includes('generated') && synced.actions.includes('committed'),
      synced
    )
    t.equal(
      'Sync all wrote its message on the picked model',
      syncCall?.argv.slice(0, 3).join(' '),
      '-p --model opus'
    )
    t.equal(
      `Sync all's message was written by ${mode === 'separate' ? 'the server child, never main' : 'main'}`,
      syncCall && ranIn(syncCall),
      mode === 'separate' ? serverPid : mainPid
    )

    // ── Off: nothing is asked of the CLI ──
    for (const id of Object.keys(MODELS)) await set(id, { enabled: false })
    const before = calls().length
    const commitsBefore = commitsIn()
    const offSync = await syncAll('c.txt')
    t.check(
      'Sync all with commit messages off stops with words: staged, nothing committed',
      JSON.stringify(offSync?.actions) === '["staged"]' &&
        /Switched off in Settings › Helpers \(Commit messages\)/.test(offSync?.error ?? '') &&
        commitsIn() === commitsBefore,
      offSync
    )
    const offRead = await exchange()
    t.check('an exchange digest switched off says so', offRead?.reason === 'disabled', offRead)
    const offWork = await work()
    t.check('a work-card title switched off says so', offWork?.reason === 'disabled', offWork)
    const offCommit = await commit()
    t.check(
      'a commit message switched off says so',
      /Switched off in Settings › Helpers \(Commit messages\)/.test(offCommit.error ?? ''),
      offCommit
    )
    const offPush = await push()
    t.check(
      'a push summary switched off says so',
      /Switched off in Settings › Helpers \(Push summaries\)/.test(offPush.error ?? ''),
      offPush
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

    // ── The server child gone: main still runs nothing ──
    if (mode === 'separate') {
      for (const id of Object.keys(MODELS)) await set(id, { enabled: true })
      const beforeKill = calls().length
      process.kill(serverPid, 'SIGKILL')
      await until(() => {
        try {
          process.kill(serverPid, 0)
          return false
        } catch {
          return true
        }
      })
      const afterKill = {
        exchange: await exchange().catch((error) => ({ error: String(error?.message ?? error) })),
        work: await work().catch((error) => ({ error: String(error?.message ?? error) })),
        commit: await commit(),
        push: await push(),
        sync: await syncAll('d.txt')
      }
      t.check(
        'the git panel says the silent server in plain words, no address',
        afterKill.commit.error === "Clave's server did not answer. Try again in a moment." &&
          !JSON.stringify([afterKill.commit, afterKill.push, afterKill.sync]).includes('127.0.0.1'),
        afterKill
      )
      t.check(
        'Sync all stops with the same words, nothing committed',
        afterKill.sync?.error === "Clave's server did not answer. Try again in a moment.",
        afterKill.sync
      )
      await new Promise((resolve) => setTimeout(resolve, 1000))
      const spawned = calls()
        .slice(beforeKill)
        .map((call) => ({ kind: kindOf(call), ranIn: ranIn(call), chain: call.chain, mainPid }))
      t.check(
        'with the server child gone, no helper was spawned at all, main included',
        spawned.length === 0,
        spawned
      )
    }
  } finally {
    await fixture.close()
    rmSync(BIN, { recursive: true, force: true })
    rmSync(REPO, { recursive: true, force: true })
  }
}
