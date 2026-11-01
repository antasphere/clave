/**
 * The release note in the sidebar, and the hairline in the panel opposite it.
 *
 * 1. A what's-new entry is a changelog, not a line: the entries in
 *    `help/whats-new.json` run to several paragraphs. The banner rendered the
 *    whole thing as one unbounded paragraph inside the sidebar's `flex-shrink-0`
 *    announcements block, so a long note grew the block until the session list
 *    and the foot panel were pushed off the bottom of the window with nothing to
 *    scroll. Asserted on measured geometry and on a real scroll — "the element
 *    has overflow-y: auto" is true of a box that never overflows, and a height
 *    cap alone is true of a box whose text is simply clipped.
 *
 *    The card is now a headline with the note behind a disclosure, so the
 *    overflow this guards moved WITH the note into its expanded state — which
 *    is the only state it was ever about. The note is opened before measuring;
 *    the assertions underneath are otherwise the ones originally written, since
 *    the failure they describe is unchanged and expanding is exactly when it
 *    would come back. `announcement-disclosure.spec.mjs` covers the collapsing
 *    itself.
 *
 * 2. The repeating hairline between blocks of the Files and Git trees, in light
 *    mode. Asserted as the composited difference against the ground it is drawn
 *    on, in 0-255 levels, not as a hex: what "too dark" means is how far off the
 *    surface the line lands, and a token swap that keeps the number but changes
 *    the surface would pass a string comparison and fail the eye.
 */
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  fixturePath
} from './harness.mjs'
import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fixtureRoot } from './namespace.mjs'

const DIR = userDataDir('sidebar-whats-new')
const ROOT = fixturePath('whats-new-root')
const CLAVE = `${ROOT}/lanes.clave`
const WS = {
  id: 'cccccccc-0000-4000-8000-00000000000c',
  name: 'Notes',
  rootDir: ROOT,
  profileFile: CLAVE,
  createdAt: 1
}

/** Composite `rgba(r,g,b,a)` over an opaque ground and return the per-channel
 *  distance in 0-255 levels — how far off the surface the line actually lands. */
function levelsOffGround(rule, ground) {
  // The stylesheet is minified, so a token authored as `rgba(0, 0, 0, 0.022)`
  // reads back as `#00000006`. Both forms have to parse or the check is NaN.
  const parse = (s) => {
    const v = s.trim()
    if (v.startsWith('#')) {
      const h = v.slice(1)
      const p = h.length <= 4 ? h.split('').map((c) => c + c) : h.match(/../g)
      return {
        r: parseInt(p[0], 16),
        g: parseInt(p[1], 16),
        b: parseInt(p[2], 16),
        a: p[3] === undefined ? 1 : parseInt(p[3], 16) / 255
      }
    }
    const n = v.match(/[\d.]+/g).map(Number)
    return { r: n[0], g: n[1], b: n[2], a: n[3] ?? 1 }
  }
  const c = parse(rule)
  const g = parse(ground)
  return Math.max(
    Math.abs(g.r - (g.r * (1 - c.a) + c.r * c.a)),
    Math.abs(g.g - (g.g * (1 - c.a) + c.g * c.a)),
    Math.abs(g.b - (g.b * (1 - c.a) + c.b * c.a))
  )
}

// Keep the release data unchanged; the fixture selects one existing long entry.
const FIXTURE_VERSION = '2.0.0'
const FIXTURE_ENTRY_HASH = 'ee357e9d7476606e7fb15ef327ed391e4b018d10cda2ab8c7e8a9b5982f70bb5'

function checkReleaseFixture() {
  const data = readFileSync(new URL('../../src/renderer/src/help/whats-new.json', import.meta.url), 'utf8')
  const raw = data.match(/\{\s*"version": "2\.0\.0",[\s\S]*?\n  \}/)?.[0]
  if (
    !raw ||
    Buffer.byteLength(raw) !== 1014 ||
    createHash('sha256').update(raw).digest('hex') !== FIXTURE_ENTRY_HASH
  ) throw new Error('The pinned long release entry changed; review this fixture.')
  const entry = JSON.parse(raw)
  if (entry.version !== FIXTURE_VERSION || entry.description.length !== 887) {
    throw new Error('The release fixture must retain its version and long description.')
  }
}

function throwFixtureErrors(errors, label) {
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) {
    throw new AggregateError(errors, `${label}: ${errors.map(String).join('; ')}`)
  }
}

function claimFixtureProfile() {
  const dir = resolve(DIR)
  if (
    !isAbsolute(DIR) ||
    DIR !== dir ||
    dirname(dir) !== resolve(fixtureRoot()) ||
    dir === resolve(ROOT)
  ) throw new Error('The version fixture requires its isolated harness profile.')
  mkdirSync(dirname(dir), { recursive: true })
  const token = randomUUID()
  // A sibling survives seedWorkspaces({ fresh: true }), which removes DIR.
  const lockPath = `${dir}.whats-new-version.lock`
  const fd = openSync(lockPath, 'wx', 0o600)
  return { dir, lockPath, fd, token }
}

function releaseFixtureProfile(claim, app) {
  const errors = []
  try {
    const child = app?.process()
    if (child && child.exitCode === null && child.signalCode === null) {
      throw new Error('The test app is still running; its profile claim is retained.')
    }
    const held = fstatSync(claim.fd)
    const current = lstatSync(claim.lockPath)
    if (!current.isFile() || current.dev !== held.dev || current.ino !== held.ino) {
      throw new Error('The profile claim was replaced; refusing to remove it.')
    }
    unlinkSync(claim.lockPath)
  } catch (error) {
    errors.push(error)
  } finally {
    try {
      closeSync(claim.fd)
    } catch (error) {
      errors.push(error)
    }
  }
  throwFixtureErrors(errors, 'Profile claim cleanup failed')
}

async function installVersionFixture(app, win, claim) {
  if (!(await win.evaluate(() => window.__claveTestMode === true))) {
    throw new Error('The renderer is not in hidden test mode.')
  }
  await app.evaluate(({ app: a }, { dir, token, version }) => {
    const profiles = process.argv.filter((arg) => arg.startsWith('--user-data-dir='))
    if (
      !process.argv.includes('--test-no-activate') ||
      profiles.length !== 1 ||
      profiles[0] !== `--user-data-dir=${dir}` ||
      a.getPath('userData') !== dir
    ) throw new Error('The main process is not the claimed isolated test instance.')

    const key = Symbol.for('clave.e2e.whats-new-version-fixture')
    if (Reflect.has(globalThis, key)) throw new Error('A version fixture is already installed.')
    const own = Object.getOwnPropertyDescriptor(a, 'getVersion')
    let owner = a
    while (owner && !Object.hasOwn(owner, 'getVersion')) owner = Object.getPrototypeOf(owner)
    const descriptor = owner && Object.getOwnPropertyDescriptor(owner, 'getVersion')
    const original = a.getVersion
    if (
      !descriptor ||
      !Object.hasOwn(descriptor, 'value') ||
      typeof original !== 'function' ||
      descriptor.value !== original ||
      (own ? !own.configurable && !own.writable : !Object.isExtensible(a))
    ) throw new Error('Unsupported app.getVersion property shape; no override was made.')
    const baseline = Reflect.apply(original, a, [])
    if (typeof baseline !== 'string') throw new Error('Unsupported app.getVersion baseline.')
    const replacement = () => version
    const overridden = own
      ? { ...own, value: replacement }
      : { value: replacement, writable: true, configurable: true, enumerable: descriptor.enumerable }
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: {
        token, dir, original, baseline, own, owner, descriptor,
        prototype: Object.getPrototypeOf(a), overridden
      }
    })
    // A legal configurable data property or writable own data property only.
    Object.defineProperty(a, 'getVersion', overridden)
    if (a.getVersion !== replacement || a.getVersion() !== version) {
      throw new Error('The main version fixture did not take effect.')
    }
  }, { dir: claim.dir, token: claim.token, version: FIXTURE_VERSION })
}

async function restoreVersionFixture(app, claim, installed) {
  await app.evaluate(({ app: a }, { token, installed: expected }) => {
    const key = Symbol.for('clave.e2e.whats-new-version-fixture')
    const cell = Object.getOwnPropertyDescriptor(globalThis, key)?.value
    if (!cell) {
      if (expected) throw new Error('The installed version fixture lost its restore cell.')
      return
    }
    if (cell.token !== token || cell.dir !== a.getPath('userData')) {
      throw new Error('Refusing to restore another version fixture.')
    }
    const sameDescriptor = (left, right) => {
      if (!left || !right) return left === right
      return ['value', 'writable', 'get', 'set', 'configurable', 'enumerable'].every(
        (field) => Object.hasOwn(left, field) === Object.hasOwn(right, field) && left[field] === right[field]
      )
    }
    const errors = []
    try {
      if (!sameDescriptor(Object.getOwnPropertyDescriptor(a, 'getVersion'), cell.overridden)) {
        errors.push(new Error('The fixture getter descriptor changed before restoration.'))
      }
      if (cell.own) {
        Object.defineProperty(a, 'getVersion', cell.own)
      } else if (!Reflect.deleteProperty(a, 'getVersion')) {
        throw new Error('The inherited getter shadow could not be deleted.')
      }
      let owner = a
      while (owner && !Object.hasOwn(owner, 'getVersion')) owner = Object.getPrototypeOf(owner)
      if (
        Object.hasOwn(a, 'getVersion') !== Boolean(cell.own) ||
        !sameDescriptor(Object.getOwnPropertyDescriptor(a, 'getVersion'), cell.own) ||
        Object.getPrototypeOf(a) !== cell.prototype ||
        owner !== cell.owner ||
        !sameDescriptor(Object.getOwnPropertyDescriptor(owner, 'getVersion'), cell.descriptor) ||
        a.getVersion !== cell.original ||
        a.getVersion() !== cell.baseline
      ) throw new Error('The original getter reference, shape or baseline was not restored.')
    } catch (error) {
      errors.push(error)
    } finally {
      if (!Reflect.deleteProperty(globalThis, key)) {
        errors.push(new Error('The version restore cell could not be cleared.'))
      }
    }
    if (errors.length) {
      throw new AggregateError(errors, `Version restoration failed: ${errors.map(String).join('; ')}`)
    }
  }, { token: claim.token, installed })
}

export async function run(t) {
  const errors = []
  let app
  let win
  let claim
  let installed = false
  try {
    checkReleaseFixture()
    claim = claimFixtureProfile()
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

    const launched = await launchApp(DIR)
    app = launched.app
    win = launched.win
    await installVersionFixture(app, win, claim)
    installed = true
    const mainVersion = await app.evaluate(({ app: a }) => a.getVersion())
    const exposedVersion = await win.evaluate(() => window.electronAPI.getAppVersion())
    if (mainVersion !== FIXTURE_VERSION || exposedVersion !== FIXTURE_VERSION) {
      throw new Error('The main and exposed version must agree before the existing reload.')
    }
    // ── 1. The release note ──────────────────────────────────────────────
    // The banner only shows for a version you have not seen, and only when an
    // entry exists for the version running. Seed a stale "last seen" and reload
    // so the check runs on boot against the real whats-new.json.
    const version = await app.evaluate(({ app: a }) => a.getVersion())
    await win.evaluate((v) => {
      localStorage.setItem('clave-whats-new-last-seen-version', `${v}-stale`)
    }, version)
    await win.reload()
    await win.waitForLoadState('domcontentloaded')
    await win.waitForTimeout(4000)

    // Open the disclosure: the note, and the cap this spec is about, live
    // behind it now.
    const openedIt = await win.evaluate(() => {
      const heading = [...document.querySelectorAll('span')].find((s) =>
        /^New in /.test(s.textContent ?? '')
      )
      if (!heading) return false
      const card = heading.closest('div.rounded-xl')
      const toggle = [...card.querySelectorAll('button')].find((b) =>
        /What's changed/.test(b.textContent ?? '')
      )
      if (!toggle) return false
      toggle.click()
      return true
    })
    t.check(
      'the note can be opened',
      openedIt === true,
      'no “What’s changed” disclosure on the card'
    )
    await win.waitForTimeout(500)

    const banner = await win.evaluate(() => {
      const heading = [...document.querySelectorAll('span')].find((s) =>
        /^New in /.test(s.textContent ?? '')
      )
      if (!heading) return { present: false }
      const card = heading.closest('div.rounded-xl')
      // The scrolling box the opened note lives in — not the headline `p`
      // above it, which is one line by design.
      const body = [...card.querySelectorAll('div')].find(
        (d) => getComputedStyle(d).overflowY === 'auto'
      )
      if (!body) return { present: true, body: false }
      const cs = getComputedStyle(body)
      body.scrollTop = 9999
      const scrolled = body.scrollTop
      body.scrollTop = 0
      const sidebar = card.closest('.flex.flex-col.h-full')
      return {
        present: true,
        body: true,
        overflowY: cs.overflowY,
        clientHeight: body.clientHeight,
        scrollHeight: body.scrollHeight,
        scrolled,
        chars: (body.textContent ?? '').length,
        sidebarBottom: sidebar ? Math.round(sidebar.getBoundingClientRect().bottom) : null,
        cardBottom: Math.round(card.getBoundingClientRect().bottom),
        viewportHeight: window.innerHeight
      }
    })

    t.check('the what’s-new banner is on screen', banner.present === true, banner)
    t.check('it renders a body paragraph', banner.body === true, banner)

    // Guard the guard: a short note would make every assertion below vacuous.
    t.check(
      'the entry under test is a long one (the case that broke)',
      banner.chars > 600,
      `body is ${banner.chars} chars — seed a longer entry or this proves nothing`
    )

    t.check(
      'the body is capped rather than as tall as its text',
      banner.clientHeight > 0 && banner.scrollHeight > banner.clientHeight + 20,
      banner
    )
    t.check(
      'the cap leaves the banner a sidebar element, not a screenful',
      banner.clientHeight <= Math.round(banner.viewportHeight * 0.45),
      banner
    )
    t.check(
      'the overflow is scrollable, not clipped',
      banner.overflowY === 'auto' || banner.overflowY === 'scroll',
      `overflow-y is ${banner.overflowY}`
    )
    // The one that cannot be faked by a class name: the box actually moved.
    t.check(
      'scrolling the body actually moves it',
      banner.scrolled > 0,
      `scrollTop settled at ${banner.scrolled}`
    )
    t.check(
      'the banner stays inside the window with the note open',
      banner.cardBottom <= banner.viewportHeight,
      banner
    )

    // ── 2. The tree hairline in light mode ───────────────────────────────
    const rule = await win.evaluate(async () => {
      const prev = (await window.electronAPI.skinsList()).activeId
      await window.electronAPI.skinsActivate('light')
      const probe = document.createElement('div')
      probe.className = 'tree-rule'
      document.body.appendChild(probe)
      const cs = getComputedStyle(probe)
      const root = getComputedStyle(document.documentElement)
      const out = {
        rule: root.getPropertyValue('--rule-color').trim(),
        rendered: cs.backgroundColor,
        height: cs.height,
        // The ground a Files/Git tree rule is drawn on.
        ground: root.getPropertyValue('--surface-50').trim(),
        borderSubtle: root.getPropertyValue('--border-subtle-color').trim()
      }
      probe.remove()
      if (prev) await window.electronAPI.skinsActivate(prev)
      return out
    })

    const ground = rule.ground
    // The PAINTED colour, not the token text: what the eye gets is what the
    // element actually renders once the cascade is done with it.
    const off = levelsOffGround(rule.rendered, ground)
    const subtleOff = levelsOffGround(rule.borderSubtle, ground)

    t.check('the tree rule still draws a line', rule.height === '1px', rule)
    t.check(
      'the light-mode rule is still visible',
      off >= 3,
      `${rule.rendered} on ${ground} lands ${off.toFixed(2)} levels off it — a rule nobody can see is not subtle, it is missing`
    )
    t.check(
      'the light-mode rule is subtle',
      off <= 7,
      `${rule.rendered} on ${ground} lands ${off.toFixed(2)} levels off it — too dark for a line that repeats down every block`
    )
    t.check(
      'it stays lighter than the panel borders it repeats between',
      off < subtleOff,
      `rule ${off.toFixed(2)} vs --border-subtle ${subtleOff.toFixed(2)} levels`
    )
  } catch (error) {
    errors.push(error)
  } finally {
    try {
      if (app) {
        try {
          await restoreVersionFixture(app, claim, installed)
        } catch (error) {
          errors.push(error)
        }
      }
    } finally {
      try {
        if (app) await app.close()
      } catch (error) {
        errors.push(error)
      } finally {
        if (claim) {
          try {
            releaseFixtureProfile(claim, app)
          } catch (error) {
            errors.push(error)
          }
        }
      }
    }
  }
  throwFixtureErrors(errors, 'The spec and its version fixture failed')
}
