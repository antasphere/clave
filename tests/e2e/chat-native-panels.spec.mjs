// PRDCT-3643: /mcp and /plugin open native panels in a Claude chat tab and act
// through control requests on the session's process; the agent never sees the
// bare command, and the HTTP boundary refuses anything outside the closed set.
// Written by the lane's verifier against a stub CLI, kept as the spec. Pinned
// to the in-process server: the stub is found on this process's PATH.
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  until,
  userDataDir,
  fixturePath,
  serverEndpoint
} from './harness.mjs'
const DIR = userDataDir('chat-native-panels')
const ROOT = fixturePath('chat-native-panels-root')
const inputs = () =>
  existsSync(`${ROOT}/input.ndjson`)
    ? readFileSync(`${ROOT}/input.ndjson`, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(JSON.parse)
    : []
export async function run(t) {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(`${ROOT}/bin`, { recursive: true })
  seedWorkspaces(DIR, {
    workspaces: [{ id: 'np', name: 'NP', rootDir: ROOT, profileFile: null, createdAt: 1 }],
    activeWorkspaceId: 'np',
    fresh: true
  })
  seedTrustedRoots(DIR, [ROOT])
  writeFileSync(
    `${ROOT}/bin/bash`,
    '#!/bin/sh\nif [ "$1" = "-lic" ]; then env -0; else shift; exec /bin/bash --noprofile --norc "$@"; fi\n',
    { mode: 0o755 }
  )
  writeFileSync(
    `${ROOT}/bin/claude`,
    `#!${process.execPath}
const fs = require('node:fs'); const readline = require('node:readline');
if (!process.argv.includes('--session-id')) { process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write('stub title\\n'); process.exit(0); }); return; }
const emit = (f) => process.stdout.write(JSON.stringify(f) + '\\n');
const servers = { alpha: { name: 'alpha', status: 'connected', scope: 'user', config: { type: 'http', url: 'https://a' }, tools: [{name:'x'},{name:'y'}], serverInfo: { name: 'A' } },
                  beta: { name: 'beta', status: 'needs-auth', scope: 'dynamic', source: 'plugin', config: { type: 'stdio', command: 'npx' } } };
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  fs.appendFileSync(${JSON.stringify(`${ROOT}/input.ndjson`)}, line + '\\n');
  const input = JSON.parse(line);
  if (input.type !== 'control_request') return;
  const ok = (response) => emit({ type: 'control_response', response: { subtype: 'success', request_id: input.request_id, ...(response ? { response } : {}) } });
  const err = (error) => emit({ type: 'control_response', response: { subtype: 'error', request_id: input.request_id, error } });
  const r = input.request;
  if (r.subtype === 'initialize') return ok({ commands: [{ name: 'review', description: 'Review a PR' }, { name: 'mcp', description: 'the CLI one' }, { name: 'resume', description: 'the CLI one' }], models: [{ value: 'sonnet', displayName: 'Sonnet' }] });
  if (r.subtype === 'mcp_status') return ok({ mcpServers: Object.values(servers) });
  if (r.subtype === 'mcp_toggle') { if (!servers[r.serverName]) return err('Server not found: ' + r.serverName); servers[r.serverName].status = r.enabled ? 'connected' : 'disabled'; return ok(); }
  if (r.subtype === 'mcp_reconnect') return err('boom from ' + r.serverName);
  if (r.subtype === 'reload_plugins') return ok({ commands: [1,2,3], agents: [], plugins: [1,2], mcpServers: [1], error_count: 0 });
  return err('Unsupported control request subtype: ' + r.subtype);
});
setInterval(() => {}, 1000);
`,
    { mode: 0o755 }
  )
  const { app, win } = await launchApp(DIR, {
    env: { SHELL: `${ROOT}/bin/bash`, PATH: `${ROOT}/bin:${process.env.PATH}` },
    server: 'in-process'
  })
  try {
    await win.evaluate(() => window.electronAPI.launchProfileSetGlobal('claude', 'claude-chat'))
    await win.reload()
    await win.locator('.launcher-split .launcher-btn').waitFor()
    await win.click('.launcher-split .launcher-btn')
    const session = await until(async () =>
      (await win.evaluate(() => window.electronAPI.sessionsList())).find(
        (s) => s.adapterId === 'claude-chat'
      )
    )
    assert.ok(session, 'a Claude chat session opened')
    const textarea = win.locator('[data-testid="chat-view"] textarea:not(:disabled)')
    await textarea.waitFor()
    await new Promise((r) => setTimeout(r, 800))
    // 1. Slash menu offers /mcp as a host command; Enter opens the panel.
    await textarea.click()
    await win.keyboard.type('/mc')
    // Scoped to the chat view: the hidden terminal view mounts a menu of its own.
    const option = win.locator('[data-testid="chat-view"] .chat-slash-option', { hasText: '/mcp' })
    await option.first().waitFor()
    const optionText = await option.first().textContent()
    t.check(
      'slash menu offers /mcp with the host description',
      optionText.includes('Manage MCP servers'),
      optionText
    )
    const allOptions = await win
      .locator('[data-testid="chat-view"] .chat-slash-name')
      .allTextContents()
    t.check(
      'one /mcp entry in the slash menu (CLI duplicate dropped)',
      allOptions.filter((x) => x === '/mcp').length === 1,
      JSON.stringify(allOptions)
    )
    await win.keyboard.press('Enter')
    const mcp = win.locator('section[data-kind="mcp"]')
    await mcp.waitFor()
    await win.locator('section[data-kind="mcp"] .chat-control-row').nth(1).waitFor()
    const rows = await win.locator('section[data-kind="mcp"] .chat-control-row').allTextContents()
    t.check(
      'mcp panel lists both servers with status, tools and scope',
      rows.length === 2 &&
        /alpha.*Connected.*2 tools.*user/.test(rows[0]) &&
        /beta.*Needs sign-in.*dynamic/.test(rows[1]),
      JSON.stringify(rows)
    )
    t.check(
      'beta (needs-auth) offers Authenticate, not Reconnect',
      (await mcp
        .locator('.chat-control-row', { hasText: 'beta' })
        .getByRole('button', { name: 'Authenticate' })
        .count()) === 1 &&
        (await mcp
          .locator('.chat-control-row', { hasText: 'beta' })
          .getByRole('button', { name: 'Reconnect' })
          .count()) === 0
    )
    t.check(
      'alpha (connected, http) offers Reconnect and Sign out',
      (await mcp
        .locator('.chat-control-row', { hasText: 'alpha' })
        .getByRole('button', { name: 'Sign out' })
        .count()) === 1
    )
    let seen = inputs()
    t.check(
      'opening /mcp sent mcp_status and no user message',
      seen.some((l) => l.type === 'control_request' && l.request.subtype === 'mcp_status') &&
        !seen.some((l) => l.type === 'user'),
      JSON.stringify(seen.map((l) => l.type + ':' + (l.request?.subtype ?? '')))
    )
    t.check('the composer was cleared', (await textarea.inputValue()) === '')
    t.check(
      'focus moved to the filter input',
      (await win.evaluate(() => document.activeElement?.getAttribute('aria-label'))) ===
        'Filter servers'
    )
    // 2. Toggle alpha off: request shape on stdin, status re-read, switch follows.
    await mcp.getByRole('switch', { name: 'Disable alpha' }).click()
    await mcp.getByRole('switch', { name: 'Enable alpha' }).waitFor()
    seen = inputs()
    const toggle = seen.find((l) => l.request?.subtype === 'mcp_toggle')
    t.check(
      'mcp_toggle reached stdin as {subtype, serverName, enabled}',
      JSON.stringify(toggle?.request) ===
        JSON.stringify({ subtype: 'mcp_toggle', serverName: 'alpha', enabled: false }),
      JSON.stringify(toggle)
    )
    t.check(
      'a status re-read followed the toggle',
      seen.filter((l) => l.request?.subtype === 'mcp_status').length >= 2
    )
    const alphaRow = mcp.locator('.chat-control-row', { hasText: 'alpha' })
    t.check(
      'a disabled server shows Disabled and only the switch',
      /Disabled/.test(await alphaRow.textContent()) &&
        (await alphaRow.getByRole('button', { name: 'Reconnect' }).count()) === 0
    )
    // 3. A refused reconnect shows the CLI's words in the row.
    await mcp.getByRole('switch', { name: 'Enable alpha' }).click()
    await alphaRow.getByRole('button', { name: 'Reconnect' }).waitFor()
    await alphaRow.getByRole('button', { name: 'Reconnect' }).click()
    await alphaRow.locator('.chat-control-error').waitFor()
    const errText = await alphaRow.locator('.chat-control-error').textContent()
    t.check(
      'a refused reconnect shows the CLI error in the row',
      errText.includes('boom from alpha'),
      errText
    )
    // 4. Escape from a row's control (not only the filter) closes the panel and
    // returns focus to the composer.
    await mcp.getByRole('switch', { name: 'Disable alpha' }).focus()
    await win.keyboard.press('Escape')
    await until(async () => (await mcp.count()) === 0)
    t.check(
      'Escape from a switch closes the panel and focuses the composer',
      (await win.evaluate(() => document.activeElement?.tagName)) === 'TEXTAREA'
    )
    // 5. /plugin typed whole opens the plugin panel; Reload sends reload_plugins.
    await textarea.click()
    await win.keyboard.type('/plugin')
    await win.keyboard.press('Enter')
    const plugins = win.locator('section[data-kind="plugins"]')
    await plugins.waitFor()
    await until(async () => !(await plugins.textContent()).includes('Loading…'))
    const before = inputs().length
    await plugins.getByRole('button', { name: 'Reload plugins' }).click()
    await plugins.locator('.chat-control-note').waitFor()
    const note = await plugins.locator('.chat-control-note').textContent()
    t.check(
      'reload summary counts the answer',
      note === 'Reloaded: 2 plugins, 3 commands, 1 MCP server.',
      note
    )
    t.check(
      'reload_plugins reached stdin',
      inputs()
        .slice(before)
        .some((l) => l.request?.subtype === 'reload_plugins')
    )
    t.check('no user message reached the agent so far', !inputs().some((l) => l.type === 'user'))
    await plugins.getByRole('button', { name: 'Close' }).click()
    await until(async () => (await plugins.count()) === 0)
    // 6. /plugins alias and /resume still work.
    await textarea.click()
    await win.keyboard.type('/plugins')
    await win.keyboard.press('Enter')
    await plugins.waitFor()
    t.check('/plugins opens the plugin panel', true)
    await plugins.getByLabel('Filter plugins').focus()
    await win.keyboard.press('Escape')
    await until(async () => (await plugins.count()) === 0)
    await textarea.click()
    await win.keyboard.type('/resume')
    await win.keyboard.press('Enter')
    const resume = win.locator('section[data-kind="resume"]')
    await resume.waitFor()
    t.check('/resume still opens its picker', true)
    await resume.getByLabel('Search conversations').focus()
    await win.keyboard.press('Escape')
    await until(async () => (await resume.count()) === 0)
    // 7. HTTP boundary: the closed set holds on the server endpoint.
    const disc = serverEndpoint(DIR)
    assert.ok(disc?.url && disc?.token, 'server endpoint published')
    const post = (request) =>
      fetch(`${disc.url}/sessions/control`, {
        method: 'POST',
        headers: { authorization: `Bearer ${disc.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ id: session.id, request })
      }).then(async (r) => ({ status: r.status, body: await r.text() }))
    const refused = await post({ type: 'set_permission_mode', mode: 'bypassPermissions' })
    const empty = await post({ type: 'mcp_toggle', server: '', enabled: true })
    const okStatus = await post({ type: 'mcp_status' })
    t.check(
      'HTTP refuses set_permission_mode',
      refused.status >= 400 && refused.status < 500,
      JSON.stringify(refused)
    )
    t.check(
      'HTTP refuses an empty server name',
      empty.status >= 400 && empty.status < 500,
      JSON.stringify(empty)
    )
    t.check(
      'HTTP passes mcp_status and answers the CLI body',
      okStatus.status === 200 && okStatus.body.includes('"alpha"'),
      JSON.stringify(okStatus).slice(0, 300)
    )
    t.check(
      'nothing outside the set reached stdin',
      !inputs().some(
        (l) =>
          l.request?.subtype === 'set_permission_mode' ||
          (l.request?.subtype === 'mcp_toggle' && l.request.serverName === '')
      )
    )
    // 8. A command with arguments goes to the agent as text.
    await textarea.click()
    await win.keyboard.type('/mcp enable alpha')
    await win.keyboard.press('Enter')
    await until(() => inputs().some((l) => l.type === 'user'))
    const user = inputs().find((l) => l.type === 'user')
    t.check(
      '/mcp with arguments reaches the CLI as a user message',
      JSON.stringify(user).includes('/mcp enable alpha') && (await mcp.count()) === 0,
      JSON.stringify(user).slice(0, 200)
    )
  } finally {
    await app.close()
  }
}
