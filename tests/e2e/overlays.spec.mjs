// The overlay language: menus, popovers, and modals share one surface
// (`.menu-surface` / `.modal-card`), one scrim (`.modal-scrim`), and working
// enter/exit animations.
//
// What this spec is really guarding is that the overlays ANIMATE at all. The
// old primitives carried tailwindcss-animate classes (animate-in, fade-in-0,
// zoom-in-95…) from a plugin that was never installed — every CSS-mode menu,
// tooltip, and popover teleported in, and nothing failed. These assertions
// read the computed animation off the live surfaces, so removing a keyframe or
// re-introducing the dead classes goes red instead of silently shipping.
import { launchApp, seedWorkspaces, userDataDir, fixturePath } from './harness.mjs'

export async function run(t) {
  const dir = userDataDir('overlays')
  seedWorkspaces(dir, {
    fresh: true,
    workspaces: [
      { id: 'ws-a', name: 'Alpha', rootDir: fixturePath('overlays-ws'), profileFile: null, createdAt: 1 },
      { id: 'ws-b', name: 'Beta', rootDir: fixturePath('overlays-ws2'), profileFile: null, createdAt: 2 }
    ],
    activeWorkspaceId: 'ws-a'
  })
  const { app, win } = await launchApp(dir)

  try {
    // --- The workspace switcher popover, in the panel language ---
    await win.click('[aria-label="Switch workspace"]')
    await win.waitForTimeout(350)
    const pop = await win.evaluate(() => {
      const el = document.querySelector('.menu-surface')
      if (!el) return null
      const item = el.querySelector('.menu-item')
      return {
        radius: getComputedStyle(el).borderRadius,
        // The panel radius is a token (derived from the control spec), so the
        // check reads it rather than pinning a number.
        panelRadius: (() => { const pr = document.createElement('div'); pr.style.borderRadius = 'var(--radius-xl)'; document.body.appendChild(pr); const r = getComputedStyle(pr).borderRadius; pr.remove(); return r })(),
        hasLabel: !!el.querySelector('.menu-label'),
        hasSep: !!el.querySelector('.menu-sep'),
        itemRadius: item ? getComputedStyle(item).borderRadius : null,
        items: el.querySelectorAll('.menu-item').length
      }
    })
    t.check('the workspace popover is a menu-surface', !!pop)
    t.equal('the surface carries the panel radius', pop?.radius, pop?.panelRadius)
    t.check('a regular-case menu-label heads it', !!pop?.hasLabel)
    t.check('sections split on an inset separator', !!pop?.hasSep)
    t.equal('rows are rounded menu-items, not full-bleed strips', pop?.itemRadius, '6px')
    t.check('both workspaces and both actions are rows', (pop?.items ?? 0) >= 4, pop?.items)

    // The popover's ground is the panels' own: the token the toolbar, the
    // terminal cards and the sidebar's boxes are painted with, resolved through
    // a probe so the check holds in every theme. A surface one shade off — the
    // old --surface-100, which is the rows' hover fill — goes red here.
    const ground = await win.evaluate(() => {
      const probe = document.createElement('div')
      probe.style.backgroundColor = 'var(--surface-0)'
      document.body.appendChild(probe)
      const bg = getComputedStyle(probe).backgroundColor
      probe.remove()
      const el = document.querySelector('.menu-surface')
      return el ? { ground: bg, surface: getComputedStyle(el).backgroundColor } : null
    })
    t.check('the surface resolved to a painted colour', !!ground && ground.ground !== 'rgba(0, 0, 0, 0)', ground)
    t.equal("the surface is painted with the panels' ground (--surface-0)", ground?.surface, ground?.ground)

    await win.keyboard.press('Escape')
    await win.waitForTimeout(500)
    t.check(
      'Escape closes it (exit animation completes, node unmounts)',
      await win.evaluate(() => !document.querySelector('.menu-surface'))
    )

    // --- The launcher's agent menu rides the same language ---
    await win.click('[aria-label="Start with another agent setup"]')
    await win.waitForTimeout(350)
    const dd = await win.evaluate(() => {
      const el = document.querySelector('.menu-surface')
      return el ? el.querySelectorAll('.menu-item').length : 0
    })
    t.check('the agent menu lists menu-item rows', dd >= 5, dd)
    await win.keyboard.press('Escape')
    await win.waitForTimeout(400)

    // --- The dead plugin classes must never come back ---
    const dead = await win.evaluate(
      () => document.querySelectorAll('[class*="animate-in"], [class*="zoom-in-95"]').length
    )
    t.equal('no tailwindcss-animate classes render anywhere', dead, 0)

    // --- The dialog path: one scrim, one card, a real entrance ---
    // The banner renders expanded ("Talk to us") on a fresh profile and as a
    // one-line pill ("Give us feedback") once collapsed — accept either door.
    let feedback = win.locator('text=Talk to us').first()
    if ((await feedback.count()) === 0) feedback = win.locator('text=Give us feedback').first()
    t.check('the feedback banner is present to open a dialog with', (await feedback.count()) > 0)
    if (await feedback.count()) {
      await feedback.click()
      await win.waitForTimeout(400)
      const dlg = await win.evaluate(() => {
        const card = document.querySelector('.modal-card')
        const scrim = document.querySelector('.modal-scrim')
        if (!card || !scrim) return null
        return {
          scrimBg: getComputedStyle(scrim).backgroundColor,
          cardAnim: getComputedStyle(card).animationName
        }
      })
      t.check('the dialog mounts a modal-card over a modal-scrim', !!dlg)
      t.check(
        'the scrim is the shared token, not the white haze',
        !!dlg && !dlg.scrimBg.startsWith('rgba(255, 255, 255'),
        dlg?.scrimBg
      )
      t.equal('the card animates in', dlg?.cardAnim, 'overlay-in')
      await win.keyboard.press('Escape')
      await win.waitForTimeout(400)
    }

    // --- The group picker: same scrim, an entrance of its own ---
    await win.click('[aria-label="Add a group"]')
    await win.waitForTimeout(400)
    const gp = await win.evaluate(() => {
      const bd = document.querySelector('.group-picker-backdrop')
      const panel = document.querySelector('.group-picker-panel')
      if (!bd || !panel) return null
      const probe = document.createElement('div')
      probe.style.backgroundColor = 'var(--surface-0)'
      document.body.appendChild(probe)
      const ground = getComputedStyle(probe).backgroundColor
      probe.remove()
      return {
        bdAnim: getComputedStyle(bd).animationName,
        panelAnim: getComputedStyle(panel).animationName,
        radius: getComputedStyle(panel).borderRadius,
        panelRadius: (() => { const pr = document.createElement('div'); pr.style.borderRadius = 'var(--radius-xl)'; document.body.appendChild(pr); const r = getComputedStyle(pr).borderRadius; pr.remove(); return r })(),
        bg: getComputedStyle(panel).backgroundColor,
        ground
      }
    })
    t.check('the group picker opens', !!gp)
    t.equal('its backdrop fades in on the shared keyframe', gp?.bdAnim, 'scrim-in')
    t.equal('its panel enters via surface-in', gp?.panelAnim, 'surface-in')
    t.equal('its panel carries the panel radius, like every other surface', gp?.radius, gp?.panelRadius)
    t.equal("its panel is painted with the panels' ground", gp?.bg, gp?.ground)
    await win.keyboard.press('Escape')
    await win.waitForTimeout(200)

    // --- Press feedback is wired into the button family ---
    const press = await win.evaluate(() => {
      const btn = document.querySelector('.launcher-btn')
      return btn ? getComputedStyle(btn).transition : null
    })
    t.check('the launcher button transitions scale for press feedback', !!press && press.includes('scale'), press)
  } finally {
    await app.close()
  }
}
