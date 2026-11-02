// The Antasphere account (PRDCT-3259) with the app on a SEPARATE server, the
// packaged default on macOS since 3.0.0 (wave 5, PRDCT-3434): the app starts
// the standalone entry as a child of its own and attaches to it, and the login
// is that child's. The installed 3.0.0-beta.8 never opened the browser on this
// path (2 November 2026, the clave record's workstream
// 2026-11-02-antasphere-login-separate-server): the shell built an account
// manager of its own whenever the environment did not attach it, asked that
// idle manager to confirm the handoff the SERVER had issued right before the
// open, and refused its own open; the server waited five minutes for a
// callback and reported `timeout`. Proven here through the real app, the way
// `antasphere-account-attached.spec.mjs` proves the attached mode: Settings →
// Accounts, `shell.openExternal` stood in, a signed local provider as the
// issuer, the child server's own HTTP API as the witness, a user-data folder
// and a keychain FILE of the run's own (never a personal keychain):
//
//  1. The shell holds no account manager: its own settings source refuses the
//     read, as attached (the first line to go red on the old code).
//  2. The browser is opened once, at the local issuer, on the handoff the
//     child server answered (the second); the callback signs the app in, the
//     server's query agrees, the session is sealed in the SERVER's data
//     directory (`<user data>/server`) and its keychain file, nothing under
//     the app's own user data.
//  3. The protections hold with no shell manager: a cancelled login's link
//     lands on nothing, a cancel while the issuer is slow settles and opens
//     nothing, and the server says cancelled both times.
//  4. Restored at the next launch of the app, whose child starts again on the
//     same folder, without the browser; signed out, the file and the keychain
//     item are gone.
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import {
  launchApp,
  seedWorkspaces,
  separateServerDataDir,
  serverEndpoint,
  userDataDir,
  fixturePath,
  until
} from './harness.mjs'
import { startOidcProvider } from './fixtures/oidc-provider.mjs'
import { runKeychain } from './fixtures/run-keychain.mjs'

const DIR = userDataDir('antasphere-account-separate')
const ROOT = fixturePath('antasphere-account-separate-root')
const keychain = runKeychain(fixturePath('antasphere-account-separate-keychain/e2e.keychain-db'))
const WS = {
  id: 'antasphere-separate-ws',
  name: 'Antasphere separate',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}
const SESSION = 'antasphere-account-session.json'
const CLIENT = 'antasphere-account-client.json'

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
const filesNamed = (dir, name) =>
  existsSync(dir) ? readdirSync(dir).filter((f) => f === name).length : 0
/** What main's own settings source says of the account: the status, or the
 *  refusal's tag and capability. */
const mainsOwn = (app) =>
  app.evaluate(async () => {
    const settings = globalThis.__claveE2E?.settings
    if (!settings) throw new Error('no settings source: is --test-no-activate on?')
    try {
      const status = await settings.antasphere.status()
      return `answered:${status.phase}`
    } catch (err) {
      return `${err?._tag ?? ''}:${err?.capability ?? ''}`
    }
  })

export async function run(t) {
  rmSync(DIR, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  keychain.create()
  const provider = await startOidcProvider({
    registrationStatus: 200,
    user: {
      sub: 'e2e-separate-1',
      name: 'Séparée Person',
      email: 'separee@example.test',
      email_verified: true
    }
  })
  // The issuer and the keychain file reach the child through the app's own
  // environment (`server-child.ts` starts it from the shell's): the server
  // owns the login, the shell reads the issuer for its check of what it opens.
  const env = { CLAVE_ANTASPHERE_ISSUER: provider.issuer, CLAVE_KEYCHAIN_FILE: keychain.file }
  // The child server's HTTP API, read off the app's discovery file at each
  // call: a relaunch starts a new child on a new port.
  const api = async (p) => {
    const disc = serverEndpoint(DIR)
    const res = await fetch(disc.url + p, { headers: { authorization: `Bearer ${disc.token}` } })
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null }
  }
  const serverStatus = async () => (await api('/accounts/antasphere')).body
  const serverDir = separateServerDataDir(DIR)
  const serverFile = path.join(serverDir, SESSION)
  const errors = []
  let { app, win } = await launchApp(DIR, { env, server: 'separate' })
  win.on('pageerror', (e) => errors.push(e.message))
  try {
    const disc = serverEndpoint(DIR)
    t.equal('the app runs on a separate server, a child of its own', disc?.mode, 'separate')
    t.equal(
      'the child server answers the account status behind its bearer',
      (await api('/accounts/antasphere')).status,
      200
    )
    t.equal(
      'the shell holds no account of its own on a separate server: its source refuses the read',
      await mainsOwn(app),
      'CapabilityUnavailable:antasphereAccount'
    )
    let opened = await stubBrowser(app)
    let { section } = await openAccounts(win)
    await until(async () => (await phaseOf(section)) !== null)
    t.equal('signed out at first', await phaseOf(section), 'signed-out')

    // ── A login that lands, through the child server ─────────────────────
    const signInButton = section.getByRole('button', {
      name: 'Sign in with Antasphere',
      exact: true
    })
    await until(async () => !(await signInButton.isDisabled()))
    await signInButton.click()
    t.equal('signing in', await waitPhase(section, 'signing-in'), 'signing-in')
    const urls = await until(async () => {
      const u = await opened()
      return u.length ? u : null
    })
    t.check(
      'the shell opened the browser once, at the local issuer, on the handoff the child server answered',
      urls?.length === 1 && urls[0].startsWith(`${provider.issuer}/authorize?`),
      urls
    )
    if (!urls) {
      // The fault's own shape: the server holds the login and waits for a
      // callback no browser was sent to. Nothing below can be proven.
      t.check(
        'the child server was left waiting for a browser that never opened',
        false,
        await serverStatus()
      )
      return
    }
    const inFlight = await rendererStatus(win)
    t.check(
      'the renderer sees the login in flight and nothing of the request',
      inFlight.phase === 'signing-in' &&
        !/http|code_|state=|nonce|token/.test(JSON.stringify(inFlight)),
      inFlight
    )
    const { response } = await provider.browse(urls[0])
    t.equal('the child server’s loopback callback answers the browser', response.status, 200)
    t.equal('the app is signed in', await waitPhase(section, 'signed-in'), 'signed-in')
    t.equal(
      'the name is shown, Unicode intact',
      (await section.locator('[data-antasphere-name]').textContent()).trim(),
      'Séparée Person'
    )
    const onServer = await serverStatus()
    t.check(
      'the child server’s query agrees: signed in as the same person',
      onServer.phase === 'signed-in' && onServer.account?.email === 'separee@example.test',
      onServer
    )
    t.equal('the provider registered Clave once', provider.state.counts.register, 1)
    t.equal('and exchanged one code', provider.state.counts.token, 1)
    t.check(
      'the session is sealed in the SERVER’s data directory, owner-only',
      existsSync(serverFile) && (statSync(serverFile).mode & 0o777) === 0o600,
      serverFile
    )
    t.equal('and nowhere under the app’s own user data', filesNamed(DIR, SESSION), 0)
    t.equal('the registration is the server’s too', filesNamed(serverDir, CLIENT), 1)
    t.equal('and not the app’s', filesNamed(DIR, CLIENT), 0)
    t.equal('one item in the run’s keychain file', keychain.items(), 1)
    t.equal(
      'the shell still holds no account of its own once the login landed',
      await mainsOwn(app),
      'CapabilityUnavailable:antasphereAccount'
    )

    // ── A login cancelled: its link lands on nothing ──────────────────────
    await section.locator('[data-antasphere-sign-out]').click()
    t.equal('sign out: signed out', await waitPhase(section, 'signed-out'), 'signed-out')
    t.check('the server’s session file is gone', !existsSync(serverFile))
    t.equal('and the keychain file holds no item', keychain.items(), 0)
    const before1 = (await opened()).length
    await signInButton.click()
    await waitPhase(section, 'signing-in')
    const urls2 = await until(async () => {
      const u = await opened()
      return u.length > before1 ? u : null
    })
    t.check('the second login asks the browser again', urls2?.length === before1 + 1, urls2)
    t.check(
      'with a fresh state',
      new URL(urls2.at(-1)).searchParams.get('state') !== new URL(urls[0]).searchParams.get('state')
    )
    await section.locator('[data-antasphere-cancel]').click()
    t.equal('cancel: signed out', await waitPhase(section, 'signed-out'), 'signed-out')
    t.equal(
      'with the reason shown',
      await section.locator('[data-antasphere-failure="cancelled"]').count(),
      1
    )
    const stale = await provider.browse(urls2.at(-1)).then(
      (r) => `callback answered ${r.response.status}`,
      (e) => e
    )
    t.check('the cancelled login’s link lands on nothing', stale instanceof Error, String(stale))
    t.equal('and the app stays signed out', await phaseOf(section), 'signed-out')
    t.equal('the server says cancelled too', (await serverStatus()).lastFailure, 'cancelled')
    await section.locator('[data-antasphere-dismiss]').click()
    await until(async () => (await section.locator('[data-antasphere-failure]').count()) === 0)

    // ── A cancel while the issuer is slow ────────────────────────────────
    // The sign-in's answer waits on discovery (2.5 s here): Cancel must stay
    // usable, the cancel must settle, no page may open, and the late answer
    // must change nothing, with the server's confirmation as the last word.
    provider.state.discoveryDelayMs = 2500
    const before2 = (await opened()).length
    await signInButton.click()
    await waitPhase(section, 'signing-in')
    const cancelButton = section.locator('[data-antasphere-cancel]')
    await cancelButton.waitFor()
    t.check(
      'Cancel is enabled while the server waits on the issuer',
      await cancelButton.isEnabled()
    )
    await cancelButton.click()
    t.equal('the cancel settles at once', await waitPhase(section, 'signed-out'), 'signed-out')
    await win.waitForTimeout(3500)
    t.equal('the late answer opened no page', (await opened()).length, before2)
    t.equal('and the screen stays cancelled', await phaseOf(section), 'signed-out')
    t.equal('the server says the same', (await serverStatus()).lastFailure, 'cancelled')
    provider.state.discoveryDelayMs = 0
    await section.locator('[data-antasphere-dismiss]').click()
    await until(async () => (await section.locator('[data-antasphere-failure]').count()) === 0)

    // ── Restored at the next launch, the child started again on its folder ─
    await signInButton.click()
    const urls3 = await until(async () => {
      const u = await opened()
      return u.length > before2 ? u : null
    })
    await provider.browse(urls3.at(-1))
    t.equal('signed in again', await waitPhase(section, 'signed-in'), 'signed-in')
    const counts = { ...provider.state.counts }
    await app.close()
    ;({ app, win } = await launchApp(DIR, { env, server: 'separate' }))
    win.on('pageerror', (e) => errors.push(e.message))
    opened = await stubBrowser(app)
    ;({ section } = await openAccounts(win))
    t.equal(
      'the login is there at the next launch: the child on the same folder kept it',
      await waitPhase(section, 'signed-in'),
      'signed-in'
    )
    t.equal(
      'as the same person',
      (await section.locator('[data-antasphere-name]').textContent()).trim(),
      'Séparée Person'
    )
    t.equal('without asking the browser', (await opened()).length, 0)
    t.equal('without a new code exchange', provider.state.counts.token, counts.token)
    t.equal('without a new registration', provider.state.counts.register, counts.register)
    t.equal('and nothing under the app’s own user data', filesNamed(DIR, SESSION), 0)
    t.equal(
      'the relaunched shell holds no account of its own either',
      await mainsOwn(app),
      'CapabilityUnavailable:antasphereAccount'
    )

    // ── Signed out: the server’s file and keychain item go ───────────────
    await section.locator('[data-antasphere-sign-out]').click()
    t.equal('sign out', await waitPhase(section, 'signed-out'), 'signed-out')
    t.check('the server’s session file is gone', !existsSync(serverFile))
    t.equal('and the keychain file holds no item', keychain.items(), 0)
    t.equal('the server agrees', (await serverStatus()).phase, 'signed-out')
    t.equal('no renderer errors', errors.length, 0, errors)
  } finally {
    await app.close()
    await provider.close()
    keychain.remove()
  }
}
