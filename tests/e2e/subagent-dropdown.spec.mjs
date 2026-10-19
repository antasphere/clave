import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  fixturePath,
  callMcp,
  until
} from './harness.mjs'

const DIR = userDataDir('subagent-dropdown')
const ROOT = fixturePath('subagent-dropdown-root')
const WS = {
  id: 'subagent-dropdown',
  name: 'Subagent dropdown',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}

export async function run(t) {
  mkdirSync(`${ROOT}/bin`, { recursive: true })
  // Only a recording terminal is reachable. No provider or account is called.
  writeFileSync(
    `${ROOT}/bin/codex`,
    `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(ROOT)} + '/started-' + process.env.CLAVE_SESSION_ID, 'recording-only')
const esc = String.fromCharCode(27)
const title = value => process.stdout.write(esc + ']0;' + value + String.fromCharCode(7))
title('codex | Ready')
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const clean = line.split(esc + '[I').join('').split(esc + '[O').join('')
  title(clean.trim())
})
`,
    { mode: 0o755 }
  )
  writeFileSync(
    `${ROOT}/bin/sh`,
    `#!/bin/sh
export PATH='${ROOT}/bin':"$PATH"
[ "$1" = '-l' ] && shift
exec /bin/sh "$@"
`,
    { mode: 0o755 }
  )
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])
  const { app, win } = await launchApp(DIR, {
    server: 'in-process',
    env: { SHELL: `${ROOT}/bin/sh`, PATH: `${ROOT}/bin:${process.env.PATH}` }
  })
  try {
    const open = async (name, callerSessionId, mode = 'codex') => {
      const result = await callMcp(app, 'openSession', { cwd: ROOT, name, mode, callerSessionId })
      assert.ok(result?.sessionId, JSON.stringify(result))
      return result.sessionId
    }
    const parent = await open('Coordinator')
    const child = await open('Explorer', parent)
    const nested = await open('Verifier', child)
    const terminal = await open('Dev terminal', parent, 'terminal')
    const row = (id) => win.locator(`[data-sidebar-item-id="${id}"]`)
    await row(parent).waitFor()
    for (const id of [parent, child, nested])
      assert.ok(
        await until(() => existsSync(`${ROOT}/started-${id}`)),
        `recording CLI must start for ${id}`
      )
    t.equal(
      'descendants do not consume ordinary rows',
      (await row(child).count()) + (await row(nested).count()),
      0
    )
    t.equal('spawned plain terminal keeps its row', await row(terminal).count(), 1)
    // Fail before implementation at the behavior assertion, not a missing locator timeout.
    assert.equal(
      await row(child).count(),
      0,
      'spawned agent must be represented by its parent selector'
    )
    const listing = () => callMcp(app, 'list', {})
    const focused = async (id) =>
      assert.ok(
        await until(async () => (await listing()).focusedSessionId === id),
        `focus must reach ${id}`
      )
    const trigger = () => row(parent).getByRole('button', { name: /^Subagents of Coordinator/ })
    const menuItem = (name) => win.getByRole('menuitem').filter({ hasText: name })
    const pick = async (name) => {
      await trigger().click()
      await menuItem(name).click()
    }
    t.equal(
      'only a parent with descendants has a selector',
      await win.locator('.subagent-trigger').count(),
      1
    )
    t.equal(
      'the trigger is a sibling, never a nested button',
      await win.locator('button button.subagent-trigger').count(),
      0
    )
    await pick('Explorer')
    await focused(child)
    t.check(
      'the trigger names the selected live child',
      /Explorer/.test(await trigger().innerText())
    )
    t.equal(
      'the parent row marks a hidden selected child',
      await row(parent).locator('.sidebar-item').getAttribute('data-selected'),
      'true'
    )
    await pick('Verifier')
    await focused(nested)
    await trigger().click()
    t.check(
      'the menu gives the current state in words',
      /Idle|Working|Done|Ended|New activity|Waiting on you/.test(
        await menuItem('Verifier').innerText()
      )
    )
    await menuItem('Coordinator').click()
    await focused(parent)

    // The live PTY's own title changes while the menu remains open.
    await trigger().click()
    for (const [title, state, label] of [
      ['codex | Working', 'working', 'Working'],
      ['[ ! ] Action Required | codex', 'blocked', 'Waiting on you']
    ]) {
      await win.evaluate(({ id, title }) => window.electronAPI.writeSession(id, title + '\n'), {
        id: child,
        title
      })
      assert.ok(
        await until(
          async () => (await listing()).sessions.find((s) => s.id === child)?.agentState === state
        ),
        `recording PTY must report ${state}`
      )
      assert.ok(await until(async () => (await menuItem('Explorer').innerText()).includes(label)))
      t.check(`open menu follows live child state: ${label}`, true)
    }
    await win.keyboard.press('Escape')
    await win.getByRole('menu').waitFor({ state: 'hidden' })

    // Keyboard opening, arrow traversal, selection, Escape and return focus.
    await trigger().focus()
    await win.keyboard.press('Enter')
    await win.waitForFunction(
      () => document.activeElement?.getAttribute('role') === 'menuitem',
      null,
      { timeout: 10000 }
    )
    await win.keyboard.press('ArrowDown')
    await win.waitForFunction(
      () => document.activeElement?.textContent?.includes('Explorer'),
      null,
      { timeout: 10000 }
    )
    await win.keyboard.press('Enter')
    await focused(child)
    await trigger().focus()
    await win.keyboard.press('Enter')
    await win.keyboard.press('Escape')
    await win.getByRole('menu').waitFor({ state: 'hidden' })
    t.check(
      'Escape returns keyboard focus to the selector',
      await trigger().evaluate((e) => e === document.activeElement)
    )
    await row(parent).locator('.sidebar-item').click()
    await focused(parent)

    // Search exposes a child's own row and leaves its real identity selected.
    await win.fill('.group-switcher-search input', 'Verifier')
    await row(nested).waitFor()
    t.equal('search exposes matching nested child directly', await row(nested).count(), 1)
    await row(nested).locator('.sidebar-item').click()
    await focused(nested)
    await win.fill('.group-switcher-search input', '')
    await trigger().waitFor()
    t.check(
      'clearing search keeps the selected child marked on its parent',
      /Verifier/.test(await trigger().innerText())
    )

    // Range selection uses the represented root as the hidden child's anchor.
    await pick('Explorer')
    await row(terminal)
      .locator('.sidebar-item')
      .click({ modifiers: ['Shift'] })
    t.equal(
      'range selection covers the two rendered rows',
      await win.locator('.sidebar-item[data-selected="true"]').count(),
      2
    )
    await trigger().click()
    t.equal(
      'range selection does not include the hidden child',
      await menuItem('Explorer').getAttribute('data-selected'),
      null
    )
    t.equal(
      'the menu announces the selected parent to assistive technology',
      await menuItem('Coordinator').getAttribute('aria-current'),
      'true'
    )
    await menuItem('Coordinator').click()

    // A child in another group compacts only while its parent is reachable.
    const group = await callMcp(app, 'createGroup', { name: 'Workers' })
    assert.ok(group?.groupId)
    await callMcp(app, 'moveSession', { sessionId: child, groupId: group.groupId })
    t.equal('cross-group child compacts under the reachable parent', await row(child).count(), 0)
    const chip = win
      .locator('.group-switcher-chips .group-switcher-chip')
      .filter({ hasText: 'Workers' })
    await chip.click()
    await row(child).waitFor()
    t.equal('filtering out the parent restores the child row', await row(child).count(), 1)
    await win.locator('.group-switcher-head .group-switcher-chip').click()
    await trigger().waitFor()
    t.equal('All compacts the child again', await row(child).count(), 0)

    const parentGroup = await callMcp(app, 'createGroup', { name: 'Coordination' })
    assert.ok(parentGroup?.groupId)
    await callMcp(app, 'moveSession', { sessionId: parent, groupId: parentGroup.groupId })
    const parentHeader = win.locator(`[data-sidebar-item-id="${parentGroup.groupId}"]`)
    await parentHeader.locator('.sidebar-tab-icon').first().click()
    await row(child).waitFor()
    t.equal(
      'a collapsed parent in another group leaves the child reachable',
      await row(child).count(),
      1
    )
    await parentHeader.locator('.sidebar-tab-icon').first().click()
    await trigger().waitFor()
    t.equal(
      'expanding the parent compacts its cross-group children again',
      await row(child).count(),
      0
    )

    // All four Clave sessions remain available to tools and the session host.
    const all = await listing()
    for (const id of [parent, child, nested, terminal])
      assert.ok(all.sessions.some((s) => s.id === id))
    t.equal('MCP still lists every live session', all.sessions.length, 4)
    const kernel = await win.evaluate(() => window.electronAPI.sessionsList())
    for (const id of [parent, child, nested, terminal]) assert.ok(kernel.some((s) => s.id === id))
    t.check('the actual live session host retains children', true)

    // Theme tokens and geometry, in every supported theme.
    for (const theme of ['dark', 'light', 'coffee', 'charcoal']) {
      await win.evaluate((theme) => window.electronAPI.skinsActivate(theme), theme)
      await trigger().click()
      const geometry = await trigger().evaluate((button) => {
        const b = button.getBoundingClientRect()
        const row = button.parentElement.getBoundingClientRect()
        const style = getComputedStyle(button)
        return {
          fits: b.left >= row.left && b.right <= row.right + 1,
          color: style.color,
          background: style.backgroundColor
        }
      })
      t.check(`${theme}: compact trigger stays within its row`, geometry.fits, geometry)
      await win.keyboard.press('Escape')
      await win.getByRole('menu').waitFor({ state: 'hidden' })
    }

    // Closing a root re-roots survivors; closing the intermediate exposes its child.
    await callMcp(app, 'closeSession', { sessionId: parent })
    await row(child).waitFor()
    t.equal('surviving child becomes an ordinary parent row', await row(child).count(), 1)
    t.equal('nested child stays represented by the surviving parent', await row(nested).count(), 0)
    await callMcp(app, 'closeSession', { sessionId: child })
    await row(nested).waitFor()
    t.equal('last orphan becomes an ordinary row', await row(nested).count(), 1)
    t.equal(
      'orphan has no empty selector',
      await row(nested).locator('.subagent-trigger').count(),
      0
    )
  } finally {
    await app.close()
  }
}
