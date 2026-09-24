import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { sidebarRows, until, fixturePath } from './harness.mjs'
import { openChat } from './chat-view.spec.mjs'

// A chat tab is named by its first message. A terminal tab has always been:
// main reads the first user message off Claude's transcript and asks a Haiku
// one-shot for a 2-4 word title. A chat tab has no transcript to watch, so the
// message is taken where main first sees it, the session write, and the title
// comes back on the same channel. This drives the real app with a stub `claude`
// on the PATH, so the assertion is on what the stub was asked and what the
// sidebar shows, never on a model's answer.

const BIN = fixturePath('chat-title-bin')
const LOG = `${BIN}/claude-calls.ndjson`
const TITLE = 'follow the first message'
const calls = () =>
  existsSync(LOG)
    ? readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : []

export async function run(t) {
  rmSync(BIN, { recursive: true, force: true })
  mkdirSync(BIN, { recursive: true })
  // A login shell fixture keeps the stub-first PATH instead of the host's path_helper.
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
  process.stdout.write(${JSON.stringify(TITLE)} + '\\n');
});
`,
    { mode: 0o755 }
  )
  const fixture = await openChat('chat-title', [], undefined, {
    SHELL: `${BIN}/bash`,
    PATH: `${BIN}:${process.env.PATH}`
  })
  const { win } = fixture
  try {
    const folder = 'clave-e2e-chat-title-root'
    const input = win.getByRole('textbox', { name: 'Message', exact: true })
    const assistantTurns = win.locator(
      '[data-testid="chat-view"] .chat-turn[data-role="assistant"]'
    )
    assert.ok((await sidebarRows(win)).some((row) => row.includes(folder)))

    // A bare yes is not an intention: the tab keeps its folder name and
    // nothing is asked of the CLI. (A slash command is refused the same way,
    // but the composer's own command popup takes Enter on one, so the
    // end-to-end check uses the other refusal.)
    await input.fill('yes')
    await input.press('Enter')
    await assistantTurns.nth(0).waitFor()
    await new Promise((resolve) => setTimeout(resolve, 1000))
    t.equal('a bare yes asks nothing of the CLI', calls().length, 0)
    t.check(
      'a bare yes leaves the folder name on the tab',
      (await sidebarRows(win)).some((row) => row.includes(folder))
    )

    // The first real message names the tab, from the CLI's answer.
    const message = 'please make the sidebar tab follow the first message I send'
    await input.fill(message)
    await input.press('Enter')
    await assistantTurns.nth(1).waitFor()
    const named = await until(async () =>
      (await sidebarRows(win)).some((row) => row.includes(TITLE))
    )
    t.check('the first message names the tab with the CLI’s title', named, await sidebarRows(win))
    const first = calls()
    t.equal('the CLI was asked exactly once', first.length, 1)
    t.check(
      'the CLI was asked as a one-shot on haiku',
      first[0]?.argv.slice(0, 3).join(' ') === '-p --model haiku',
      first[0]?.argv
    )
    t.check(
      'the prompt carries the message the user sent',
      first[0]?.prompt.includes(message),
      first[0]?.prompt
    )

    // A later message changes nothing: the name stands and the CLI is not asked again.
    await input.fill('and a second message must change nothing about the name')
    await input.press('Enter')
    await assistantTurns.nth(2).waitFor()
    await new Promise((resolve) => setTimeout(resolve, 1000))
    t.equal('a second message does not ask again', calls().length, 1)
    t.check(
      'the title survives the second message',
      (await sidebarRows(win)).some((row) => row.includes(TITLE)),
      await sidebarRows(win)
    )
  } finally {
    await fixture.close()
    rmSync(BIN, { recursive: true, force: true })
  }
}
