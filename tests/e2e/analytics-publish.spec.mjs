// Publish: a page of the bundled Analytics plugin pushed to Slideless as a deck of its own,
// through the person's own CLI on their own login. Nothing here reaches Slideless: the
// `slideless` on the PATH is a stub that answers `whoami --json` and `push --json` from
// fixtures and records every call it gets, so the checks are on the arguments the plugin
// gave the CLI (an argument list, never a shell string), on the deck file it wrote under its
// data folder, on the data it kept beside its ledger, and on the sentence the page says when
// the stub refuses. The plugin runs in its own process with the path the host hands it, so
// the stub reaches it the way a dev app's or a packaged app's CLI does.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fixturePath, fixtureRoot, until } from './harness.mjs'
import { openChat } from './chat-view.spec.mjs'
import { PAGE, PLUGIN, inGuest, menuItem, menuItems, rowButton } from './analytics-actions.spec.mjs'

const BIN = fixturePath('analytics-publish-bin')
const CALLS = `${BIN}/slideless-calls.jsonl`
const COUNTER = `${BIN}/slideless-version`
const REFUSE = `${BIN}/slideless-refuse`
const AUTH_SENTENCE =
  'Slideless is not signed in: run slideless login in a terminal, then publish again.'

function writeStub() {
  rmSync(BIN, { recursive: true, force: true })
  mkdirSync(BIN, { recursive: true })
  writeFileSync(
    `${BIN}/slideless`,
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify({ args }) + '\\n');
// A CLI with no key: every command is refused with the CLI's own sentence.
if (fs.existsSync(${JSON.stringify(REFUSE)})) {
  process.stderr.write('An API key is required. Sign in (\`slideless login\`), pass --api-key, or set SLIDELESS_API_KEY.\\n');
  process.exit(1);
}
if (args[0] === 'whoami') {
  process.stdout.write(JSON.stringify({ user: { email: 'me@example.test' } }));
  process.exit(0);
}
if (args[0] === 'push') {
  if (!fs.existsSync(path.join(args[1], 'index.html'))) {
    process.stderr.write('no index.html in ' + args[1] + '\\n');
    process.exit(2);
  }
  const n = (fs.existsSync(${JSON.stringify(COUNTER)}) ? Number(fs.readFileSync(${JSON.stringify(COUNTER)}, 'utf8')) : 0) + 1;
  fs.writeFileSync(${JSON.stringify(COUNTER)}, String(n));
  process.stdout.write(JSON.stringify({
    presentation: { id: 'deck-e2e', title: 'x' },
    version: { version: n },
    url: 'https://share.example.test/decks/deck-e2e/present'
  }));
  process.exit(0);
}
process.stderr.write('unknown command\\n');
process.exit(2);
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
        .map((line) => JSON.parse(line).args)
    : []

const status = (win) =>
  inGuest(win, `document.querySelector('.publish-status')?.textContent ?? null`)
const statusWith = (win, part) =>
  until(async () => {
    const text = await status(win)
    return typeof text === 'string' && text.includes(part) ? text : null
  })
const clickPublish = (win) =>
  inGuest(
    win,
    `(() => { const b = document.querySelector('.publish-button'); if (!b || b.disabled) return null; b.click(); return true })()`
  )

export async function run(t) {
  writeStub()
  const chat = await openChat('analytics-publish', [], undefined, {
    PATH: `${BIN}:${process.env.PATH}`
  })
  const { win, record } = chat
  try {
    await until(async () => {
      const plugin = (await win.evaluate(() => window.electronAPI.pluginsList())).find(
        (p) => p.id === PLUGIN
      )
      return plugin?.status === 'active' && plugin.actions.includes('deck') ? plugin : null
    })
    await rowButton(win, record.id).click({ button: 'right' })
    await menuItems(win).first().waitFor()
    await menuItem(win, 'Analytics').click()
    await win.locator(PAGE).waitFor({ timeout: 10_000 })
    const notYet = await statusWith(win, 'Not published yet')
    t.check('the served page offers Publish and says it was never published', !!notYet)

    // 1. The first publish: the CLI and the sign-in checked, then a new deck with the page's
    // title, the names redacted, the deck file and the snapshot under the data folder.
    await until(() => clickPublish(win))
    const first = await statusWith(win, 'Published as version 1')
    t.check('the page says it was published as version 1', !!first, String(first))
    const after1 = calls()
    assert.deepEqual(after1[0], ['whoami', '--json'])
    const push1 = after1[1]
    assert.ok(push1, JSON.stringify(after1))
    const folder = push1[1]
    // The title is visible on Slideless, so with the names left out it follows the redaction.
    assert.deepEqual(push1, [
      'push',
      folder,
      '--json',
      '--no-open',
      '--title',
      'Session 1 · Analytics',
      '--new'
    ])
    t.check(
      'the CLI was asked who it is, then given the folder as one argument and a redacted title',
      true
    )
    // The host hands the plugin a data folder of its own: under the profile in-process, under
    // the separate server's directory when attached. The push's folder says where it is.
    const dataDir = path.resolve(folder, '..', '..')
    t.check(
      'the deck folder sits under the plugin data folder the host handed it',
      folder.startsWith(fixtureRoot()) &&
        folder.includes(path.join('clave-plugins', 'data', PLUGIN, 'decks', 'session-')) &&
        existsSync(folder),
      folder
    )
    const deck = readFileSync(path.join(folder, 'index.html'), 'utf8')
    const block = /<script type="application\/json" id="slideless-data">([\s\S]*?)<\/script>/.exec(
      deck
    )
    assert.ok(block, 'the deck carries its data block')
    const data = JSON.parse(block[1])
    t.check(
      'the deck is a still of the session page with its names redacted',
      deck.includes('<meta name="analytics-mode" content="deck" />') &&
        deck.includes('<meta name="analytics-events" content="" />') &&
        !deck.includes('<link rel="stylesheet"') &&
        data.kind === 'session' &&
        data.name === 'Session 1' &&
        !deck.includes(record.title),
      JSON.stringify({ kind: data.kind, name: data.name })
    )
    const snapshots = (n) => path.join(dataDir, 'published', `${path.basename(folder)}-${n}.json`)
    const snap1 = JSON.parse(readFileSync(snapshots(1), 'utf8'))
    t.check(
      'what was pushed is kept beside the ledger, version 1 without names',
      snap1.deck === 'deck-e2e' &&
        snap1.version === 1 &&
        snap1.names === false &&
        snap1.data.name === 'Session 1',
      JSON.stringify({ deck: snap1.deck, version: snap1.version, names: snap1.names })
    )
    const label = await until(async () => {
      const text = await inGuest(
        win,
        `document.querySelector('.publish-label')?.textContent ?? null`
      )
      return text === 'Update' ? text : null
    })
    t.equal('the button now offers an update', label, 'Update')

    // 2. The update: a new version of the same deck, without a title, the names included
    // when the box is ticked.
    await inGuest(win, `document.querySelector('.publish-names-box').click(); true`)
    await until(() => clickPublish(win))
    const second = await statusWith(win, 'Published as version 2')
    t.check('the update says version 2', !!second, String(second))
    const after2 = calls()
    const push2 = after2[3]
    assert.ok(push2, JSON.stringify(after2))
    t.check(
      'the update pushes a new version of the deck on record, without a title',
      push2[0] === 'push' &&
        push2[1] === folder &&
        push2.includes('--id') &&
        push2[push2.indexOf('--id') + 1] === 'deck-e2e' &&
        !push2.includes('--title') &&
        !push2.includes('--new'),
      JSON.stringify(push2)
    )
    const deck2 = readFileSync(path.join(folder, 'index.html'), 'utf8')
    const snap2 = JSON.parse(readFileSync(snapshots(2), 'utf8'))
    t.check(
      'with the box ticked the deck and the snapshot carry the real name',
      deck2.includes(record.title) && snap2.names === true && snap2.data.name === record.title,
      JSON.stringify({ names: snap2.names, name: snap2.data.name })
    )

    // 3. The CLI refuses: the page says so in one sentence with the command to run, and
    // nothing is pushed.
    writeFileSync(REFUSE, '')
    const before = calls().length
    await until(() => clickPublish(win))
    const refused = await statusWith(win, 'not signed in')
    t.equal(
      'a CLI that is not signed in is said on the page, with the command',
      refused,
      AUTH_SENTENCE
    )
    const after3 = calls()
    t.check(
      'the refused sign-in check stops before any push',
      after3.length === before + 1 && after3[before][0] === 'whoami',
      JSON.stringify(after3.slice(before))
    )
    t.check(
      'the deck on record survives a refused update',
      existsSync(snapshots(2)) && !existsSync(snapshots(3))
    )
  } finally {
    await chat.close()
  }
}

assert.ok(run)
