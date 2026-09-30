// The GitHub pull request panel (plugins/github): a pull request link in a
// chat opens the pull request in the side panel, read and written through the
// user's own `gh`. Nothing here reaches GitHub — `gh` on the PATH is a stub
// that answers `pr view` and `pr diff` from fixtures and records every call it
// gets, so the assertions are on what the panel asked `gh` for and on what it
// drew from the answer, in the real Electron app.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { REPO, until, fixturePath } from './harness.mjs'
import { openChat, inject } from './chat-view.spec.mjs'

const BIN = fixturePath('github-pull-bin')
const CALLS = `${BIN}/gh-calls.jsonl`
const POSTED = `${BIN}/gh-posted.json`
const FAIL = `${BIN}/gh-fail`
const NEEDS_TOKEN = `${BIN}/gh-needs-token`
const SHELL_TOKEN = 'ghp_exported_by_the_login_shell'
const PULL_URL = 'https://github.com/acme/widgets/pull/42'
const ISSUE_URL = 'https://github.com/acme/widgets/issues/7'

function writeStubs() {
  rmSync(BIN, { recursive: true, force: true })
  mkdirSync(BIN, { recursive: true })
  // A login shell fixture preserves the stub-first PATH instead of the host's path_helper.
  writeFileSync(
    `${BIN}/bash`,
    '#!/bin/sh\nif [ "$1" = "-lic" ]; then env -0; else shift; exec /bin/bash --noprofile --norc "$@"; fi\n',
    { mode: 0o755 }
  )
  const fixture = (name) => JSON.stringify(path.join(REPO, 'tests/e2e/fixtures/github', name))
  writeFileSync(
    `${BIN}/gh`,
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const stdin = args.includes('--body-file') ? fs.readFileSync(0, 'utf8') : null;
// The token gh would read, if the environment still carried one.
const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? null;
fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify({ args, stdin, token }) + '\\n');
// A gh with no stored login: only the environment's token signs it in.
if (fs.existsSync(${JSON.stringify(FAIL)}) || (fs.existsSync(${JSON.stringify(NEEDS_TOKEN)}) && !token)) {
  process.stderr.write('To get started with GitHub CLI, please run:  gh auth login\\n');
  process.exit(4);
}
const posted = fs.existsSync(${JSON.stringify(POSTED)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(POSTED)}, 'utf8')) : [];
if (args[0] === 'pr' && args[1] === 'view') {
  const record = JSON.parse(fs.readFileSync(${fixture('pull-42.json')}, 'utf8'));
  // What was posted through this stub shows up on the next read, the way GitHub would.
  record.comments = record.comments.concat(posted);
  process.stdout.write(JSON.stringify(record));
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'diff') {
  process.stdout.write(fs.readFileSync(${fixture('pull-42.diff')}, 'utf8'));
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'comment') {
  posted.push({ id: 'IC_posted_' + posted.length, author: { login: 'me' }, body: stdin, createdAt: '2026-09-22T10:00:00Z' });
  fs.writeFileSync(${JSON.stringify(POSTED)}, JSON.stringify(posted));
}
process.exit(0);
`,
    { mode: 0o755 }
  )
}

const calls = () =>
  existsSync(CALLS)
    ? readFileSync(CALLS, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : []
const callWith = (prefix) =>
  calls().find((call) => prefix.every((arg, index) => call.args[index] === arg))

export async function run(t) {
  writeStubs()
  const fixture = await openChat('github-pull', [], undefined, {
    SHELL: `${BIN}/bash`,
    PATH: `${BIN}:${process.env.PATH}`,
    // The login shell exports a token, as a shell often does for something
    // else; gh would prefer it to the stored login, so Clave must not pass it.
    GITHUB_TOKEN: SHELL_TOKEN
  })
  const { app, win, record } = fixture
  try {
    // The bundled plugin is a feature of the app: on from the first start, its
    // tab claimed, without a visit to Settings.
    const plugin = await until(async () => {
      const found = (await win.evaluate(() => window.electronAPI.pluginsList())).find(
        (p) => p.id === 'clave.github'
      )
      return found?.status === 'active' && found.panels.includes('pull-request') ? found : null
    })
    t.check('the GitHub plugin is active on a fresh profile with its panel registered', !!plugin)

    await app.evaluate(({ ipcMain }) => {
      globalThis.__external = []
      ipcMain.removeHandler('shell:openExternal')
      ipcMain.handle('shell:openExternal', (_event, url) => {
        globalThis.__external.push(url)
      })
    })
    const external = () => app.evaluate(() => globalThis.__external)

    await inject(app, record.id, [
      {
        type: 'assistant_text',
        delta: `Opened [PR #42](${PULL_URL}) for [the issue](${ISSUE_URL}).`,
        final: true
      }
    ])
    const view = win.locator('[data-testid="chat-view"]')
    const pullLink = view.getByRole('link', { name: 'PR #42', exact: true })
    await pullLink.waitFor()

    // 1. A plain click opens the panel, not the browser.
    await pullLink.click()
    const panel = win.locator('[data-plugin-side-panel="pull-request"]')
    await panel.waitFor()
    await panel.locator('[data-testid="pr-title"]').waitFor()
    assert.equal(await panel.locator('[data-testid="pr-title"]').innerText(), 'Add the widget')
    assert.equal(await panel.locator('[data-testid="pr-state"]').innerText(), 'Open')
    assert.equal(
      await win.locator('[data-plugin-tab="pull-request"]').getAttribute('data-selected'),
      'true'
    )
    assert.deepEqual(await external(), [])
    const viewCall = callWith(['pr', 'view', '42', '--repo', 'acme/widgets', '--json'])
    assert.ok(viewCall, JSON.stringify(calls()))
    assert.match(viewCall.args[6], /(^|,)statusCheckRollup(,|$)/)
    assert.equal(viewCall.token, null, 'gh ran on the stored login, not the shell token')
    t.check('a pull request link opens the pull request in the side panel through gh', true)

    // 2. What the record says, drawn: the head and base, the checks, the conversation.
    assert.match(
      await panel.locator('.pr-meta-text').innerText(),
      /octocat wants to merge feat\/widget into dev/
    )
    assert.match(await panel.locator('.pr-signals').innerText(), /1 of 3 checks failed/)
    await panel.locator('[data-testid="pr-checks"] > summary').click()
    assert.equal(await panel.locator('[data-testid="pr-checks"] .pr-check').count(), 3)
    assert.equal(
      await panel.locator('[data-testid="pr-checks"] .pr-check[data-status="failure"]').innerText(),
      'lint · CI'
    )
    assert.equal(await panel.locator('[data-testid="pr-conversation"] .pr-comment').count(), 2)
    assert.equal(
      await panel.locator('.pr-comment[data-kind="review"] .pr-review-state').innerText(),
      'reviewed'
    )
    t.check('the panel draws branches, checks and the conversation from the record', true)

    // 3. The files section asks for the diff only when opened, and shows it per file.
    assert.equal(callWith(['pr', 'diff']), undefined)
    await panel.locator('[data-testid="pr-files"] > summary').click()
    await until(() => callWith(['pr', 'diff', '42', '--repo', 'acme/widgets']))
    const firstFile = panel.locator('[data-testid="pr-files"] .pr-file').first()
    await firstFile.locator('> summary').click()
    await firstFile.locator('.pr-file-diff').waitFor()
    assert.match(await firstFile.locator('.pr-file-diff').innerText(), /return `widget:\$\{size\}`/)
    assert.equal(await panel.locator('[data-testid="pr-files"] .pr-file').count(), 2)
    t.check('the diff is fetched on demand and shown under each file', true)

    // 4. A comment goes out on stdin, and the conversation shows it once gh answers again.
    const composer = panel.locator('[data-testid="pr-composer"]')
    await composer.fill('-- looks good from Clave')
    await panel.locator('[data-testid="pr-action-comment"]').click()
    const comment = await until(() => callWith(['pr', 'comment', '42', '--repo', 'acme/widgets']))
    assert.ok(comment, JSON.stringify(calls()))
    assert.deepEqual(comment.args.slice(5), ['--body-file', '-'])
    assert.equal(comment.stdin, '-- looks good from Clave')
    await panel.locator('.pr-comment', { hasText: '-- looks good from Clave' }).waitFor()
    assert.equal(await composer.inputValue(), '')
    t.check('a comment is posted through gh on stdin and reloaded into the conversation', true)

    // 5. Approve and merge: each is one gh call with the right verb.
    await panel.locator('[data-testid="pr-action-approve"]').click()
    const approval = await until(() => callWith(['pr', 'review', '42', '--repo', 'acme/widgets']))
    assert.ok(approval, JSON.stringify(calls()))
    assert.deepEqual(approval.args.slice(5), ['--approve', '--body-file', '-'])
    await panel.locator('[data-testid="pr-merge"]').click()
    await win.locator('[data-pr-merge-method="squash"]').waitFor({ state: 'visible' })
    await win.locator('[data-pr-merge-method="squash"]').click({ force: true })
    await win.getByRole('dialog').waitFor()
    await win.getByRole('dialog').getByRole('button', { name: 'Merge', exact: true }).click()
    const merge = await until(() => callWith(['pr', 'merge', '42', '--repo', 'acme/widgets']))
    assert.ok(merge, JSON.stringify(calls()))
    assert.deepEqual(merge.args.slice(5), ['--squash'])
    t.check('approve and merge run the matching gh commands, merge behind a confirmation', true)

    // 6. Everything else still goes to the browser: an issue link, and a
    //    modifier click on the pull request link itself.
    await view.getByRole('link', { name: 'the issue', exact: true }).click()
    assert.ok(await until(async () => (await external()).includes(ISSUE_URL)))
    await pullLink.click({ modifiers: ['Meta'] })
    assert.ok(await until(async () => (await external()).includes(PULL_URL)))
    t.check('other links and modifier clicks open externally', true)

    // 7. gh refusing is shown as gh's own words, with the way out.
    writeFileSync(FAIL, '')
    await panel.locator('[data-testid="pr-refresh"]').click()
    const stale = panel.locator('[data-testid="pr-error"][data-kind="auth"]')
    await stale.waitFor()
    assert.match(await stale.innerText(), /gh auth login/)
    await panel.getByRole('button', { name: 'Close pull request', exact: true }).click()
    await panel.locator('[data-testid="pr-empty"]').waitFor()
    await panel.locator('[data-pr-recent="acme/widgets#42"]').click()
    const failure = panel.locator('.pr-failure[data-kind="auth"]')
    await failure.waitFor()
    assert.match(await failure.innerText(), /Sign in with gh auth login/)
    unlinkSync(FAIL)
    t.check('a gh failure is shown as its own words, on refresh and on open', true)

    // 7b. A gh with no stored login is signed in by the shell's token after
    //     all: the run without it is refused, the one retry with it answers.
    writeFileSync(NEEDS_TOKEN, '')
    const viewsBefore = calls().filter((c) => c.args[0] === 'pr' && c.args[1] === 'view').length
    await panel.getByRole('button', { name: 'Close pull request', exact: true }).click()
    await panel.locator('[data-pr-recent="acme/widgets#42"]').click()
    await panel.locator('[data-testid="pr-title"]').waitFor()
    const views = calls()
      .filter((c) => c.args[0] === 'pr' && c.args[1] === 'view')
      .slice(viewsBefore)
    assert.deepEqual(
      views.map((c) => c.token),
      [null, SHELL_TOKEN],
      JSON.stringify(views)
    )
    unlinkSync(NEEDS_TOKEN)
    t.check('without a stored login, gh is retried once with the shell token', true)

    // 8. Pasting a link in the empty state opens it too.
    await panel.getByRole('button', { name: 'Close pull request', exact: true }).click()
    await panel.getByLabel('Pull request URL', { exact: true }).fill(ISSUE_URL)
    await panel.getByLabel('Pull request URL', { exact: true }).press('Enter')
    await panel.locator('.pr-empty-refused').waitFor()
    await panel.getByLabel('Pull request URL', { exact: true }).fill(`${PULL_URL}/files`)
    await panel.getByLabel('Pull request URL', { exact: true }).press('Enter')
    await panel.locator('[data-testid="pr-title"]').waitFor()
    t.check('a pasted pull request link opens; an issue link is refused', true)

    // 9. With the plugin off, the link is a link: the browser takes it.
    await win.evaluate(() => window.electronAPI.pluginsDisable('clave.github'))
    await win.locator('[data-plugin-tab="pull-request"]').waitFor({ state: 'detached' })
    const before = (await external()).length
    await pullLink.click()
    assert.ok(await until(async () => (await external()).length === before + 1))
    assert.equal((await external()).at(-1), PULL_URL)
    t.check('a disabled plugin leaves pull request links to the browser', true)
  } finally {
    await fixture.close()
    rmSync(BIN, { recursive: true, force: true })
  }
}
