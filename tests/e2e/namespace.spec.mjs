// The fixture namespace (PRDCT-2615): two runs with two namespaces write to two
// directories, the default is unchanged, and the runner always sets one.
//
// No Electron here: this is the one spec about where the others put their
// files, and it runs in a second.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  NAMESPACE_ENV,
  assertNamespace,
  defaultNamespace,
  fixturePath,
  fixtureRoot,
  namespaceOf
} from './namespace.mjs'
import { killLeakedE2eTmux, tmuxSessionAlive, userDataDir } from './harness.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** One "run": a fresh node process, given a namespace, that builds the path
 *  a spec would build, creates it, writes a marker and prints the path. This
 *  is what two lanes do, minus the app. */
function runWithNamespace(ns, marker) {
  const src = `
    import { mkdirSync, writeFileSync } from 'node:fs'
    import { fixturePath } from ${JSON.stringify(path.join(HERE, 'namespace.mjs'))}
    const p = fixturePath('probe-root')
    mkdirSync(p, { recursive: true })
    writeFileSync(p + '/marker', ${JSON.stringify(marker)})
    process.stdout.write(p)
  `
  return execFileSync(process.execPath, ['--input-type=module', '-e', src], {
    encoding: 'utf-8',
    env: { ...process.env, [NAMESPACE_ENV]: ns }
  })
}

export async function run(t) {
  const nsA = `ns-probe-a-${process.pid}`
  const nsB = `ns-probe-b-${process.pid}`
  try {
    // ── two runs, two namespaces, two directories ──
    const a = runWithNamespace(nsA, 'run A')
    const b = runWithNamespace(nsB, 'run B')
    t.check('two namespaces give two different directories', a !== b, { a, b })
    t.equal('run A wrote under its own namespace', a, `/tmp/${nsA}/clave-e2e-probe-root`)
    t.equal('run B wrote under its own namespace', b, `/tmp/${nsB}/clave-e2e-probe-root`)
    t.check('both directories exist', existsSync(a) && existsSync(b), { a, b })
    t.equal("run A's marker is its own", readFileSync(path.join(a, 'marker'), 'utf-8'), 'run A')
    t.equal("run B's marker is its own", readFileSync(path.join(b, 'marker'), 'utf-8'), 'run B')

    // ── the default is unchanged ──
    t.equal(
      'no namespace: the historical path',
      fixturePath('foot-root', { env: {} }),
      '/tmp/clave-e2e-foot-root'
    )
    t.equal('a blank namespace is no namespace', namespaceOf({ [NAMESPACE_ENV]: '  ' }), null)
    t.equal(
      'the real form resolves /tmp the way git reports it',
      fixturePath('git-root', { real: true, env: { [NAMESPACE_ENV]: nsA } }),
      `${realpathSync('/tmp')}/${nsA}/clave-e2e-git-root`
    )
    t.check(
      'the basename keeps the clave-e2e prefix under a namespace',
      path.basename(fixturePath('x', { env: { [NAMESPACE_ENV]: nsA } })).startsWith('clave-e2e-'),
      fixturePath('x', { env: { [NAMESPACE_ENV]: nsA } })
    )

    // ── a namespace is one segment: it cannot escape /tmp ──
    for (const bad of ['../etc', 'a/b', '..', '', '/abs']) {
      let threw = false
      try {
        assertNamespace(bad)
      } catch {
        threw = true
      }
      t.check(`refuses ${JSON.stringify(bad)} as a namespace`, threw)
    }

    // ── the runner's default: from the worktree, distinct per checkout ──
    const same = defaultNamespace('/x/y/clave-app')
    t.equal('the default is stable for one checkout', defaultNamespace('/x/y/clave-app'), same)
    t.check(
      'two checkouts with the same folder name get different namespaces',
      defaultNamespace('/x/y/clave-app') !== defaultNamespace('/z/clave-app'),
      { same, other: defaultNamespace('/z/clave-app') }
    )
    t.check('the default is a valid namespace', assertNamespace(same) === same, same)

    // ── this very run is namespaced by the runner ──
    const ns = namespaceOf()
    t.check('the runner set a namespace for this run', ns !== null, process.env[NAMESPACE_ENV])
    t.check(
      'and the harness builds every user-data dir under it',
      userDataDir('probe').startsWith(`${fixtureRoot()}/clave-e2e-`),
      { dir: userDataDir('probe'), root: fixtureRoot() }
    )

    // ── the leaked-session cleanup stays inside its own run ──
    // Two runs at once: each kills what IT leaked and nothing of the other's.
    // The tmux name carries the cwd's basename, not the namespace, so the
    // start path is what scopes it. Real sessions on the app's own socket,
    // named for fixture roots, started under the two probe namespaces above.
    const sA = `clave-e2e-probe-a-${process.pid}`
    const sB = `clave-e2e-probe-b-${process.pid}`
    const tmux = (...args) => execFileSync('tmux', ['-L', 'clave', ...args], { stdio: 'ignore' })
    const startBoth = () => {
      tmux('new-session', '-d', '-s', sA, '-c', a, 'sleep', '60')
      tmux('new-session', '-d', '-s', sB, '-c', b, 'sleep', '60')
    }
    try {
      startBoth()
      t.check('two fixture sessions are alive', tmuxSessionAlive(sA) && tmuxSessionAlive(sB))
      killLeakedE2eTmux({ env: { [NAMESPACE_ENV]: nsA } })
      t.check("cleanup under namespace A kills A's session", !tmuxSessionAlive(sA))
      t.check("and leaves B's alive", tmuxSessionAlive(sB))
      killLeakedE2eTmux({ env: { [NAMESPACE_ENV]: nsB } })
      t.check("cleanup under namespace B kills B's", !tmuxSessionAlive(sB))
      startBoth()
      killLeakedE2eTmux({ env: {} })
      t.check(
        'without a namespace the cleanup takes every fixture session, as before',
        !tmuxSessionAlive(sA) && !tmuxSessionAlive(sB)
      )
    } finally {
      for (const n of [sA, sB]) {
        try {
          tmux('kill-session', '-t', `=${n}`)
        } catch {
          // already gone
        }
      }
    }
  } finally {
    rmSync(`/tmp/${nsA}`, { recursive: true, force: true })
    rmSync(`/tmp/${nsB}`, { recursive: true, force: true })
  }
  // Silence the linter about the imports a future check may want.
  void mkdirSync
  void writeFileSync
}
