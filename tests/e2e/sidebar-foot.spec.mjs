/**
 * The sidebar's foot and the wordmark.
 *
 * Three things here fail silently if they break, which is why they are checked
 * against the real app rather than eyeballed:
 *
 *  - The field is a CANVAS. A palette that never reaches the paint routine
 *    leaves a transparent canvas, and a transparent canvas over a dark panel
 *    looks exactly like a dark panel. Every field check reads pixels.
 *  - Sentient is loaded for TWO strings. A stylesheet that lets it leak into
 *    another rule shows up as "the app looks a bit different" and nothing else,
 *    so the leak is asserted against, not just the presence.
 *  - The lockup's two words sit on one baseline because their two SVGs share
 *    one frame and one CSS height, not because anything nudged them. A frame
 *    changed on one side and not the other reads as a wonky mark and as no
 *    failure at all, so the frame itself is what gets asserted.
 *  - The saved profile used to be a hex. A migration that silently drops it
 *    leaves the default palette, which is indistinguishable from a user who
 *    never chose one.
 */
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  until,
  userDataDir,
  fixturePath
} from './harness.mjs'
import { mkdirSync } from 'node:fs'

const DIR = userDataDir('sidebar-foot')
const ROOT = fixturePath('foot-root')
const WS = {
  id: 'ffffffff-0000-4000-8000-00000000000f',
  name: 'Foot',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}

/** Read a canvas back as a coarse signature: how many distinct colours it
 *  holds, whether any pixel is opaque at all, and a digest of the WHOLE
 *  picture (every quantised colour it holds, plus its mean). A field that
 *  failed to paint scores 0 opaque pixels; a flat fill scores 1 colour; two
 *  paints of different palettes score different digests.
 *
 *  The digest is what the repaint check compares. It used to compare one
 *  pixel, the top-left corner, and two palettes can legitimately paint that
 *  corner the same: groundLift washes the app's own surface over the gradient
 *  before the grain lands, so the corner is the ground's colour under both
 *  (PRDCT-2622: {"before":"237,242,245","after":"237,242,245"} on a real
 *  repaint). A whole-canvas digest cannot be fooled by a shared corner. */
const CANVAS_STATS = (sel) => {
  const el = document.querySelector(sel)
  if (!el) return null
  const ctx = el.getContext('2d')
  const { width: w, height: h } = el
  if (!w || !h) return { colours: 0, opaque: 0, w, h, digest: null }
  const d = ctx.getImageData(0, 0, w, h).data
  const seen = new Set()
  let opaque = 0
  let r = 0
  let g = 0
  let b = 0
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] > 8) opaque++
    seen.add((d[i] >> 3) + ',' + (d[i + 1] >> 3) + ',' + (d[i + 2] >> 3))
    r += d[i]
    g += d[i + 1]
    b += d[i + 2]
  }
  const px = d.length / 4
  // FNV-1a over the sorted colour set and the mean: a short, stable digest.
  let hash = 0x811c9dc5
  const text =
    [...seen].sort().join(';') +
    '|' +
    Math.round(r / px) +
    ',' +
    Math.round(g / px) +
    ',' +
    Math.round(b / px)
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return { colours: seen.size, opaque, w, h, digest: hash.toString(16).padStart(8, '0') }
}

export async function run(t) {
  mkdirSync(ROOT, { recursive: true })
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])

  let { app, win } = await launchApp(DIR)
  try {
    // Hand the renderer a fixed set of limit windows. Without this the second
    // line renders whichever branch the RUNNING MACHINE's own Claude session
    // happens to justify, so the headroom half — the meter, the reading, and
    // the row-shaped control they sit in — was checked on some machines and
    // silently skipped on others. Canned, both branches are reachable and the
    // geometry below is always asserted against the real thing.
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('usage:get-limits')
      ipcMain.handle('usage:get-limits', () => ({
        windows: [
          {
            key: 'weekly_all',
            label: 'Weekly limit (all models)',
            kind: 'weekly_all',
            scope: null,
            usedPercentage: 38,
            resetsAt: Date.now() + 3 * 24 * 3600 * 1000,
            severity: 'normal'
          }
        ],
        fetchedAt: Date.now()
      }))
    })

    // ── what a profile nobody has touched looks like ──
    // Read BEFORE anything is seeded, because that is the only moment the
    // defaults are what is on screen. A default that regresses is invisible to
    // every other check here: they all seed a profile first.
    await win.waitForSelector('.sidebar-panel', { timeout: 20000 })
    const fresh = await win.evaluate(() =>
      JSON.parse(localStorage.getItem('clave-user-profile') ?? '{}')
    )
    t.equal('a fresh profile flies the rocket', fresh.avatarIcon, 'rocket')
    t.equal('on the Iris field', fresh.avatarField, 'iris')

    // A profile saved by an older build: a flat hex, no palette, no seed.
    await win.evaluate(() => {
      localStorage.setItem(
        'clave-user-profile',
        JSON.stringify({ name: 'Ada Lovelace', avatarIcon: 'bolt', avatarColor: '#db8b4e' })
      )
      localStorage.setItem('clave-work-tracker-enabled', 'true')
    })
    await win.evaluate(() => window.electronAPI.skinsActivate('dark'))
    await win.evaluate(() => window.electronAPI?.feedbackSetCollapsed?.())
    await win.reload()
    await win.waitForSelector('.sidebar-panel', { timeout: 20000 })

    // ── the foot is ONE panel ──
    const shape = await win.evaluate(() => {
      const foot = document.querySelectorAll('.sidebar-panel')
      const panel = foot[foot.length - 1]
      if (!panel) return null
      const cs = getComputedStyle(panel)
      return {
        rows: panel.querySelectorAll('.sidebar-footer-row').length,
        sep: !!panel.querySelector('.sidebar-footer-sep'),
        field: !!panel.querySelector('canvas.sidebar-footer-field'),
        avatar: !!panel.querySelector('canvas:not(.sidebar-footer-field)'),
        gear: !!panel.querySelector('.sidebar-footer-btn[aria-label="Settings"]'),
        feedback: !!panel.querySelector('.sidebar-footer-btn[aria-label="Talk to us"]'),
        name: panel.querySelector('.sidebar-footer-name')?.textContent,
        border: cs.borderTopWidth,
        radius: cs.borderTopLeftRadius,
        panelRadius: (() => { const pr = document.createElement('div'); pr.style.borderRadius = 'var(--radius-xl)'; document.body.appendChild(pr); const r = getComputedStyle(pr).borderRadius; pr.remove(); return r })(),
        // Nothing may sit loose beside the panel any more.
        siblings: panel.parentElement?.children.length
      }
    })
    t.check('the foot is one panel', shape !== null, shape)
    t.equal('holding two rows', shape?.rows, 2)
    t.check('folded by a hairline', shape?.sep, shape)
    t.check('with the field bled behind it', shape?.field, shape)
    t.check('the avatar is a field of its own', shape?.avatar, shape)
    t.check('the settings gear is in it', shape?.gear, shape)
    t.check('the collapsed feedback door is in it', shape?.feedback, shape)
    t.equal('and it carries the name', shape?.name, 'Ada Lovelace')
    t.equal('it is bordered like the launcher panel', shape?.border, '1px')
    t.equal('and rounded like it', shape?.radius, shape?.panelRadius)
    t.equal('nothing else sits loose at the foot', shape?.siblings, 1)

    // ── the controls sit INSIDE the panel, and light up in the field ──
    // Two regressions that look like nothing in a diff and like a broken card
    // on screen. The second row used to be exactly one control tall inside a
    // panel with no padding, so the chat door sat ON the bottom border and ON
    // the fold above it — a rounded button with two corners eaten by the card.
    // And its hover was the app's grey, which over a coloured ground reads as
    // dirt rather than as a control waking up. Both are asserted here because
    // both render perfectly happily.
    const inset = await win.evaluate(() => {
      const foot = document.querySelectorAll('.sidebar-panel')
      const panel = foot[foot.length - 1]
      const p = panel.getBoundingClientRect()
      const controls = [
        ...panel.querySelectorAll(
          '.sidebar-footer-btn, .sidebar-footer-line, .sidebar-footer-avatar'
        )
      ]
      const gaps = controls.map((el) => {
        const r = el.getBoundingClientRect()
        return Math.round(
          Math.min(r.left - p.left, p.right - r.right, r.top - p.top, p.bottom - r.bottom)
        )
      })
      const meta = panel.querySelector('.sidebar-footer-row--meta')
      const door = panel.querySelector('.sidebar-footer-btn[aria-label="Talk to us"]')
      const line = panel.querySelector('.sidebar-footer-line')
      return {
        count: controls.length,
        worst: Math.min(...gaps),
        metaH: meta ? Math.round(meta.getBoundingClientRect().height) : 0,
        doorH: door ? Math.round(door.getBoundingClientRect().height) : 0,
        lineH: line ? Math.round(line.getBoundingClientRect().height) : 0,
        accent: getComputedStyle(panel).getPropertyValue('--field-accent').trim()
      }
    })
    t.equal('the foot holds all four of its controls', inset.count, 4)
    t.check('none of them touches the panel it sits in', inset.worst >= 4, inset)
    t.check('because the second row is taller than its button', inset.metaH > inset.doorH, inset)
    // The readout is a row, not a square, so it is the one that can quietly go
    // back to filling its row edge to edge and running into the fold above it.
    t.equal('and the readout is the same height as the door beside it', inset.lineH, inset.doorH)
    // The legacy hex seeded above is Furnace's; its signature hue is the amber.
    t.equal('the panel carries the field own accent', inset.accent, '#E89B4F')

    // The hover fill has to BE that accent. Reading the computed background is
    // the only way to tell a field tint from the app's grey: both are a fill.
    const RGB = (css) => {
      const n = (css.match(/[\d.]+/g) ?? []).map(Number)
      if (n.length < 3) return null
      const scale = css.startsWith('color(') ? 255 : 1
      return [Math.round(n[0] * scale), Math.round(n[1] * scale), Math.round(n[2] * scale)]
    }
    await win.locator('.sidebar-footer-btn[aria-label="Settings"]').hover()
    await win.waitForTimeout(250)
    const hovered = await win.evaluate(() => {
      const foot = document.querySelectorAll('.sidebar-panel')
      const panel = foot[foot.length - 1]
      return {
        bg: getComputedStyle(panel.querySelector('.sidebar-footer-btn[aria-label="Settings"]'))
          .backgroundColor,
        grey: getComputedStyle(panel).getPropertyValue('--surface-100').trim()
      }
    })
    const tint = RGB(hovered.bg)
    t.check('hovering the gear fills it', tint !== null, hovered)
    t.check(
      'in the field own amber, not the app grey',
      String(tint) === String([232, 155, 79]),
      hovered
    )
    t.check('and translucently, so the field stays under it', /0\.3/.test(hovered.bg), hovered.bg)

    // ── the field actually paints ──
    const avatar = await win.evaluate(
      CANVAS_STATS,
      '.sidebar-panel canvas:not(.sidebar-footer-field)'
    )
    t.check('the avatar canvas is opaque', (avatar?.opaque ?? 0) > 0, avatar)
    t.check('and carries a field, not a flat fill', (avatar?.colours ?? 0) > 12, avatar)

    const bleed = await win.evaluate(CANVAS_STATS, 'canvas.sidebar-footer-field')
    t.check('the panel ground paints too', (bleed?.colours ?? 0) > 12, bleed)

    // ── the ground is grained, not faded ──
    // The failure this catches: quietening the field with CSS opacity instead
    // of the veil. That fades the grain with it, and the panel goes from
    // weather to a grey wash — which still passes every check above.
    const ground = await win.evaluate(() => {
      const el = document.querySelector('canvas.sidebar-footer-field')
      const cs = getComputedStyle(el)
      const ctx = el.getContext('2d')
      const { width: w, height: h } = el
      const d = ctx.getImageData(0, 0, w, h).data
      let sum = 0
      let sq = 0
      const n = d.length / 4
      for (let i = 0; i < d.length; i += 4) {
        const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]
        sum += l
        sq += l * l
      }
      const mean = sum / n
      return {
        opacity: cs.opacity,
        mask: cs.maskImage,
        mean,
        // Per-pixel spread IS the grain: a smooth gradient of this size has
        // almost none, and film has plenty.
        sd: Math.sqrt(Math.max(0, sq / n - mean * mean))
      }
    })
    t.equal('the ground canvas is never faded', ground.opacity, '1')
    t.check('nor masked', ground.mask === 'none', ground.mask)
    t.check('the grain is actually in the pixels', ground.sd > 6, ground)
    t.check('and the ground stays dark under the names', ground.mean < 70, ground)

    // ── the second line: headroom, or nothing worth saying ──
    /** What the foot claims is LEFT, carried down to the pane cross-check. */
    let footLeft = null
    // The store fetches over the network at boot, so the meter arrives a beat
    // after the panel does. Without this wait the spec always read the
    // pre-fetch state and the headroom branch below was never once exercised —
    // it passed, on the fallback, on a machine that had the data all along.
    await win.waitForSelector('.usage-meter', { timeout: 15000 }).catch(() => null)

    const meta = await win.evaluate(() => {
      const rows = document.querySelectorAll('.sidebar-footer-row--meta')
      const row = rows[rows.length - 1]
      if (!row) return null
      const fill = row.querySelector('.usage-meter-fill')
      return {
        text: row.textContent,
        meter: !!row.querySelector('.usage-meter'),
        fillWidth: fill ? fill.style.width : null,
        clock: !!row.querySelector('svg')
      }
    })
    t.check('the foot has a second line', meta !== null, meta)
    // Which branch renders depends on the machine's own Claude session, so the
    // check is on the shape of whichever one did — never on a number, and never
    // on the meaningless zero the old line showed.
    if (meta?.meter) {
      t.check(
        'it reads headroom, as a percentage LEFT',
        /\d+% left/.test(meta.text ?? ''),
        meta.text
      )
      // textContent has no CSS gaps in it, so the separator may sit flush.
      t.check('and names which cap that is', /% left\s*·\s*\S/.test(meta.text ?? ''), meta.text)
      t.check(
        'the meter drains rather than fills',
        /^\d+(\.\d+)?%$/.test(meta.fillWidth ?? ''),
        meta.fillWidth
      )
      const pct = Number((meta.text ?? '').match(/(\d+)% left/)?.[1])
      const width = Number((meta.fillWidth ?? '').replace('%', ''))
      t.check('and agrees with the number beside it', Math.abs(pct - width) <= 3 || width === 3, {
        pct,
        width
      })
      footLeft = pct
    } else {
      t.check(
        'with no limits to show, it never says 0m · 0 sessions',
        !/0m/.test(meta?.text ?? ''),
        meta?.text
      )
    }

    // ── the legacy hex migrated ──
    const migrated = await win.evaluate(() =>
      JSON.parse(localStorage.getItem('clave-user-profile') ?? '{}')
    )
    t.equal('a saved hex resolves to its palette', migrated.avatarField, 'furnace')
    t.check('and the draw is seeded', typeof migrated.avatarSeed === 'number', migrated)

    // ── the wordmark ──
    // Two words, two SVGs, ONE frame. They land on one baseline because their
    // viewBoxes are the same depth and CSS gives them the same height — not
    // because a stylesheet nudged one of them — so the frame is the thing worth
    // asserting: change it on one side only and the lockup goes wonky while
    // every other number here still looks right.
    const wm = await win.evaluate(() => {
      const read = (el) => {
        if (!el) return null
        const r = el.getBoundingClientRect()
        const vb = (el.getAttribute('viewBox') ?? '0 0 0 0').split(' ').map(Number)
        const path = el.querySelector('path')
        return {
          tag: el.tagName.toLowerCase(),
          label: el.getAttribute('aria-label'),
          hidden: el.getAttribute('aria-hidden'),
          d: path?.getAttribute('d')?.length ?? 0,
          ink: path?.getBBox().height ?? 0,
          vbW: vb[2],
          vbH: vb[3],
          x: r.x,
          top: r.top,
          h: r.height,
          w: r.width
        }
      }
      const wrap = document.querySelector('.wordmark-by')
      const link = document.querySelector('.wordmark-link')
      const svgs = [...document.querySelectorAll('.wordmark')]
      const wr = wrap?.getBoundingClientRect()
      const ls = link ? getComputedStyle(link) : null
      return {
        clave: read(svgs[0]),
        by: read(svgs[1]),
        name: read(link?.querySelector('svg')),
        wrap: wr && { top: wr.top, h: wr.height },
        link: link && {
          tag: link.tagName.toLowerCase(),
          label: link.getAttribute('aria-label'),
          title: link.getAttribute('title'),
          // The two opt-outs a click depends on: the strip is a window drag
          // region under a pointer-events: none mark.
          pointerEvents: ls.pointerEvents,
          appRegion: ls.webkitAppRegion ?? ls.getPropertyValue('-webkit-app-region'),
          cursor: ls.cursor
        }
      }
    })
    t.equal('the wordmark is labelled Clave', wm.clave?.label, 'Clave')
    t.equal('and the attribution stands beside it', wm.by?.label, 'by')
    t.equal('with the house’s name after it', wm.link?.label, 'Antasphere')
    // The button is what carries the name; the drawing inside it is hidden, or
    // a screen reader says "Antasphere Antasphere".
    t.equal('announced once, not twice', wm.name?.hidden, 'true')
    // Outlines, not type. The face is Fontshare's and may not be redistributed
    // as a file, so a packaged build must not contain one — see Wordmark.tsx.
    t.equal('drawn as an SVG, not set in a face', wm.clave?.tag, 'svg')
    t.equal('and so is the attribution', wm.name?.tag, 'svg')
    t.check(
      'with real outline data in both',
      (wm.clave?.d ?? 0) > 500 && (wm.name?.d ?? 0) > 500,
      wm
    )
    t.check('and clear of the traffic lights', (wm.clave?.x ?? 0) >= 80, wm.clave)
    // --wordmark-h names Clave's INK height; the box around it is taller by the
    // descender room the attribution needs. Read the ink back through the
    // viewBox, or a change to the frame reads as a change of size.
    const inkPx = ((wm.clave?.ink ?? 0) / (wm.clave?.vbH ?? 1)) * (wm.clave?.h ?? 0)
    t.check('Clave renders at the size it is set at', Math.abs(inkPx - 14) < 0.6, {
      inkPx,
      ...wm.clave
    })
    t.check(
      'keeping the outline ratio',
      Math.abs(
        (wm.clave?.w ?? 0) / (wm.clave?.h ?? 1) - (wm.clave?.vbW ?? 0) / (wm.clave?.vbH ?? 1)
      ) < 0.02,
      wm.clave
    )
    // The lockup's alignment, as the two facts that make it true. All three
    // boxes, because the attribution is two of them now and either can drift.
    t.check(
      'all three words are drawn in one frame',
      wm.by?.vbH === wm.clave?.vbH && wm.name?.vbH === wm.clave?.vbH,
      { clave: wm.clave?.vbH, by: wm.by?.vbH, name: wm.name?.vbH }
    )
    t.check(
      'and rendered at one box height and one top, so one baseline',
      [wm.by, wm.name, wm.wrap].every(
        (b) =>
          b &&
          Math.abs(b.h - (wm.clave?.h ?? -1)) < 0.5 &&
          Math.abs(b.top - (wm.clave?.top ?? -1)) < 0.5
      ),
      wm
    )
    // A whisper under the name, not a second name: the attribution is drawn at
    // a fraction of the primary's size, which its ink box carries.
    t.check(
      'the attribution is drawn smaller than the name',
      (wm.name?.ink ?? 0) < (wm.clave?.ink ?? 0),
      { name: wm.name?.ink, clave: wm.clave?.ink }
    )
    // The word space, which is a GAP rather than ink now that the two words are
    // two boxes: lose it and the phrase reads "byAntasphere".
    t.check(
      'the two words are held apart by the phrase’s own space',
      (wm.name?.x ?? 0) - ((wm.by?.x ?? 0) + (wm.by?.w ?? 0)) > 1.5,
      { byRight: (wm.by?.x ?? 0) + (wm.by?.w ?? 0), nameLeft: wm.name?.x }
    )

    // ── the house's name is the way out to the house ──────────────────────
    // The click has to survive two things that exist to stop clicks: the strip
    // is a window drag region, and the mark over it takes no pointer events.
    // Both opt-outs are read back, because a synthetic click would pass without
    // the app-region one and a real one would drag the window instead.
    t.equal('the name is a button', wm.link?.tag, 'button')
    t.equal('labelled with the house', wm.link?.label, 'Antasphere')
    t.equal('it takes pointer events back', wm.link?.pointerEvents, 'auto')
    t.equal('and opts out of the window drag region', wm.link?.appRegion, 'no-drag')
    t.equal('and says so with the cursor', wm.link?.cursor, 'pointer')
    // Spied in MAIN, on the sink the click actually ends at: the renderer's
    // electronAPI comes over contextBridge and cannot be stubbed, and spying
    // here covers the whole chain — preload, IPC, and the handler's protocol
    // allowlist, which would silently swallow a URL it did not like.
    await app.evaluate(({ shell }) => {
      globalThis.__opened = []
      globalThis.__realOpen = shell.openExternal
      shell.openExternal = (url) => {
        globalThis.__opened.push(url)
        return Promise.resolve()
      }
    })
    // A real mouse click, not a synthetic .click(): that is what exercises the
    // hit test, which is the half `pointer-events: auto` has to win. Caught, so
    // an unhittable link is a named failure rather than a spec that dies on a
    // timeout with the rest of its checks unrun.
    let clickError = null
    try {
      await win.click('.wordmark-link', { timeout: 5000 })
    } catch (err) {
      clickError = String(err).slice(0, 140)
    }
    t.check('the name is clickable where it is drawn', clickError === null, clickError)
    await new Promise((r) => setTimeout(r, 400))
    const opened = await app.evaluate(({ shell }) => {
      shell.openExternal = globalThis.__realOpen
      return globalThis.__opened
    })
    t.equal('clicking it opens exactly one page', opened.length, 1)
    // The whole point of the link for the house: the visit is attributed.
    const url = opened[0] ? new URL(opened[0]) : null
    t.check(
      'and that page is antasphere.com',
      url !== null && /(^|\.)antasphere\.com$/.test(url.hostname),
      opened
    )
    t.equal('named as coming from the app', url?.searchParams.get('utm_source'), 'clave-app')

    // ── and no font file came with it ──
    // The failure this catches: someone reintroducing a Sentient @font-face to
    // make the mark editable. It would look identical and would put an
    // unredistributable file back in the asar.
    const faces = await win.evaluate(() => {
      const named = []
      document.fonts.forEach((f) => named.push(f.family))
      return {
        registered: named,
        // Anything on the page resolving to a face that is not the app's own.
        leaks: Array.from(document.querySelectorAll('body *'))
          .map((el) => getComputedStyle(el).fontFamily)
          .filter((f) => /sentient/i.test(f))
      }
    })
    t.equal(
      'no Sentient face is registered',
      faces.registered.filter((f) => /sentient/i.test(f)).length,
      0
    )
    t.equal('and nothing on the page asks for one', faces.leaks.length, 0)

    // ── choosing a field repaints it ──
    await win.click('.sidebar-footer-btn[aria-label="Settings"]')
    await win.waitForSelector('.settings-row', { timeout: 10000 })
    const swatches = await win.evaluate(
      () => document.querySelectorAll('.settings-row canvas').length
    )
    t.check('the picker offers a painted swatch per palette', swatches >= 12, swatches)

    // ── the mark comes with you into Settings ──────────────────────────────
    // Settings replaces the sessions sidebar whole. It used to open with a bare
    // drag spacer, so the app's one mark vanished the moment you stepped in and
    // the panel under it sat 2px out of step with the list it replaced. Same
    // strip, same clearance, same offset — asserted here rather than eyeballed
    // because a missing mark looks exactly like a slightly emptier sidebar.
    const settingsStrip = await win.evaluate(() => {
      const strip = document.querySelector('[data-wordmark-strip]')
      if (!strip) return null
      const nav = document.querySelector('.settings-row')
      return {
        pad: getComputedStyle(strip).paddingLeft,
        h: Math.round(strip.getBoundingClientRect().height),
        by: !!strip.querySelector('.wordmark-by'),
        link: !!strip.querySelector('.wordmark-link'),
        drag: getComputedStyle(strip).webkitAppRegion,
        hasNav: !!nav,
        // The band is a token (--content-top-offset, derived from the frame
        // spec), so the check reads it rather than pinning a number.
        band: (() => { const pr = document.createElement('div'); pr.style.height = 'var(--content-top-offset)'; document.body.appendChild(pr); const h = Math.round(pr.getBoundingClientRect().height); pr.remove(); return h })()
      }
    })
    t.check('the mark is still there in Settings', !!settingsStrip, settingsStrip)
    t.equal('at the same clearance', settingsStrip?.pad, '90px')
    t.equal('in the same band as the toolbar', settingsStrip?.h, settingsStrip?.band)
    t.check(
      'with the attribution and its link',
      !!settingsStrip?.by && !!settingsStrip?.link,
      settingsStrip
    )
    t.equal('and the band still drags the window', settingsStrip?.drag, 'drag')

    // The settings view replaces the sidebar, so the foot panel is out of the
    // DOM while the picker is open: the repaint is read on the profile card's
    // own avatar, which is the same component on the same store.
    //
    // Three ways this check used to be wrong, each fixed here (PRDCT-2622):
    // a fixed 600 ms sleep (the field skips its paint while the canvas has no
    // layout and repaints on the next resize, which can land after the sleep),
    // one corner pixel (see CANVAS_STATS), and a missing or unsized canvas
    // read as "no repaint" instead of as its own failure. Now: the canvas
    // must be painted BEFORE the pick, the repaint is polled for up to five
    // seconds, and the whole picture is what must change.
    //
    // And a fourth: '.settings-card canvas' matched the FIRST canvas in the
    // card, which is the picker's first swatch (Glacier, in a .avatar-cell
    // inside its button), not the avatar. The avatar is the one canvas in the
    // card that sits in no swatch cell, so that is what is read; the count is
    // asserted so a second such canvas cannot silently take its place.
    const AVATAR = '.settings-card :not(.avatar-cell) > canvas'
    t.equal(
      'the card has exactly one avatar canvas outside the swatches',
      await win.evaluate((sel) => document.querySelectorAll(sel).length, AVATAR),
      1
    )
    const painted = (s) => !!s && s.w > 1 && s.h > 1 && s.opaque > 0 && !!s.digest
    // The card's avatar mounts with the settings view and paints on its first
    // layout, not on mount: read too early, it is a 300×150 default canvas with
    // no opaque pixel, and the old check passed on exactly that (its "before"
    // was the unpainted canvas, so any paint at all counted as a repaint).
    const before = await until(
      async () => {
        const now = await win.evaluate(CANVAS_STATS, AVATAR)
        return painted(now) ? now : null
      },
      { tries: 20, gapMs: 250 }
    )
    t.check(
      'the avatar is painted before a palette is picked',
      before !== null,
      before ?? (await win.evaluate(CANVAS_STATS, AVATAR))
    )
    await win.click('button[title="Aurora"]')
    const after = await until(
      async () => {
        const now = await win.evaluate(CANVAS_STATS, AVATAR)
        return painted(now) && now.digest !== before?.digest ? now : null
      },
      { tries: 20, gapMs: 250 }
    )
    t.check('picking a palette repaints the avatar', before !== null && after !== null, {
      before,
      // On failure, what the canvas held when the deadline passed.
      after: after ?? (await win.evaluate(CANVAS_STATS, AVATAR))
    })
    t.equal(
      'and the choice is saved',
      (await win.evaluate(() => JSON.parse(localStorage.getItem('clave-user-profile') ?? '{}')))
        .avatarField,
      'aurora'
    )

    const seedBefore = await win.evaluate(
      () => JSON.parse(localStorage.getItem('clave-user-profile') ?? '{}').avatarSeed
    )
    await win.click('button[title="Draw the field again"]')
    // Polled, not slept: the same fixed-wait class as the repaint above.
    const seedAfter = await until(
      async () => {
        const seed = await win.evaluate(
          () => JSON.parse(localStorage.getItem('clave-user-profile') ?? '{}').avatarSeed
        )
        return seed !== seedBefore ? seed : null
      },
      { tries: 20, gapMs: 250 }
    )
    t.check('redrawing draws a different field', seedAfter !== null && seedBefore !== seedAfter, {
      seedBefore,
      seedAfter
    })
    // ── the foot and the pane are the same number ──
    // The one check that catches the foot showing percent USED under a "left"
    // label: the pane renders percent USED for every window, so the tightest
    // bar there and the foot's headroom must sum to 100. Without this the two
    // readouts can disagree by exactly the mistake that matters.
    if (footLeft !== null) {
      await win.evaluate(() => {
        const nav = Array.from(document.querySelectorAll('button, a'))
        nav.find((el) => el.textContent?.trim() === 'Usage')?.click()
      })
      await win
        .waitForSelector('.settings-card .rounded-full', { timeout: 15000 })
        .catch(() => null)
      const paneMax = await win.evaluate(() => {
        const bars = Array.from(document.querySelectorAll('.settings-card .space-y-1\\.5'))
        const pcts = bars
          .map((b) => Number(b.textContent?.match(/(\d+)%/)?.[1]))
          .filter((n) => Number.isFinite(n))
        return pcts.length ? Math.max(...pcts) : null
      })
      t.check(
        'the pane and the foot describe the same ceiling',
        paneMax !== null && Math.abs(100 - paneMax - footLeft) <= 1,
        { footLeft, paneMax }
      )
    }
    // ── the chrome keeps clear of the traffic lights, and only of them ────
    // In fullscreen macOS takes the traffic lights away, so clearance held for
    // them becomes a hole. Two pieces of chrome hold it: the wordmark's strip,
    // and — with the sidebar closed, when the toolbar is what runs under the
    // buttons — the toolbar's own row. (The other way for the buttons to be
    // absent is a Windows or Linux window, which keeps a native frame; this
    // suite only ever runs on macOS, so the platform half of the condition is
    // read here at its darwin value and the drop is proved through fullscreen.)
    // Driven through REAL fullscreen —
    // setFullScreen on the window, the main-process event, the renderer's
    // listener — rather than by poking the renderer's state, because every link
    // in that chain is new and any of them can be the one that breaks.
    //
    // Reloaded first: the settings view above is still showing, and these
    // checks want the strip in its own sidebar — same component either way, but
    // the fullscreen drive below reads better against the front page.
    await win.reload()
    await win.waitForSelector('[data-wordmark-strip]', { timeout: 20000 })
    const stripPad = () =>
      win.evaluate(() => {
        const strip = document.querySelector('[data-wordmark-strip]')
        return {
          pad: getComputedStyle(strip).paddingLeft,
          flag: strip.getAttribute('data-traffic-lights'),
          markX: document.querySelector('.wordmark:not(.wordmark-by)')?.getBoundingClientRect().x
        }
      })
    // The toolbar's clearance is only there with the sidebar closed, so each
    // reading closes it, measures, and puts it back.
    const toolbarPad = async () => {
      await win.click('button[title="Hide sidebar"]')
      await new Promise((r) => setTimeout(r, 500))
      const out = await win.evaluate(() => {
        const row = document.querySelector('[data-toolbar-row]')
        const btn = row?.querySelector('button')
        return {
          pad: getComputedStyle(row).paddingLeft,
          btnX: btn?.getBoundingClientRect().x
        }
      })
      await win.click('button[title="Show sidebar"]')
      await new Promise((r) => setTimeout(r, 500))
      return out
    }
    const wired = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      return {
        enter: w.listenerCount('enter-full-screen'),
        leave: w.listenerCount('leave-full-screen')
      }
    })
    t.check(
      'main listens for both edges of fullscreen',
      wired.enter >= 1 && wired.leave >= 1,
      wired
    )

    const windowed = await stripPad()
    t.equal('windowed, the mark clears the traffic lights', windowed.pad, '90px')
    t.equal('and says so', windowed.flag, 'true')
    const windowedToolbar = await toolbarPad()
    t.equal('and with the sidebar closed the toolbar clears them too', windowedToolbar.pad, '76px')

    // Drive the real thing when the window manager allows it, and fall back to
    // main's own event when it does not. `--test-no-activate` never shows the
    // window, and macOS will not put an off-screen window into fullscreen —
    // setFullScreen is simply a no-op, isFullScreen stays false however long
    // you wait. That is a fact about the test window, not about the chrome, and
    // a fixed sleep turned it into six failures claiming the mark never moved.
    // The fallback pushes the exact message main sends from 'enter-full-screen'
    // (src/main/index.ts), so every assertion below still runs and still fails
    // if the renderer's half of the chain is broken.
    // Once the window manager has declined, it declines both directions — so
    // the fallback has to stay on for the rest of the block, or leaving
    // fullscreen would find the OS already reporting `false` and push nothing,
    // leaving the chrome stuck at the fullscreen value it was handed.
    let simulating = false
    const setFullScreen = async (value) => {
      if (!simulating) {
        await app.evaluate(
          ({ BrowserWindow }, v) => BrowserWindow.getAllWindows()[0].setFullScreen(v),
          value
        )
        const granted = await until(
          async () =>
            (await app.evaluate(({ BrowserWindow }) =>
              BrowserWindow.getAllWindows()[0].isFullScreen()
            )) === value || null,
          { tries: 12, gapMs: 250 }
        )
        if (granted) {
          await new Promise((r) => setTimeout(r, 600))
          return
        }
        simulating = true
        console.log(
          "        (window manager declined fullscreen for the hidden test window — driving main's own event instead)"
        )
      }
      await app.evaluate(
        ({ BrowserWindow }, v) =>
          BrowserWindow.getAllWindows()[0].webContents.send('window:fullscreen-changed', v),
        value
      )
      await new Promise((r) => setTimeout(r, 600))
    }

    await setFullScreen(true)
    const full = await stripPad()
    t.equal('fullscreen, it takes the first light’s own place', full.pad, '16px')
    t.equal('and says the lights are gone', full.flag, 'false')
    t.check('and the mark actually moved with it', (full.markX ?? 99) < (windowed.markX ?? 0), {
      windowed: windowed.markX,
      full: full.markX
    })
    const fullToolbar = await toolbarPad()
    t.check(
      'the toolbar drops its clearance too, rather than holding a hole',
      parseFloat(fullToolbar.pad) < 8,
      { windowed: windowedToolbar.pad, full: fullToolbar.pad }
    )
    t.check(
      'so the sidebar button goes to the edge with it',
      (fullToolbar.btnX ?? 999) < (windowedToolbar.btnX ?? 0) - 40,
      { windowed: windowedToolbar.btnX, full: fullToolbar.btnX }
    )

    // A window can be RESTORED into fullscreen, and the event only fires on a
    // change — so the mount-time question has to be asked too. A reload is that
    // moment: same fullscreen window, a renderer that saw no event.
    await win.reload()
    await win.waitForSelector('[data-wordmark-strip]', { timeout: 20000 })
    await new Promise((r) => setTimeout(r, 500))
    // A really-fullscreen window answers its own mount-time question; a
    // simulated one has nothing to answer with, so ask it again the same way.
    if (simulating) {
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].webContents.send('window:fullscreen-changed', true)
      )
      await new Promise((r) => setTimeout(r, 500))
    }
    t.equal('a renderer that missed the event still asks', (await stripPad()).pad, '16px')

    await setFullScreen(false)
    t.equal('and leaving fullscreen gives the clearance back', (await stripPad()).pad, '90px')

    // ── narrow enough and the attribution steps aside ─────────────────────
    // The lockup needs about 130px. The sidebar goes down to 180, and 180 minus
    // the traffic-light clearance is 90 — so at the narrow end the second word
    // would be clipped mid-letter, which is worse than not being there.
    const byShown = () =>
      win.evaluate(() => ({
        strip: Math.round(
          document.querySelector('[data-wordmark-strip]').getBoundingClientRect().width
        ),
        by: getComputedStyle(document.querySelector('.wordmark-by')).display
      }))
    t.check(
      'at the default width the attribution shows',
      (await byShown()).by !== 'none',
      await byShown()
    )
    const drag = async (toX) => {
      const box = await win.locator('.cursor-col-resize').first().boundingBox()
      await win.mouse.move(box.x + box.width / 2, box.y + 200)
      await win.mouse.down()
      await win.mouse.move(toX, box.y + 200, { steps: 10 })
      await win.mouse.up()
      await new Promise((r) => setTimeout(r, 400))
    }
    await drag(185)
    const narrow = await byShown()
    t.check('dragged narrow, it steps aside rather than clipping', narrow.by === 'none', narrow)
    await drag(300)
    const wide = await byShown()
    t.check('and comes back when there is room again', wide.by !== 'none', wide)
  } finally {
    await app.close()
  }
}
