// The workspace files served by a standalone server (wave 3, lane A,
// PRDCT-3291). Whatever the suite's mode, this spec attaches the app to a
// server of its own and proves, through that server's HTTP API and the
// window, never through a hook inside main:
//
//  1. A `.clave` the window reads is read by the standalone server: the
//     server's own trust store (its `--data-dir`) decides, and a trusted root
//     the harness seeded there makes an elevated file open whole with no
//     dialog.
//  2. The review is a round trip: an elevated file OUTSIDE the trusted root
//     raises the shell's dialog (stubbed in main, where the dialog stays), and
//     the answer the stub gives reaches the server, which answers the read as
//     the answer says ("Open safely" strips the prompt; a ticked checkbox
//     trusts the folder on the SERVER, visible on its API).
//  3. A watched file's change on disk reaches the window over the push
//     channel, once.
//  4. Main's own trust store never saw the folder the window trusted: an
//     attached window's trust is the server's.
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  fixturePath,
  until
} from './harness.mjs'

const DIR = userDataDir('workspace-files-attached')
const ROOT = fixturePath('wsf-attached-root')
const OUTSIDE = fixturePath('wsf-attached-outside')
const TRUSTED = `${ROOT}/trusted.clave`
const UNTRUSTED = `${OUTSIDE}/untrusted.clave`
const WATCHED = `${ROOT}/watched.clave`
const PROMPT = 'WSF-ATTACHED-BRIEF drive the lane'
const WS = { id: 'wsf-ws', name: 'Attached', rootDir: ROOT, profileFile: null, createdAt: 1 }

const clave = (name, prompt) =>
  JSON.stringify({
    $schema: 'clave/1.0',
    name,
    cwd: '.',
    ...(prompt ? { prompt } : {}),
    sessions: [
      {
        cwd: '.',
        name: 'tab',
        claudeMode: true,
        antigravityMode: false,
        codexMode: false,
        dangerousMode: false
      }
    ],
    terminals: []
  })

export async function run(t) {
  rmSync(DIR, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
  mkdirSync(OUTSIDE, { recursive: true })
  writeFileSync(TRUSTED, clave('Trusted Lane', PROMPT))
  writeFileSync(UNTRUSTED, clave('Untrusted Lane', PROMPT))
  writeFileSync(WATCHED, clave('Watched Before'))
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  // The trusted root is seeded in the app's data folder; the harness copies
  // the seeded documents into the attached server's data directory, where
  // the server's trust store lives (lane C's seeding mechanism).
  seedTrustedRoots(DIR, [ROOT])

  const { app, win, server } = await launchApp(DIR, { server: 'attached' })
  try {
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

    // ── 1. the server's trust store decides ──
    // The server keeps a root by its REAL path (symlinks resolved, so a path
    // trick cannot defeat the trust check); the fixture folder lives under
    // /tmp, a symlink to /private/tmp on macOS.
    const real = (p) => realpathSync(p)
    const roots = await api('/workspace-files/trust/roots')
    t.equal('the standalone server serves the trusted roots', roots.status, 200)
    t.check(
      'and the seeded root is among them',
      Array.isArray(roots.body) && roots.body.includes(real(ROOT)),
      roots.body
    )

    await app.evaluate(({ dialog }) => {
      globalThis.__e2eReviewCalls = []
      dialog.showMessageBox = async (_win, opts) => {
        globalThis.__e2eReviewCalls.push({
          message: opts?.message ?? '',
          detail: opts?.detail ?? ''
        })
        return {
          response: globalThis.__e2eReviewAnswer?.response ?? 2,
          checkboxChecked: globalThis.__e2eReviewAnswer?.checkboxChecked ?? false
        }
      }
    })
    const read = (p) =>
      win.evaluate(async (file) => {
        const r = await window.electronAPI.readClaveFile(file, file.replace(/\/[^/]+$/, ''))
        return r ? { name: r.name ?? null, prompt: r.prompt ?? null } : null
      }, p)
    const dialogs = () => app.evaluate(() => globalThis.__e2eReviewCalls ?? [])

    const trusted = await read(TRUSTED)
    t.equal('a file under the server’s trusted root opens whole', trusted?.prompt ?? null, PROMPT)
    t.equal('with no dialog', (await dialogs()).length, 0)
    const shownSoFar = (await dialogs()).length

    // ── 2. the review round trip ──
    await app.evaluate(() => {
      globalThis.__e2eReviewAnswer = { response: 0, checkboxChecked: false }
    })
    const safe = await read(UNTRUSTED)
    const shown = (await dialogs()).slice(shownSoFar)
    t.check(
      'an elevated file outside the root raises the shell’s dialog',
      shown.length === 1 && shown[0].message.includes('untrusted.clave'),
      shown
    )
    t.check(
      'the dialog names the prompt the server disclosed',
      shown.some((d) => `${d.message}${d.detail}`.includes(PROMPT)),
      shown
    )
    t.equal(
      '"Open safely" reaches the server: the file comes back with no prompt',
      safe?.prompt ?? null,
      null
    )
    t.equal('while keeping the harmless parts', safe?.name, 'Untrusted Lane')

    await app.evaluate(() => {
      globalThis.__e2eReviewAnswer = { response: 0, checkboxChecked: true }
    })
    const nowTrusted = await read(UNTRUSTED)
    t.equal('a ticked folder checkbox returns the file whole', nowTrusted?.prompt ?? null, PROMPT)
    const rootsAfter = await api('/workspace-files/trust/roots')
    t.check(
      'and the folder is trusted on the SERVER, visible on its API',
      Array.isArray(rootsAfter.body) && rootsAfter.body.includes(real(OUTSIDE)),
      rootsAfter.body
    )
    await app.evaluate(() => {
      globalThis.__e2eReviewAnswer = { response: 2, checkboxChecked: false }
    })
    const before = (await dialogs()).length
    const again = await read(UNTRUSTED)
    t.equal('the trust persists: no dialog on the next read', (await dialogs()).length, before)
    t.equal('and the file comes back whole', again?.prompt ?? null, PROMPT)

    // ── 3. a watched file's change reaches the window over the push channel ──
    await win.evaluate(async (file) => {
      window.__wsfChanges = []
      window.__wsfOff = window.electronAPI.onClaveFileChanged((p) => window.__wsfChanges.push(p))
      await window.electronAPI.watchClaveFile(file)
    }, WATCHED)
    await win.waitForTimeout(500)
    writeFileSync(WATCHED, clave('Watched After'))
    const heard = await until(
      async () => {
        const changes = await win.evaluate(() => window.__wsfChanges)
        return changes.length > 0 ? changes : null
      },
      { tries: 40, gapMs: 250 }
    )
    t.check('the change reached the window', Array.isArray(heard) && heard.includes(WATCHED), heard)
    await win.waitForTimeout(1500)
    const all = await win.evaluate(() => window.__wsfChanges)
    t.equal('exactly once', all.filter((p) => p === WATCHED).length, 1)
    await win.evaluate(async (file) => {
      await window.electronAPI.unwatchClaveFile(file)
      window.__wsfOff()
    }, WATCHED)

    // ── 4. main's own trust store never saw the window's trust ──
    const mainsRoots = path.join(DIR, 'clave-trusted-roots.json')
    const mains = existsSync(mainsRoots) ? JSON.parse(readFileSync(mainsRoots, 'utf-8')) : []
    t.check(
      "main's own trust store never saw the folder the window trusted",
      !mains.includes(OUTSIDE),
      mains
    )
  } finally {
    await app.close()
  }
}
