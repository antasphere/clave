// The Antasphere account (PRDCT-3259) through the real app, with the server
// IN-PROCESS (the shipped shape; `antasphere-account-attached.spec.mjs` is
// the same login on a standalone server): Settings → Accounts, "Sign in
// with Antasphere", the browser stood in by a fetch that follows the local
// issuer's redirect back to the app's loopback listener, the name and email
// on screen, the session sealed on disk and restored at the next launch, a
// cancel, a cancel while the issuer is slow (the sign-in's answer waits on
// discovery; Cancel must stay live and the late answer must change
// nothing), a sign-out, and what the renderer can and cannot see. The
// issuer is a provider this spec starts on 127.0.0.1, named to the app
// through CLAVE_ANTASPHERE_ISSUER; `shell.openExternal` is replaced in main
// so no browser ever opens on the machine.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { launchApp, seedWorkspaces, userDataDir, fixturePath, until } from './harness.mjs'
import { startOidcProvider } from './fixtures/oidc-provider.mjs'

const DIR = userDataDir('antasphere-account')
const ROOT = fixturePath('antasphere-account-root')
const WS = {
  id: 'antasphere-ws',
  name: 'Antasphere',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}
const SESSION_FILE = path.join(DIR, 'antasphere-account-session.json')
const CLIENT_FILE = path.join(DIR, 'antasphere-account-client.json')
const STATUS_KEYS = [
  'account',
  'expiresAt',
  'issuerHost',
  'lastFailure',
  'loginStartedAt',
  'phase',
  'renewable',
  'secureStorage',
  'signedInAt'
]

/** No browser on this machine: main records what it would have opened. */
async function stubBrowser(app) {
  await app.evaluate(({ shell }) => {
    globalThis.__antasphereOpened = []
    shell.openExternal = async (url) => {
      globalThis.__antasphereOpened.push(url)
    }
  })
  return () => app.evaluate(() => globalThis.__antasphereOpened ?? [])
}

async function openAccounts(win) {
  await win.click('.sidebar-footer-btn[aria-label="Settings"]')
  await win.click('[data-settings-nav-row="accounts"]')
  const page = win.locator('[data-settings-page="accounts"]')
  await page.waitFor()
  const section = page.locator('[data-antasphere-account]')
  await section.waitFor()
  return { page, section }
}

const phaseOf = (section) => section.getAttribute('data-antasphere-phase')
const waitPhase = (section, phase) =>
  until(async () => ((await phaseOf(section)) === phase ? phase : null))
const rendererStatus = (win) => win.evaluate(() => window.electronAPI.antasphereAccountGet())

export async function run(t) {
  rmSync(DIR, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  const provider = await startOidcProvider({
    user: { sub: 'e2e-user-1', name: 'E2E Person', email: 'e2e@example.test', email_verified: true }
  })
  const env = { CLAVE_ANTASPHERE_ISSUER: provider.issuer }
  const errors = []
  let { app, win } = await launchApp(DIR, { env, server: 'in-process' })
  win.on('pageerror', (e) => errors.push(e.message))
  try {
    let opened = await stubBrowser(app)
    let { page, section } = await openAccounts(win)

    // ── The page ─────────────────────────────────────────────────────────
    const firstSection = await page.evaluate(
      () =>
        !!document.querySelector('.settings-page-sections > section [data-antasphere-account]') &&
        document.querySelector('.settings-page-sections > section') ===
          document.querySelector('[data-antasphere-account]').closest('section')
    )
    t.check('the Antasphere section is the first on the Accounts page', firstSection)
    const description = await page.locator('.settings-page-description').textContent()
    t.check(
      'the page description covers the app identity and the provider subscriptions',
      description.includes('Antasphere account') && description.includes('subscriptions'),
      description
    )
    t.equal('signed out at first', await phaseOf(section), 'signed-out')
    t.equal(
      'the provider sections are still there',
      await page.locator('[data-claude-add-account]').count(),
      1
    )
    const signInButton = section.getByRole('button', {
      name: 'Sign in with Antasphere',
      exact: true
    })
    await until(async () => !(await signInButton.isDisabled()))
    t.check('Sign in with Antasphere is offered', await signInButton.isEnabled())

    // ── A login cancelled ────────────────────────────────────────────────
    await signInButton.click()
    t.equal(
      'the section shows the login in flight',
      await waitPhase(section, 'signing-in'),
      'signing-in'
    )
    const progress = await section.locator('[data-antasphere-login]').textContent()
    t.check(
      'the progress line is one plain sentence',
      progress.includes('Finish signing in in your browser') &&
        !/token|scope|OAuth/i.test(progress),
      progress
    )
    t.equal('with a way to cancel', await section.locator('[data-antasphere-cancel]').count(), 1)
    const urls = await until(async () => {
      const u = await opened()
      return u.length ? u : null
    })
    t.check(
      'the browser was asked once, at the local issuer',
      urls?.length === 1 && urls[0].startsWith(`${provider.issuer}/authorize?`),
      urls
    )
    const q = new URL(urls[0]).searchParams
    t.equal('the request uses PKCE S256', q.get('code_challenge_method'), 'S256')
    t.equal(
      'and asks for the identity scopes only',
      q.get('scope'),
      'openid profile email offline_access'
    )
    t.check('with a state and a nonce', !!q.get('state') && !!q.get('nonce'))
    t.check(
      'to a loopback callback',
      /^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(q.get('redirect_uri'))
    )
    const inFlight = await rendererStatus(win)
    t.check(
      'the renderer sees the login in flight and nothing of the request',
      inFlight.phase === 'signing-in' &&
        !/http|code_|state=|nonce|token/.test(JSON.stringify(inFlight)),
      inFlight
    )
    await section.locator('[data-antasphere-cancel]').click()
    t.equal('cancel: signed out', await waitPhase(section, 'signed-out'), 'signed-out')
    t.equal(
      'with the reason shown',
      await section.locator('[data-antasphere-failure="cancelled"]').count(),
      1
    )
    const stale = await provider.browse(urls[0]).then(
      (r) => `callback answered ${r.response.status}`,
      (e) => e
    )
    t.check('the cancelled login’s link lands on nothing', stale instanceof Error, String(stale))
    t.equal('and the app stays signed out', await phaseOf(section), 'signed-out')
    t.check('no session was written', !existsSync(SESSION_FILE))
    await section.locator('[data-antasphere-dismiss]').click()
    await until(async () => (await section.locator('[data-antasphere-failure]').count()) === 0)

    // ── A cancel while the issuer is slow ────────────────────────────────
    // The sign-in's answer waits on discovery (2.5 s here): Cancel must be
    // usable meanwhile, the cancel must settle, no page may open, and the
    // late answer must not put "signing in" back.
    provider.state.discoveryDelayMs = 2500
    const openedBefore = (await opened()).length
    await signInButton.click()
    await waitPhase(section, 'signing-in')
    const cancelButton = section.locator('[data-antasphere-cancel]')
    await cancelButton.waitFor()
    t.check(
      'Cancel is enabled while the sign-in waits on the issuer',
      await cancelButton.isEnabled()
    )
    await cancelButton.click()
    t.equal('the cancel settles at once', await waitPhase(section, 'signed-out'), 'signed-out')
    t.equal(
      'as cancelled',
      await section.locator('[data-antasphere-failure="cancelled"]').count(),
      1
    )
    await win.waitForTimeout(3500)
    t.equal('the late answer changes nothing on screen', await phaseOf(section), 'signed-out')
    t.equal('and opened no page', (await opened()).length, openedBefore)
    const afterLate = await rendererStatus(win)
    t.check(
      'the status agrees: signed out, cancelled',
      afterLate.phase === 'signed-out' && afterLate.lastFailure === 'cancelled',
      afterLate
    )
    provider.state.discoveryDelayMs = 0
    await section.locator('[data-antasphere-dismiss]').click()
    await until(async () => (await section.locator('[data-antasphere-failure]').count()) === 0)

    // ── A login that lands ───────────────────────────────────────────────
    await signInButton.click()
    await waitPhase(section, 'signing-in')
    const urls2 = await until(async () => {
      const u = await opened()
      return u.length > openedBefore ? u : null
    })
    t.check('the second login asks the browser again', urls2?.length === openedBefore + 1)
    t.check(
      'with a fresh state',
      new URL(urls2.at(-1)).searchParams.get('state') !== q.get('state')
    )
    const { response } = await provider.browse(urls2.at(-1))
    t.equal('the loopback callback answers the browser', response.status, 200)
    const callbackPage = await response.text()
    t.check(
      'the callback page sends the user back and claims no sign-in',
      callbackPage.includes('Go back to Clave') && !/signed in/i.test(callbackPage),
      callbackPage
    )
    t.equal('the app is signed in', await waitPhase(section, 'signed-in'), 'signed-in')
    t.equal(
      'the name is shown',
      (await section.locator('[data-antasphere-name]').textContent()).trim(),
      'E2E Person'
    )
    const email = await section.locator('[data-antasphere-email]').textContent()
    t.check(
      'the email is shown, with the issuer',
      email.includes('e2e@example.test') && email.includes('127.0.0.1'),
      email
    )
    t.equal('the provider registered Clave once', provider.state.counts.register, 1)
    t.equal('and exchanged one code', provider.state.counts.token, 1)
    t.check(
      'the browser was opened once for the login that landed, and not for the cancelled ones',
      (await opened()).length === openedBefore + 1,
      (await opened()).length
    )
    t.check(
      'the session is on disk, owner-only',
      existsSync(SESSION_FILE) && (statSync(SESSION_FILE).mode & 0o777) === 0o600
    )
    const sessionText = readFileSync(SESSION_FILE, 'utf-8')
    t.check(
      'and nothing in it is readable: no email, no name, no token',
      !/e2e@example\.test|E2E Person|rt-|at-|refresh/.test(sessionText),
      sessionText.slice(0, 120)
    )
    t.check(
      'the registration is kept beside it, without a secret',
      existsSync(CLIENT_FILE) && !/secret/.test(readFileSync(CLIENT_FILE, 'utf-8'))
    )
    const signed = await rendererStatus(win)
    t.check(
      'the renderer status is the read model and nothing more',
      Object.keys(signed).sort().join() === STATUS_KEYS.join(),
      Object.keys(signed)
    )
    t.check(
      'its account is four fields',
      Object.keys(signed.account ?? {})
        .sort()
        .join() === 'email,emailVerified,name,subject',
      signed.account
    )
    const mainsOwn = await app.evaluate(async () => {
      const settings = globalThis.__claveE2E?.settings
      if (!settings) throw new Error('no settings source: is --test-no-activate on?')
      const status = await settings.antasphere.status()
      return status.phase
    })
    t.equal('in-process, the shell’s own source holds the login', mainsOwn, 'signed-in')
    const bridge = await win.evaluate(() =>
      Object.keys(window.electronAPI)
        .filter((k) => /antasphere/i.test(k))
        .sort()
    )
    t.check(
      'the bridge offers the five status calls and the push, nothing that returns a credential',
      bridge.join() ===
        'antasphereAccountCancel,antasphereAccountDismiss,antasphereAccountGet,antasphereAccountSignIn,antasphereAccountSignOut,onAntasphereAccountChanged',
      bridge
    )

    // ── Restored at the next launch ──────────────────────────────────────
    await app.close()
    ;({ app, win } = await launchApp(DIR, { env, server: 'in-process' }))
    win.on('pageerror', (e) => errors.push(e.message))
    opened = await stubBrowser(app)
    ;({ page, section } = await openAccounts(win))
    t.equal(
      'the login is restored at the next launch',
      await waitPhase(section, 'signed-in'),
      'signed-in'
    )
    t.equal(
      'as the same person',
      (await section.locator('[data-antasphere-name]').textContent()).trim(),
      'E2E Person'
    )
    t.equal('without a new registration', provider.state.counts.register, 1)
    t.equal('without a new code exchange', provider.state.counts.token, 1)
    t.equal('without asking the browser', (await opened()).length, 0)

    // ── Signed out, locally ──────────────────────────────────────────────
    const before = { ...provider.state.counts }
    await section.locator('[data-antasphere-sign-out]').click()
    t.equal('sign out: signed out', await waitPhase(section, 'signed-out'), 'signed-out')
    t.check('the session file is gone', !existsSync(SESSION_FILE))
    t.check('the registration stays for the next sign-in', existsSync(CLIENT_FILE))
    t.check(
      'the issuer heard nothing of it',
      JSON.stringify(provider.state.counts) === JSON.stringify(before),
      provider.state.counts
    )
    const out = await rendererStatus(win)
    t.check(
      'the status says signed out with no account',
      out.phase === 'signed-out' && out.account === null,
      out
    )
    await app.close()
    ;({ app, win } = await launchApp(DIR, { env, server: 'in-process' }))
    win.on('pageerror', (e) => errors.push(e.message))
    await stubBrowser(app)
    ;({ section } = await openAccounts(win))
    await until(async () => (await phaseOf(section)) !== null)
    t.equal('and stays signed out at the next launch', await phaseOf(section), 'signed-out')

    // ── A lapse the window hears, and the renewal that lands after it ────
    // An issuer whose tokens last three seconds and whose refresh grant
    // takes six: the window shows "expired" at the end, with nobody reading,
    // and signed in again once the renewal lands.
    await app.close()
    const brief = await startOidcProvider({
      user: {
        sub: 'e2e-user-1',
        name: 'E2E Person',
        email: 'e2e@example.test',
        email_verified: true
      },
      idTokenTtlSec: 3,
      accessTokenTtlSec: 3
    })
    brief.state.refreshDelayMs = 6000
    try {
      rmSync(SESSION_FILE, { force: true })
      ;({ app, win } = await launchApp(DIR, {
        env: { CLAVE_ANTASPHERE_ISSUER: brief.issuer },
        server: 'in-process'
      }))
      win.on('pageerror', (e) => errors.push(e.message))
      opened = await stubBrowser(app)
      ;({ section } = await openAccounts(win))
      await until(async () => (await phaseOf(section)) === 'signed-out')
      await section.getByRole('button', { name: 'Sign in with Antasphere', exact: true }).click()
      const briefUrls = await until(async () => {
        const u = await opened()
        return u.length ? u : null
      })
      await brief.browse(briefUrls[0])
      t.equal('brief issuer: signed in', await waitPhase(section, 'signed-in'), 'signed-in')
      const lapsed = await until(
        async () => (await section.locator('[data-antasphere-failure="expired"]').count()) === 1,
        { tries: 40, gapMs: 250 }
      )
      t.check('the window hears the lapse while the renewal is still pending', lapsed === true)
      t.equal('and reads signed out meanwhile', await phaseOf(section), 'signed-out')
      t.check('the renewal was asked for', brief.state.counts.refresh >= 1, brief.state.counts)
      const recovered = await until(async () => (await phaseOf(section)) === 'signed-in', {
        tries: 60,
        gapMs: 250
      })
      // `until` answers the predicate's own value, true, not the phase.
      t.check('and signed in again once the renewal lands', recovered === true)
      t.equal(
        'as the same person',
        (await section.locator('[data-antasphere-name]').textContent()).trim(),
        'E2E Person'
      )
    } finally {
      await brief.close()
    }
    t.equal('no renderer errors', errors.length, 0, errors)
  } finally {
    await app.close()
    await provider.close()
  }
}
