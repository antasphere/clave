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
      await win.getByRole('menu').waitFor({ state: 'hidden' })
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
    // V1-02: digits count the represented sidebar rows, not folded descendants.
    await row(parent).locator('.sidebar-item').click()
    await win.keyboard.press('Meta+2')
    t.equal(
      'number shortcut 2 selects the second represented row',
      (await listing()).focusedSessionId,
      parent
    )
    await row(parent).locator('.sidebar-item').click()
    await win.keyboard.press('Meta+Shift+]')
    await focused(terminal)
    await win.keyboard.press('Meta+Shift+]')
    await focused(nested)
    t.check(
      'next-session cycling still reaches and marks folded children',
      /Verifier/.test(await trigger().innerText())
    )
    await win.keyboard.press('Meta+Shift+[')
    await focused(terminal)
    t.check('previous-session cycling retains the full session order', true)
    await row(parent).locator('.sidebar-item').click()

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

    // V1-01: unselected descendants must signal attention while the menu is closed.
    const title = async (id, value, state) => {
      await win.evaluate(({ id, value }) => window.electronAPI.writeSession(id, value + '\n'), {
        id,
        value
      })
      assert.ok(
        await until(
          async () => (await listing()).sessions.find((s) => s.id === id)?.agentState === state
        )
      )
    }
    const checkSignal = async (status, token) => {
      let paint
      const settled = await until(
        async () => {
          paint = await trigger().evaluate(
            (button, { status, token }) => {
              const signal = button.querySelector(`.tab-status[data-status="${status}"]`)
              const probe = document.createElement('span')
              probe.style.color = `var(${token})`
              button.appendChild(probe)
              const expected = getComputedStyle(probe).color
              probe.remove()
              const rect = signal?.getBoundingClientRect()
              return {
                visible: !!rect?.width && !!rect?.height,
                actual: signal ? getComputedStyle(signal).color : null,
                expected
              }
            },
            { status, token }
          )
          return paint.visible && paint.actual === paint.expected
        },
        { tries: 20, gapMs: 50 }
      )
      t.check(
        `closed ${status} signal is visible and uses the existing status color`,
        settled,
        paint
      )
    }
    await title(nested, 'codex | Working', 'working')
    t.equal(
      'closed selector reports a blocked child ahead of working',
      await trigger().getAttribute('data-status'),
      'needs-you'
    )
    t.check(
      'closed selector names the child waiting on the user',
      /Explorer.*Waiting on you/.test(await trigger().getAttribute('aria-label'))
    )
    t.equal(
      'aggregate alert preserves the parent actual state',
      await row(parent).locator('.sidebar-tab-icon').getAttribute('data-status'),
      'idle'
    )
    await checkSignal('needs-you', '--color-status-waiting')
    await title(child, 'codex | Ready', 'idle')
    t.equal(
      'closed selector reports unread child ahead of working',
      await trigger().getAttribute('data-status'),
      'unread'
    )
    await checkSignal('unread', '--color-status-working')
    await pick('Explorer')
    await focused(child)
    t.equal(
      'reading the child clears its unread alert and reveals remaining work',
      await trigger().getAttribute('data-status'),
      'working'
    )
    await title(nested, 'codex | Ready', 'idle')
    await pick('Verifier')
    await focused(nested)
    t.equal(
      'reading the remaining child clears aggregate alerts',
      await trigger().getAttribute('data-status'),
      'idle'
    )
    await pick('Coordinator')
    await focused(parent)

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

    // N2-01: an already-visible parent's editor must keep its descendants folded.
    const rowOrder = () =>
      win
        .locator('[data-sidebar-item-type="session"]')
        .evaluateAll((rows) =>
          rows
            .filter((row) => !row.closest('[data-group-collapsed="true"]'))
            .map((row) => row.getAttribute('data-sidebar-item-id'))
        )
    const ordinaryOrder = JSON.stringify(await rowOrder())
    let parentName = 'Coordinator'
    for (const key of ['Enter', 'Escape']) {
      await row(parent).locator('.sidebar-item').click({ button: 'right' })
      await win.getByRole('menuitem', { name: 'Rename', exact: true }).click()
      const editor = row(parent).locator('input')
      await editor.waitFor()
      await editor.fill(`Coordinator ${key}`)
      t.equal(
        `parent Rename ${key} keeps descendants folded while typing`,
        (await row(child).count()) + (await row(nested).count()),
        0
      )
      t.equal(
        `parent Rename ${key} preserves represented row order`,
        JSON.stringify(await rowOrder()),
        ordinaryOrder
      )
      t.equal(
        `parent Rename ${key} retains its descendant selector`,
        await row(parent).locator('.subagent-trigger').count(),
        1
      )
      await editor.press(key)
      if (key === 'Enter') parentName = `Coordinator ${key}`
      assert.ok(
        await until(
          async () => (await listing()).sessions.find((s) => s.id === parent)?.name === parentName
        )
      )
      t.check(`parent Rename ${key} ${key === 'Enter' ? 'commits' : 'cancels'} the edit`, true)
    }
    await callMcp(app, 'rename', { target: 'session', id: parent, name: 'Coordinator' })
    assert.ok(
      await until(
        async () => (await listing()).sessions.find((s) => s.id === parent)?.name === 'Coordinator'
      )
    )

    // N3-01: a temporary editable root keeps its own descendants attached.
    for (const [target, name, hasDescendants] of [
      [child, 'Explorer', true],
      [nested, 'Verifier', false]
    ]) {
      let committedName = name
      for (const key of ['Enter', 'Escape']) {
        await trigger().click()
        await menuItem(committedName).click({ button: 'right' })
        await win.getByRole('menuitem', { name: 'Rename', exact: true }).click()
        const editor = row(target).locator('input')
        await editor.waitFor()
        await editor.fill(`${name} ${key}`)
        t.check(
          `${name} Rename ${key} focuses the editable target`,
          await editor.evaluate((element) => element === document.activeElement)
        )
        t.equal(
          `${name} Rename ${key} exposes only the editable target`,
          JSON.stringify((await rowOrder()).filter((id) => id !== target)),
          ordinaryOrder
        )
        t.equal(`${name} Rename ${key} shows one editable row`, await row(target).count(), 1)
        t.equal(
          `${name} Rename ${key} retains its own descendant selector`,
          await row(target).locator('.subagent-trigger').count(),
          hasDescendants ? 1 : 0
        )
        if (hasDescendants)
          t.equal(`${name} Rename ${key} keeps its child folded`, await row(nested).count(), 0)
        else
          t.equal(`${name} Rename ${key} leaves its ancestor folded`, await row(child).count(), 0)
        await editor.press(key)
        if (key === 'Enter') committedName = `${name} ${key}`
        assert.ok(
          await until(
            async () =>
              (await listing()).sessions.find((session) => session.id === target)?.name ===
              committedName
          )
        )
        t.check(`${name} Rename ${key} ${key === 'Enter' ? 'commits' : 'cancels'} the edit`, true)
        t.equal(
          `${name} Rename ${key} folds the target back afterwards`,
          await row(target).count(),
          0
        )
        t.equal(
          `${name} Rename ${key} restores represented row order`,
          JSON.stringify(await rowOrder()),
          ordinaryOrder
        )
      }
      await callMcp(app, 'rename', { target: 'session', id: target, name })
      assert.ok(
        await until(
          async () =>
            (await listing()).sessions.find((session) => session.id === target)?.name === name
        )
      )
    }

    // The menu forwards child management to the existing sidebar context actions.
    await trigger().click()
    await menuItem('Explorer').click({ button: 'right' })
    await win.getByRole('menuitem', { name: 'Rename', exact: true }).click()
    const rename = row(child).locator('input')
    await rename.waitFor()
    await rename.fill('Explorer renamed')
    await rename.press('Enter')
    assert.ok(
      await until(
        async () =>
          (await listing()).sessions.find((s) => s.id === child)?.name === 'Explorer renamed'
      )
    )
    t.equal(
      'right-click rename applies to the folded child and compacts it again',
      await row(child).count(),
      0
    )
    await trigger().click()
    await menuItem('Explorer renamed').focus()
    await win.keyboard.press('Shift+F10')
    t.equal(
      'keyboard context action opens the existing child management menu',
      await win.getByRole('menuitem', { name: 'Copy session ID', exact: true }).count(),
      1
    )
    await win.getByRole('menuitem', { name: 'Rename', exact: true }).click()
    await rename.waitFor()
    await rename.fill('Explorer')
    await rename.press('Enter')
    assert.ok(
      await until(
        async () => (await listing()).sessions.find((s) => s.id === child)?.name === 'Explorer'
      )
    )
    t.equal('keyboard rename preserves the same session id', await row(child).count(), 0)

    // A child in another group compacts only while its parent is reachable.
    const group = await callMcp(app, 'createGroup', { name: 'Workers' })
    assert.ok(group?.groupId)
    await callMcp(app, 'moveSession', { sessionId: child, groupId: group.groupId })
    t.equal('cross-group child compacts under the reachable parent', await row(child).count(), 0)
    const placeholder = win.locator(`[data-sidebar-empty-group="${group.groupId}"]`)
    t.equal(
      'folded-only group explains where its sessions are shown',
      await placeholder.innerText(),
      'Subagents shown with their parent'
    )
    t.equal(
      'folded-only group retains its new-session control',
      await win.getByRole('button', { name: 'New session in Workers', exact: true }).count(),
      1
    )
    t.equal(
      'folded-only group retains its terminal controls',
      await win.getByRole('button', { name: 'Terminals of Workers', exact: true }).count(),
      1
    )

    const chip = win
      .locator('.group-switcher-chips .group-switcher-chip')
      .filter({ hasText: 'Workers' })
    await chip.click()
    await row(child).waitFor()
    t.equal('filtering out the parent restores the child row', await row(child).count(), 1)
    await win.keyboard.press('Meta+1')
    await focused(child)
    t.equal(
      'number shortcuts follow a group filter that exposes the child',
      (await listing()).focusedSessionId,
      child
    )
    t.equal(
      'unrelated grouped-row selection keeps the original styling',
      await row(child).locator('.sidebar-item').getAttribute('data-selected'),
      null
    )

    await win.locator('.group-switcher-head .group-switcher-chip').click()
    await trigger().waitFor()
    t.equal('All compacts the child again', await row(child).count(), 0)
    t.equal(
      'represented parent retains a selected marker',
      await row(parent).locator('.sidebar-item').getAttribute('data-selected'),
      'true'
    )

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

    t.equal(
      'grouped represented parent keeps its scoped selected marker',
      await row(parent).locator('.sidebar-item').getAttribute('data-selected'),
      'true'
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
    const survivingTrigger = row(child).locator('.subagent-trigger')
    t.check(
      'one descendant uses a singular subagent tooltip',
      /^1 subagent(?: ·|$)/.test(await survivingTrigger.getAttribute('title'))
    )

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
