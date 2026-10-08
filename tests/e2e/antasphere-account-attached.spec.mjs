// The Antasphere account (PRDCT-3259) with the app ATTACHED to a standalone
// server (ADR 0003): the login is the server's. Whatever the suite's mode,
// this spec starts a server of its own, on its own data directory, with a
// keychain FILE of the run's own (`CLAVE_KEYCHAIN_FILE`, created and deleted
// here) so nothing is ever filed in a personal keychain, and attaches the
// app to it through a small proxy that can hold one answer back. Proven,
// through the server's HTTP API and never through a hook inside main:
//
//  1. The window signs in through the server: the browser is opened by the
//     shell on the handoff the server answered, the session is sealed in
//     the SERVER's data directory and its keychain file, nothing of it is
//     written under the app's user data, and main's own settings source
//     holds no account at all (attached, the shell builds no manager).
//  2. The server's query agrees with the screen at every step.
//  3. The races: a confirmation the server answered `true` whose reply is
//     held while Cancel completes opens no page (the preload's own guard);
//     a sign-in answer held while a newer sign-in lands opens the newer page
//     only; a cancel while the issuer is slow settles, opens nothing, and the
//     late answer changes nothing.
//  4. Restored at the next launch of the app on the same server, without
//     the browser; signed out, the file and the keychain item are gone.
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import {
  closeWindow,
  launchApp,
  openWindow,
  seedWorkspaces,
  startE2eServer,
  userDataDir,
  fixturePath,
  until
} from './harness.mjs'
import { startOidcProvider } from './fixtures/oidc-provider.mjs'

const DIR = userDataDir('antasphere-account-attached')
const ROOT = fixturePath('antasphere-account-attached-root')
const KEYCHAIN = fixturePath('antasphere-account-attached-keychain/e2e.keychain-db')
const WS = {
  id: 'antasphere-attached-ws',
  name: 'Antasphere attached',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}
const SESSION = 'antasphere-account-session.json'
const SECURITY = '/usr/bin/security'
const KEYCHAIN_SERVICE = 'Clave server'

/** A keychain file of this run's own: never in the search list, deleted at the end. */
function createKeychain() {
  rmSync(path.dirname(KEYCHAIN), { recursive: true, force: true })
  mkdirSync(path.dirname(KEYCHAIN), { recursive: true })
  execFileSync(SECURITY, ['create-keychain', '-p', '', KEYCHAIN], { stdio: 'ignore' })
  execFileSync(SECURITY, ['set-keychain-settings', KEYCHAIN], { stdio: 'ignore' })
}
function deleteKeychain() {
  try {
    execFileSync(SECURITY, ['delete-keychain', KEYCHAIN], { stdio: 'ignore' })
  } catch {
    // Never created, or already gone.
  }
  rmSync(path.dirname(KEYCHAIN), { recursive: true, force: true })
}
/** How many items the server filed in the run's keychain (never their values). */
function keychainItems() {
  try {
    const dump = execFileSync(SECURITY, ['dump-keychain', KEYCHAIN], { encoding: 'utf-8' })
    // One `svce` attribute line per item (the label line repeats the service).
    return dump.split('\n').filter((l) => l.includes(`"svce"<blob>="${KEYCHAIN_SERVICE}"`)).length
  } catch {
    return 0
  }
}

/**
 * A proxy in front of the server that can hold one path's answer back for
 * a while: the way a slow network delivers a reply the server computed
 * earlier. Everything else, the push socket's upgrade included, passes as it is.
 */
async function startHoldingProxy(targetUrl) {
  const target = new URL(targetUrl)
  const holds = new Map()
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const upstream = http.request(
        {
          host: target.hostname,
          port: Number(target.port),
          method: req.method,
          path: req.url,
          headers: { ...req.headers, host: target.host }
        },
        (up) => {
          const parts = []
          up.on('data', (c) => parts.push(c))
          up.on('end', () => {
            const key = `${req.method} ${req.url}`
            const hold = holds.get(key) ?? 0
            setTimeout(() => {
              res.writeHead(up.statusCode, up.headers)
              res.end(Buffer.concat(parts))
            }, hold)
          })
        }
      )
      upstream.on('error', () => {
        res.writeHead(502)
        res.end()
      })
      upstream.end(Buffer.concat(chunks))
    })
  })
  server.on('upgrade', (req, socket, head) => {
    const upstream = net.connect(Number(target.port), target.hostname, () => {
      let raw = `${req.method} ${req.url} HTTP/1.1\r\n`
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i]
        const value = name.toLowerCase() === 'host' ? target.host : req.rawHeaders[i + 1]
        raw += `${name}: ${value}\r\n`
      }
      upstream.write(raw + '\r\n')
      if (head.length) upstream.write(head)
      socket.pipe(upstream)
      upstream.pipe(socket)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    /** Hold `METHOD /path` answers back by `ms` (0 releases). */
    hold: (key, ms) => (ms > 0 ? holds.set(key, ms) : holds.delete(key)),
    close: () => new Promise((resolve) => server.close(() => resolve()))
  }
}

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

export async function run(t) {
  rmSync(DIR, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  createKeychain()
  const provider = await startOidcProvider({
    user: {
      sub: 'e2e-attached-1',
      name: 'Zoë Attachée',
      email: 'zoë@example.test',
      email_verified: true
    }
  })
  const issuerEnv = { CLAVE_ANTASPHERE_ISSUER: provider.issuer }
  // The server: the issuer and the keychain file are its; the app gets the
  // issuer too, for the shell's own check of what it opens.
  const server = await startE2eServer('antasphere-account-attached', {
    env: { ...issuerEnv, CLAVE_KEYCHAIN_FILE: KEYCHAIN }
  })
  const proxy = await startHoldingProxy(server.url)
  const attach = { url: proxy.url, token: server.token }
  const api = async (p, init = {}) => {
    const res = await fetch(server.url + p, {
      ...init,
      headers: {
        authorization: `Bearer ${server.token}`,
        ...(init.body ? { 'content-type': 'application/json' } : {})
      }
    })
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null }
  }
  const serverStatus = async () => (await api('/accounts/antasphere')).body
  const errors = []
  let { app, win } = await launchApp(DIR, { env: issuerEnv, server: attach })
  win.on('pageerror', (e) => errors.push(e.message))
  try {
    let opened = await stubBrowser(app)
    let { section } = await openAccounts(win)
    await until(async () => (await phaseOf(section)) !== null)
    t.equal('signed out at first', await phaseOf(section), 'signed-out')
    t.equal(
      'the server answers the status behind the bearer',
      (await api('/accounts/antasphere')).status,
      200
    )
    t.equal('and 401 without it', (await fetch(`${server.url}/accounts/antasphere`)).status, 401)
    const mainsOwn = await app.evaluate(async () => {
      const settings = globalThis.__claveE2E?.settings
      if (!settings) throw new Error('no settings source: is --test-no-activate on?')
      try {
        await settings.antasphere.status()
        return 'answered'
      } catch (err) {
        return `${err?._tag ?? ''}:${err?.capability ?? ''}`
      }
    })
    t.equal(
      'attached, main holds no account of its own: its source refuses the read',
      mainsOwn,
      'CapabilityUnavailable:antasphereAccount'
    )

    // ── A login that lands, through the server ──────────────────────────
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
      'the shell opened the browser once, at the local issuer, on the handoff the server answered',
      urls?.length === 1 && urls[0].startsWith(`${provider.issuer}/authorize?`),
      urls
    )
    const inFlight = await rendererStatus(win)
    t.check(
      'the renderer sees the login in flight and nothing of the request',
      inFlight.phase === 'signing-in' &&
        !/http|code_|state=|nonce|token/.test(JSON.stringify(inFlight)),
      inFlight
    )
    const { response } = await provider.browse(urls[0])
    t.equal('the server’s loopback callback answers the browser', response.status, 200)
    t.equal('the app is signed in', await waitPhase(section, 'signed-in'), 'signed-in')
    t.equal(
      'the name is shown, Unicode intact',
      (await section.locator('[data-antasphere-name]').textContent()).trim(),
      'Zoë Attachée'
    )
    const onServer = await serverStatus()
    t.check(
      'the server’s query agrees: signed in as the same person',
      onServer.phase === 'signed-in' && onServer.account?.email === 'zoë@example.test',
      onServer
    )
    const serverFile = path.join(server.dataDir, SESSION)
    t.check(
      'the session is sealed in the SERVER’s data directory, owner-only',
      existsSync(serverFile) && (statSync(serverFile).mode & 0o777) === 0o600
    )
    t.equal('and nowhere under the app’s user data', filesNamed(DIR, SESSION), 0)
    t.equal(
      'the registration is the server’s too',
      filesNamed(server.dataDir, 'antasphere-account-client.json'),
      1
    )
    t.equal('one item in the run’s keychain file', keychainItems(), 1)

    // ── A confirmation held back while Cancel completes ─────────────────
    // The server computes `true` (the login is in flight), the reply is
    // held 3 s, Cancel lands meanwhile: the page must not open. Removing the
    // preload's guard opens it, and this line goes red.
    await section.locator('[data-antasphere-sign-out]').click()
    await waitPhase(section, 'signed-out')
    proxy.hold('POST /accounts/antasphere/handoff/confirm', 3000)
    const openedBefore = (await opened()).length
    await signInButton.click()
    await waitPhase(section, 'signing-in')
    await win.waitForTimeout(800)
    const cancelButton = section.locator('[data-antasphere-cancel]')
    t.check(
      'Cancel is enabled while the confirmation is on its way',
      await cancelButton.isEnabled()
    )
    await cancelButton.click()
    t.equal('the cancel settles', await waitPhase(section, 'signed-out'), 'signed-out')
    await win.waitForTimeout(3500)
    t.equal(
      'the `true` that arrived after the cancel opened no page',
      (await opened()).length,
      openedBefore
    )
    t.equal('the screen stays signed out', await phaseOf(section), 'signed-out')
    t.equal('and so does the server', (await serverStatus()).phase, 'signed-out')
    proxy.hold('POST /accounts/antasphere/handoff/confirm', 0)
    await section.locator('[data-antasphere-dismiss]').click()

    // ── A sign-in answer held back while another window signs in ───────
    // This window's answer (its handoff) is held 3 s; it cancels, and a
    // second window of the same app signs in meanwhile: only the second
    // window's page opens, once; the held answer, landing after, opens none.
    // The two windows agree through the server's events.
    proxy.hold('POST /accounts/antasphere/sign-in', 3000)
    const before2 = (await opened()).length
    await signInButton.click()
    await waitPhase(section, 'signing-in')
    await win.waitForTimeout(500)
    await section.locator('[data-antasphere-cancel]').click()
    await waitPhase(section, 'signed-out')
    proxy.hold('POST /accounts/antasphere/sign-in', 0)
    const { page: win2 } = await openWindow(app, win)
    win2.on('pageerror', (e) => errors.push(e.message))
    const { section: section2 } = await openAccounts(win2)
    await until(async () => (await phaseOf(section2)) === 'signed-out')
    t.equal(
      'the second window sees the cancel too',
      await section2.locator('[data-antasphere-failure="cancelled"]').count(),
      1
    )
    await section2.getByRole('button', { name: 'Sign in with Antasphere', exact: true }).click()
    const second = await until(async () => {
      const u = await opened()
      return u.length > before2 ? u : null
    })
    t.check('the second window’s sign-in opened its page', second?.length === before2 + 1)
    t.equal(
      'and the first window shows that login too',
      await waitPhase(section, 'signing-in'),
      'signing-in'
    )
    await win.waitForTimeout(3500)
    t.equal(
      'the first window’s held answer, landing after, opened nothing more',
      (await opened()).length,
      before2 + 1
    )
    t.equal('and did not change what it shows', await phaseOf(section), 'signing-in')
    await provider.browse(second.at(-1))
    t.equal('which lands', await waitPhase(section, 'signed-in'), 'signed-in')
    t.equal('in both windows', await waitPhase(section2, 'signed-in'), 'signed-in')
    await closeWindow(app, win2)
    await until(async () => !(await section.locator('[data-antasphere-sign-out]').isDisabled()))

    // ── A cancel while the issuer is slow ────────────────────────────────
    await section.locator('[data-antasphere-sign-out]').click()
    await waitPhase(section, 'signed-out')
    provider.state.discoveryDelayMs = 2500
    const before3 = (await opened()).length
    await signInButton.click()
    await waitPhase(section, 'signing-in')
    await section.locator('[data-antasphere-cancel]').waitFor()
    t.check(
      'Cancel is enabled while the server waits on the issuer',
      await section.locator('[data-antasphere-cancel]').isEnabled()
    )
    await section.locator('[data-antasphere-cancel]').click()
    t.equal('the cancel settles', await waitPhase(section, 'signed-out'), 'signed-out')
    await win.waitForTimeout(3500)
    t.equal('the late answer opened no page', (await opened()).length, before3)
    t.equal('and the screen stays cancelled', await phaseOf(section), 'signed-out')
    t.equal('the server says the same', (await serverStatus()).lastFailure, 'cancelled')
    provider.state.discoveryDelayMs = 0
    await section.locator('[data-antasphere-dismiss]').click()

    // ── Restored at the next launch of the app, on the same server ──────
    await signInButton.click()
    const urls4 = await until(async () => {
      const u = await opened()
      return u.length > before3 ? u : null
    })
    await provider.browse(urls4.at(-1))
    await waitPhase(section, 'signed-in')
    const counts = { ...provider.state.counts }
    await app.close()
    ;({ app, win } = await launchApp(DIR, { env: issuerEnv, server: attach }))
    win.on('pageerror', (e) => errors.push(e.message))
    opened = await stubBrowser(app)
    ;({ section } = await openAccounts(win))
    t.equal(
      'the login is there at the next launch: the server kept it',
      await waitPhase(section, 'signed-in'),
      'signed-in'
    )
    t.equal('without asking the browser', (await opened()).length, 0)
    t.equal('without a new code exchange', provider.state.counts.token, counts.token)
    t.equal('and nothing under the app’s user data', filesNamed(DIR, SESSION), 0)

    // ── Signed out: the server’s file and keychain item go ───────────────
    await section.locator('[data-antasphere-sign-out]').click()
    t.equal('sign out', await waitPhase(section, 'signed-out'), 'signed-out')
    t.check('the server’s session file is gone', !existsSync(serverFile))
    t.equal('and the keychain file holds no item', keychainItems(), 0)
    t.equal('the server agrees', (await serverStatus()).phase, 'signed-out')
    t.equal('no renderer errors', errors.length, 0, errors)
  } finally {
    await app.close()
    await proxy.close()
    await server.stop()
    await provider.close()
    deleteKeychain()
  }
}
