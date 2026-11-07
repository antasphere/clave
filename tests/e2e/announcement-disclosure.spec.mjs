/**
 * The two announcement cards in the sidebar, and the changelog each of them
 * reaches — folded into the what's-new card, and beside the update card.
 *
 * Both cards were failing the same user in opposite directions. The what's-new
 * card printed the whole release note — several paragraphs — at a user who had
 * not asked for it. The update card asked for a 220 MB download and a restart
 * while naming nothing but a version number, because the note for a version
 * ships INSIDE that version's binary: `help/whats-new.json` is stamped at build
 * time, so the running app has no local note for the update on offer. The
 * GitHub release bodies that arrive on `update-available` are the only
 * changelog it can have before installing.
 *
 * What is asserted here, and why each one is measured rather than read off a
 * class name:
 *
 *  1. Both cards are COLLAPSED at rest. Asserted on the rendered geometry of
 *     the note — a card that mounts open is the unbounded card again with a
 *     chevron on it, and `defaultOpen={false}` in the source proves nothing
 *     about what mounted.
 *  2. The disclosure actually opens, and what appears is the release text.
 *     Asserted on the note's own words, not on the element existing: an
 *     expanded box containing nothing is exactly the failure mode being
 *     guarded against.
 *  3. The open note is CAPPED and SCROLLS. This is the bug
 *     `sidebar-whats-new.spec.mjs` was written for, and expanding is precisely
 *     where it comes back: these cards live in the sidebar's `flex-shrink-0`
 *     announcements block, so an unbounded one pushes the session list and the
 *     foot panel off the bottom of the window with nothing to scroll. Asserted
 *     on a real scroll and on the card staying inside the viewport.
 *  4. The update card's notes are NOT folded into it. They are reference
 *     material beside a decision — opening them must not grow the card that
 *     holds Later and Update — so they hang off a badge on the update icon and
 *     open in a panel next to it, on hover and pinned by a click. Asserted on
 *     the card's height staying put with the panel open.
 *  5. An HTML body renders as formatting rather than as visible tags. GitHub's
 *     releases feed serves each body already rendered, and the Markdown
 *     pipeline escaped it: the card showed "<h3>Added</h3> <ul> <li>…" as text.
 *     Asserted on the reader's text carrying no markup.
 *  6. The badge is ABSENT, not empty, when the release carried no notes. A
 *     control opening onto blank space reads as a broken one.
 */
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  fixturePath
} from './harness.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'

const DIR = userDataDir('announcement-disclosure')
const ROOT = fixturePath('disclosure-root')
const CLAVE = `${ROOT}/lanes.clave`
const WS = {
  id: 'dddddddd-0000-4000-8000-00000000000d',
  name: 'Notes',
  rootDir: ROOT,
  profileFile: CLAVE,
  createdAt: 1
}

/**
 * A release body of the shape GitHub actually serves for this repo — and long
 * enough to overflow the panel's cap, which is what makes the scroll assertion
 * below mean something. A note that fits proves nothing about a note that does
 * not, and a real release between two versions is this long.
 */
const NOTE_BODY = [
  '### Added',
  '- **Codex usage panel** — see the account reported usage windows and reset times.',
  '- **Codex activity glow** — the icon pulses while Codex works.',
  '- **Linked documents** — open a Markdown file beside the conversation that asked for it.',
  '- **Email composer** — edit recipients and the rendered body without leaving the session.',
  '',
  '### Changed',
  '- **Usage follows the active agent** — the footer shows the selected session provider.',
  '- **The foot panel** — percent left rather than minutes worked, on the tightest window.',
  '',
  '### Fixed',
  '- **Update notes** — release bodies render as formatting rather than as visible tags.',
  '- **Terminal fit** — no more zero-size fit during the group animation.'
].join('\n')

/**
 * The same release as GitHub's feed actually serves it: already rendered to
 * HTML, with the wrapper and decorations a real body carries. This is the exact
 * shape that reached the card as visible tags.
 */
const HTML_NOTE_BODY = [
  '<h3>Added</h3>',
  '<ul>',
  '<li><strong>Edit beside your agent conversation</strong> — open a linked Markdown file.',
  ' <a href="https://example.test/pr/1">#1</a></li>',
  '<li><strong>Compose emails in Clave</strong> — edit recipients and the rendered body.',
  ' <img src="https://example.test/shot.png" alt="shot"></li>',
  '</ul>',
  '<script>steal()</script>'
].join('')

/** Drive the updater store the way the main process does, then read the DOM. */
function pushUpdaterState(win, patch) {
  return win.evaluate((p) => {
    // The store is the seam the banner reads. Reaching it through the app's own
    // module graph rather than a global keeps this honest: if the shape of the
    // state the main process sends ever stops matching what the UI consumes,
    // this goes red rather than passing against a fixture of its own making.
    const store = window.__claveUpdaterStoreForTests
    if (!store) return { ok: false }
    store.setState(p)
    return { ok: true }
  }, patch)
}

function readCard(win, selector) {
  return win.evaluate((sel) => {
    const card = document.querySelector(sel)
    if (!card) return { present: false }
    const toggle = [...card.querySelectorAll('button')].find((b) =>
      /What's changed|Hide details/.test(b.textContent ?? '')
    )
    return {
      present: true,
      hasToggle: !!toggle,
      toggleLabel: toggle?.textContent?.trim() ?? null,
      expanded: toggle?.getAttribute('aria-expanded') ?? null,
      text: (card.textContent ?? '').replace(/\s+/g, ' ').trim()
    }
  }, selector)
}

export async function run(t) {
  mkdirSync(ROOT, { recursive: true })
  writeFileSync(
    CLAVE,
    JSON.stringify(
      {
        $schema: 'clave/1.0',
        groups: [
          {
            name: 'Lane alpha',
            cwd: '.',
            color: 'teal',
            sessions: [{ cwd: '.', name: 'a', claudeMode: false }]
          }
        ]
      },
      null,
      2
    )
  )
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])

  const { app, win } = await launchApp(DIR)
  try {
    // ── 1. The what's-new card is collapsed, and opens ───────────────────
    const version = await app.evaluate(({ app: a }) => a.getVersion())
    await win.evaluate((v) => {
      localStorage.setItem('clave-whats-new-last-seen-version', `${v}-stale`)
    }, version)
    await win.reload()
    await win.waitForLoadState('domcontentloaded')
    await win.waitForTimeout(4000)

    const wn = await win.evaluate(() => {
      const heading = [...document.querySelectorAll('span')].find((s) =>
        /^New in /.test(s.textContent ?? '')
      )
      if (!heading) return { present: false }
      const card = heading.closest('div.rounded-xl')
      const toggle = [...card.querySelectorAll('button')].find((b) =>
        /What's changed|Hide details/.test(b.textContent ?? '')
      )
      return {
        present: true,
        hasToggle: !!toggle,
        expanded: toggle?.getAttribute('aria-expanded'),
        // The description body must NOT be in the DOM while collapsed.
        cardChars: (card.textContent ?? '').length
      }
    })

    t.check('the what’s-new card is on screen', wn.present === true, wn)
    t.check('it offers a disclosure', wn.hasToggle === true, wn)
    t.check('it is collapsed at rest', wn.expanded === 'false', wn)
    // Guard the guard: collapsed must be genuinely shorter than the note, or
    // "collapsed" is meaningless. The headline alone is a line, not paragraphs.
    t.check(
      'collapsed shows the headline only, not the note',
      wn.cardChars > 0 && wn.cardChars < 400,
      `card renders ${wn.cardChars} chars while collapsed — the body is still in the card`
    )

    // Open it and measure the note that appears.
    const opened = await win.evaluate(() => {
      const heading = [...document.querySelectorAll('span')].find((s) =>
        /^New in /.test(s.textContent ?? '')
      )
      const card = heading.closest('div.rounded-xl')
      const toggle = [...card.querySelectorAll('button')].find((b) =>
        /What's changed/.test(b.textContent ?? '')
      )
      toggle.click()
      return true
    })
    t.check('the disclosure could be clicked', opened === true, opened)
    await win.waitForTimeout(500)

    const wnOpen = await win.evaluate(() => {
      const heading = [...document.querySelectorAll('span')].find((s) =>
        /^New in /.test(s.textContent ?? '')
      )
      const card = heading.closest('div.rounded-xl')
      const toggle = [...card.querySelectorAll('button')].find((b) =>
        /Hide details/.test(b.textContent ?? '')
      )
      // The scrolling box the note lives in.
      const box = [...card.querySelectorAll('div')].find(
        (d) => getComputedStyle(d).overflowY === 'auto' && d.scrollHeight > 0
      )
      let scrolled = null
      if (box) {
        box.scrollTop = 9999
        scrolled = box.scrollTop
        box.scrollTop = 0
      }
      const sidebar = card.closest('.flex.flex-col.h-full')
      return {
        expanded: toggle?.getAttribute('aria-expanded') ?? null,
        label: toggle?.textContent?.trim() ?? null,
        cardChars: (card.textContent ?? '').length,
        hasBox: !!box,
        clientHeight: box?.clientHeight ?? null,
        scrollHeight: box?.scrollHeight ?? null,
        scrolled,
        cardBottom: Math.round(card.getBoundingClientRect().bottom),
        sidebarBottom: sidebar ? Math.round(sidebar.getBoundingClientRect().bottom) : null,
        viewportHeight: window.innerHeight
      }
    })

    t.check('it reports itself expanded', wnOpen.expanded === 'true', wnOpen)
    t.check('the toggle now offers to hide', /Hide details/.test(wnOpen.label ?? ''), wnOpen)
    t.check(
      'the note is now in the card',
      wnOpen.cardChars > wn.cardChars + 200,
      `collapsed ${wn.cardChars} chars → expanded ${wnOpen.cardChars}; the note did not appear`
    )
    t.check('the note has a scrolling box', wnOpen.hasBox === true, wnOpen)
    // The cap, at the moment it matters: with the note OPEN.
    t.check(
      'the open note is capped rather than as tall as its text',
      wnOpen.clientHeight > 0 && wnOpen.scrollHeight > wnOpen.clientHeight + 20,
      wnOpen
    )
    t.check(
      'the cap keeps it a sidebar element, not a screenful',
      wnOpen.clientHeight <= Math.round(wnOpen.viewportHeight * 0.45),
      wnOpen
    )
    // The one that cannot be faked by a class name: the box actually moved.
    t.check(
      'scrolling the open note actually moves it',
      wnOpen.scrolled > 0,
      `scrollTop settled at ${wnOpen.scrolled}`
    )
    t.check(
      'the card stays inside the window with the note open',
      wnOpen.cardBottom <= wnOpen.viewportHeight,
      wnOpen
    )

    // The note must use the card's WIDTH, not share a flex row with the
    // chevron beside it. The first version of this did exactly that — the
    // trigger and the note were wrapped together so "Try it" could sit next to
    // the chevron — and the paragraphs rendered in a column roughly half the
    // card wide, squeezed against the toggle. Every assertion above still
    // passed: the box was capped, it scrolled, and it stayed in the window.
    // Only a width comparison sees it, which is why it is measured here.
    const width = await win.evaluate(() => {
      const heading = [...document.querySelectorAll('span')].find((s) =>
        /^New in /.test(s.textContent ?? '')
      )
      const card = heading.closest('div.rounded-xl')
      const box = [...card.querySelectorAll('div')].find(
        (d) => getComputedStyle(d).overflowY === 'auto'
      )
      return {
        noteWidth: Math.round(box.getBoundingClientRect().width),
        cardWidth: Math.round(card.getBoundingClientRect().width)
      }
    })
    t.check(
      'the open note spans the card rather than a column beside the toggle',
      width.noteWidth >= width.cardWidth * 0.8,
      `note is ${width.noteWidth}px inside a ${width.cardWidth}px card — it is sharing a flex row with the disclosure`
    )

    // Close it again — a disclosure that only opens is half a control.
    const wnClosed = await win.evaluate(() => {
      const heading = [...document.querySelectorAll('span')].find((s) =>
        /^New in /.test(s.textContent ?? '')
      )
      const card = heading.closest('div.rounded-xl')
      const toggle = [...card.querySelectorAll('button')].find((b) =>
        /Hide details/.test(b.textContent ?? '')
      )
      toggle.click()
      return true
    })
    t.check('the open note could be closed', wnClosed === true, wnClosed)
    await win.waitForTimeout(500)
    const wnAfter = await win.evaluate(() => {
      const heading = [...document.querySelectorAll('span')].find((s) =>
        /^New in /.test(s.textContent ?? '')
      )
      const card = heading.closest('div.rounded-xl')
      const toggle = [...card.querySelectorAll('button')].find((b) =>
        /What's changed/.test(b.textContent ?? '')
      )
      return {
        expanded: toggle?.getAttribute('aria-expanded') ?? null,
        cardChars: (card.textContent ?? '').length
      }
    })
    t.check('it collapses again', wnAfter.expanded === 'false', wnAfter)
    t.check(
      'and the note leaves the card with it',
      wnAfter.cardChars < wnOpen.cardChars - 200,
      `still ${wnAfter.cardChars} chars after collapsing (open was ${wnOpen.cardChars})`
    )

    // ── 2. The update card carries the release notes, off the badge ──────
    // Dev builds are `supported: false` and never reach the `available` phase,
    // so the state is pushed at the store — the same seam the main process
    // writes through — rather than faked in the DOM.
    const pushed = await pushUpdaterState(win, {
      supported: true,
      phase: 'available',
      availableVersion: '9.9.9',
      releaseNotes: [{ version: '9.9.9', note: NOTE_BODY, format: 'markdown' }],
      dismissed: false
    })
    t.check(
      'the updater store is reachable for the test',
      pushed.ok === true,
      'window.__claveUpdaterStoreForTests is missing — the update card cannot be driven'
    )
    await win.waitForTimeout(600)

    const up = await readCard(win, '[data-testid="update-banner"]')
    t.check('the update card is on screen', up.present === true, up)
    t.check('it names the available version', /9\.9\.9/.test(up.text ?? ''), up)
    // The fold is gone: the changelog is reference beside a decision, not part
    // of the box holding Later and Update.
    t.check(
      'the card no longer folds the changelog into itself',
      up.hasToggle === false,
      `a "What's changed" fold is back inside the update card — ${up.toggleLabel}`
    )
    t.check('the notes are not in the card', !/Codex usage panel/.test(up.text ?? ''), up)

    const badge = win.locator('[data-testid="release-notes-badge"]')
    t.check('the update icon carries an info badge', (await badge.count()) === 1)
    // On the icon, not somewhere in the row: the badge is the affordance for
    // "what is in this", and the icon is what it is about.
    const badgePlace = await win.evaluate(() => {
      const b = document.querySelector('[data-testid="release-notes-badge"]')
      const icon = b?.parentElement
      if (!b || !icon) return null
      const br = b.getBoundingClientRect()
      const ir = icon.getBoundingClientRect()
      return {
        onIcon: !!icon.querySelector('svg'),
        // A corner: the badge's centre sits at the icon's top-right.
        aboveMiddle: br.top + br.height / 2 < ir.top + ir.height / 2,
        rightOfMiddle: br.left + br.width / 2 > ir.left + ir.width / 2,
        size: Math.round(br.width)
      }
    })
    t.check('the badge sits on the update icon', badgePlace?.onIcon === true, badgePlace)
    t.check(
      'and in one of its top corners',
      badgePlace?.aboveMiddle === true && badgePlace?.rightOfMiddle === true,
      badgePlace
    )
    t.check(
      'at badge scale, not button scale',
      badgePlace?.size > 0 && badgePlace?.size <= 20,
      badgePlace
    )

    // The card must stay ONE row. The fold's whole problem was that reading the
    // changelog grew the card and pushed the two buttons down the sidebar.
    const cardBefore = await win.evaluate(
      () => document.querySelector('[data-testid="update-banner"]').getBoundingClientRect().height
    )

    // --- Hover opens it ---
    await badge.hover()
    await win.waitForTimeout(500)
    const panel = win.locator('[data-testid="release-notes-popover"]')
    t.check('hovering the badge opens the notes panel', (await panel.count()) === 1)

    const hovered = await win.evaluate(() => {
      const p = document.querySelector('[data-testid="release-notes-popover"]')
      const card = document.querySelector('[data-testid="update-banner"]')
      const box = p
        ? [...p.querySelectorAll('div')].find((d) => getComputedStyle(d).overflowY === 'auto')
        : null
      let scrolled = null
      if (box) {
        box.scrollTop = 9999
        scrolled = box.scrollTop
        box.scrollTop = 0
      }
      return {
        text: (p?.textContent ?? '').replace(/\s+/g, ' ').trim(),
        listItems: p?.querySelectorAll('li').length ?? 0,
        strongs: p?.querySelectorAll('strong').length ?? 0,
        rawHashes: /###/.test(p?.textContent ?? ''),
        insideCard: card && p ? card.contains(p) : null,
        cardHeight: card?.getBoundingClientRect().height ?? null,
        capped: box ? box.clientHeight <= Math.round(window.innerHeight * 0.5) : null,
        scrolls: box ? box.scrollHeight > box.clientHeight : null,
        scrolled,
        panelBottom: p ? Math.round(p.getBoundingClientRect().bottom) : null,
        panelRight: p ? Math.round(p.getBoundingClientRect().right) : null,
        viewport: { w: window.innerWidth, h: window.innerHeight }
      }
    })

    // The point of the whole feature: the changelog for a version NOT installed.
    t.check(
      'the release notes are rendered before installing',
      /Codex usage panel/.test(hovered.text),
      hovered
    )
    t.check(
      'and the whole body is there, not just the first line',
      /Usage follows the active agent/.test(hovered.text),
      hovered
    )
    t.check('the notes render as a list, not as raw markdown', hovered.listItems >= 8, hovered)
    t.check('the bullet lead-ins render as emphasis', hovered.strongs >= 8, hovered)
    t.check('no raw "###" leaks into the panel', hovered.rawHashes === false, hovered)
    t.check('the panel is beside the card, not inside it', hovered.insideCard === false, hovered)
    t.check(
      'the card stays one row while the notes are open',
      Math.abs(hovered.cardHeight - cardBefore) < 2,
      `card was ${cardBefore}px and is ${hovered.cardHeight}px with the panel open — the notes are growing it again`
    )
    t.check(
      'the open notes are capped rather than as tall as their text',
      hovered.capped === true,
      hovered
    )
    t.check(
      'and scroll inside their own box',
      hovered.scrolls === true && hovered.scrolled > 0,
      hovered
    )
    t.check(
      'the panel stays inside the window',
      hovered.panelBottom <= hovered.viewport.h && hovered.panelRight <= hovered.viewport.w,
      hovered
    )

    // --- Hovering away closes it again ---
    await win.locator('[data-testid="update-banner"]').hover()
    await win.waitForTimeout(700)
    t.check(
      'the panel closes when the pointer leaves',
      (await win.locator('[data-testid="release-notes-popover"]').count()) === 0
    )

    // --- Click pins it, so the pointer can travel to it ---
    await badge.click()
    await win.waitForTimeout(400)
    t.check(
      'clicking the badge opens the panel',
      (await win.locator('[data-testid="release-notes-popover"]').count()) === 1
    )
    await win.locator('[data-testid="update-banner"]').hover()
    await win.waitForTimeout(700)
    t.check(
      'and it stays open once pinned, with the pointer elsewhere',
      (await win.locator('[data-testid="release-notes-popover"]').count()) === 1,
      'a pinned panel closed on mouse-out — following a link in a note is impossible'
    )
    await win.keyboard.press('Escape')
    await win.waitForTimeout(400)
    t.check(
      'Escape dismisses a pinned panel',
      (await win.locator('[data-testid="release-notes-popover"]').count()) === 0
    )

    // ── 3. An HTML body renders as formatting, not as visible tags ────────
    // The bug this whole path exists for. GitHub's releases FEED — where
    // electron-updater reads bodies from — serves each body already rendered to
    // HTML, so the Markdown renderer escaped it and the card showed
    // "<h3>Added</h3> <ul> <li>..." as text: every tag on screen, nothing
    // formatted, and no error anywhere to notice it by.
    await pushUpdaterState(win, {
      supported: true,
      phase: 'available',
      availableVersion: '9.9.9',
      releaseNotes: [{ version: '9.9.9', note: HTML_NOTE_BODY, format: 'html' }],
      dismissed: false
    })
    await win.waitForTimeout(500)
    await win.locator('[data-testid="release-notes-badge"]').click()
    await win.waitForTimeout(400)

    const html = await win.evaluate(() => {
      const p = document.querySelector('[data-testid="release-notes-popover"]')
      return {
        text: (p?.textContent ?? '').replace(/\s+/g, ' ').trim(),
        headings: p?.querySelectorAll('h1,h2,h3,h4').length ?? 0,
        listItems: p?.querySelectorAll('li').length ?? 0,
        strongs: p?.querySelectorAll('strong').length ?? 0,
        links: p?.querySelectorAll('a').length ?? 0,
        images: p?.querySelectorAll('img').length ?? 0,
        scripts: p?.querySelectorAll('script').length ?? 0
      }
    })
    t.check('an HTML body renders as elements', html.headings >= 1 && html.listItems >= 2, html)
    t.check('the bold lead-ins survive as emphasis', html.strongs >= 2, html)
    // The failure the user actually saw, asserted on the text a reader reads.
    t.check(
      'and no tag is left visible as text',
      !/<\/?[a-z]/i.test(html.text),
      `the card is showing markup as words: ${html.text.slice(0, 120)}`
    )
    t.check('the words of the note are there', /Edit beside your agent/.test(html.text), html)
    // The sanitiser is the renderer's trust boundary; these are what a GitHub
    // body actually carries that must not survive it.
    t.check('no script survives into the panel', html.scripts === 0, html)
    t.check('no image is fetched into a 280px panel', html.images === 0, html)
    t.check('a real link is kept', html.links === 1, html)

    await win.keyboard.press('Escape')
    await win.waitForTimeout(300)

    // ── 4. No notes → no badge at all ────────────────────────────────────
    await pushUpdaterState(win, {
      supported: true,
      phase: 'available',
      availableVersion: '9.9.9',
      releaseNotes: null,
      dismissed: false
    })
    await win.waitForTimeout(500)
    const upNone = await readCard(win, '[data-testid="update-banner"]')
    t.check('the update card still shows without notes', upNone.present === true, upNone)
    t.check(
      'but offers no badge to open onto nothing',
      (await win.locator('[data-testid="release-notes-badge"]').count()) === 0,
      'an info badge is present with releaseNotes: null — it would open onto blank space'
    )
  } finally {
    await app.close()
  }
}
