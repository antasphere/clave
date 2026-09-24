/**
 * The `.clave` TRUST BOUNDARY, end to end.
 *
 * `clave-trust-boundary.test.ts` covers the two pure functions that decide what
 * the review dialog discloses and what "Open safely" strips. Those only matter
 * if something actually calls them, and that decision — is this file under a
 * trusted root, is its content elevated, what did the user answer — lives in the
 * read handler and was entirely unasserted. Making `isUnderTrustedRoot` always
 * return true left every gate green while an untrusted file ran fully elevated
 * with no dialog at all.
 *
 * So this spec asserts the WIRING, not the logic: that an untrusted file with a
 * group-level prompt raises the dialog, that the dialog names the prompt, and
 * that each answer does what it says.
 *
 * It covers BOTH file shapes on purpose. The pure tests cover single and multi;
 * the wiring was only ever exercised single, and the elevated check reads the
 * two shapes down separate branches — so a multi-group file could walk past the
 * dialog entirely while every gate stayed green. Multi is also the shape the
 * `.clave` files in this workspace are actually written in.
 */
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  stubReviewDialog,
  fixturePath
} from './harness.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'

const DIR = userDataDir('trust-gate')
const ROOT = fixturePath('untrusted-root')
const CLAVE = `${ROOT}/untrusted.clave`
const MULTI = `${ROOT}/untrusted-multi.clave`
const MULTI_PROMPT_A = 'MULTI-BRIEF-A drive the first lane'
const MULTI_PROMPT_B = 'MULTI-BRIEF-B drive the second lane'
const PROMPT = 'UNTRUSTED-BRIEF-MARKER do the thing'
const WS = {
  id: 'dddddddd-0000-4000-8000-00000000000d',
  name: 'Untrusted',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}

/** A group in a multi-group file, each carrying its own elevated prompt. */
function multiGroup(name, prompt) {
  return {
    name,
    cwd: '.',
    prompt,
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
  }
}

/** Read the file through the app, with the review dialog answered for us. */
async function readUnderDialog(win, path) {
  return win.evaluate(async (p) => {
    const r = await window.electronAPI.readClaveFile(p, p.replace(/\/[^/]+$/, ''))
    return r ? { name: r.name ?? null, prompt: r.prompt ?? null } : null
  }, path)
}

export async function run(t) {
  mkdirSync(ROOT, { recursive: true })
  writeFileSync(
    CLAVE,
    JSON.stringify(
      {
        $schema: 'clave/1.0',
        name: 'Untrusted Lane',
        cwd: '.',
        prompt: PROMPT,
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
      },
      null,
      2
    )
  )
  writeFileSync(
    MULTI,
    JSON.stringify(
      {
        $schema: 'clave/1.0',
        groups: [multiGroup('Lane One', MULTI_PROMPT_A), multiGroup('Lane Two', MULTI_PROMPT_B)]
      },
      null,
      2
    )
  )
  // Deliberately NO trusted roots: these files must be treated as untrusted.
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [])

  const { app, win } = await launchApp(DIR)
  try {
    // Answer order matters: "Trust and run" trusts this exact CONTENT for the
    // rest of the run, so it must come last or the later cases never see a
    // dialog at all. (Discovered by this spec failing — the app was right.)

    // ── Cancel (response 2) ──
    let readDialogs = await stubReviewDialog(app, { response: 2 })
    let result = await readUnderDialog(win, CLAVE)
    t.check('an untrusted group prompt raises the review dialog', (await readDialogs()).length > 0)
    t.equal('cancelling refuses the file outright', result, null)

    // ── "Open safely" (response 0) ──
    readDialogs = await stubReviewDialog(app, { response: 0 })
    result = await readUnderDialog(win, CLAVE)
    const dialogs = await readDialogs()
    t.check(
      'the dialog names the prompt it would auto-submit',
      dialogs.some((d) => `${d.message}${d.detail}`.includes(PROMPT)),
      dialogs
    )
    t.check('the file still opens', result !== null, result)
    t.equal('but "Open safely" delivers it with NO prompt', result?.prompt ?? null, null)
    t.equal('while keeping the harmless parts', result?.name, 'Untrusted Lane')

    // ── a MULTI-group file must not walk past the gate ──
    // The elevated check reads single and multi down separate branches; this is
    // the branch the wiring never exercised, and it is the shape real .clave
    // files use.
    readDialogs = await stubReviewDialog(app, { response: 0 })
    const multi = await win.evaluate(async (p) => {
      const r = await window.electronAPI.readClaveFile(p, p.replace(/\/[^/]+$/, ''))
      if (!r || r.type !== 'multi') return { type: r?.type ?? null, prompts: null }
      return { type: r.type, prompts: r.groups.map((g) => g.prompt ?? null) }
    }, MULTI)
    const multiDialogs = await readDialogs()

    t.equal('a multi-group file is read as multi', multi.type, 'multi')
    t.check(
      'an untrusted MULTI-group file raises the dialog too',
      multiDialogs.length > 0,
      multiDialogs
    )
    t.check(
      'and the dialog names EVERY group’s prompt, not just the first',
      multiDialogs.some((d) => {
        const text = `${d.message}${d.detail}`
        return text.includes(MULTI_PROMPT_A) && text.includes(MULTI_PROMPT_B)
      }),
      multiDialogs
    )
    t.check(
      '"Open safely" strips the prompt from every group',
      Array.isArray(multi.prompts) && multi.prompts.every((x) => x === null),
      multi.prompts
    )

    // ── ticking "trust this folder" persists, and returns the file unsanitized ──
    // This writes to clave-trusted-roots.json, so it is the last case: once the
    // root is trusted, nothing below it raises a dialog again this run.
    readDialogs = await stubReviewDialog(app, { response: 0, checkboxChecked: true })
    const trustedNow = await readUnderDialog(win, CLAVE)
    t.check('ticking the folder checkbox still shows that dialog', (await readDialogs()).length > 0)
    t.equal(
      'and folder trust supersedes sanitizing — the prompt is kept',
      trustedNow?.prompt ?? null,
      PROMPT
    )

    readDialogs = await stubReviewDialog(app, { response: 2 })
    const afterTrust = await readUnderDialog(win, CLAVE)
    t.equal('the trust persists — no dialog on the next read', (await readDialogs()).length, 0)
    t.equal('and the file comes back whole', afterTrust?.prompt ?? null, PROMPT)
  } finally {
    await app.close()
  }
}
