// The fixture namespace: where a run of the end-to-end suite keeps its files.
//
// Every spec seeds a user-data directory and a few fixture folders (a workspace
// root, a transcripts folder, a fake binary on the PATH) under /tmp, by fixed
// name. Two worktrees running the suite at the same time — what a wave of
// lanes does — therefore wrote into each other's folders (PRDCT-2615: a chat
// spec failed on a root another lane had just emptied). This module is the one
// place a fixture path is built: every path lives under /tmp/<namespace>/ and
// keeps its name. The namespace is CLAVE_E2E_NS when set, and otherwise the
// checkout's own (defaultNamespace), so there is no mode in which a run's
// fixtures, or its tmux cleanup, reach into /tmp at large: an un-namespaced
// mode was exactly what let one run's cleanup kill another run's live tabs.
//
// The namespace is the unit of isolation: one run per namespace at a time.
// Two runs from one checkout share its default and sweep each other's
// sessions, so give each its own: `CLAVE_E2E_NS=<name> node tests/e2e/run.mjs`.
//
// No import from harness.mjs here, on purpose: the harness pulls in
// playwright-core, and this module is what a plain node test can exercise.
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The environment variable a run reads its namespace from. */
export const NAMESPACE_ENV = 'CLAVE_E2E_NS'

const TMP = '/tmp'
// On macOS /tmp is a symlink to /private/tmp, and git reports the real path:
// a repo root that disagrees with the discovered path makes every repo look
// nested (git-batch-progress, side-panel). `real: true` builds on that form.
const REAL_TMP = (() => {
  try {
    return realpathSync(TMP)
  } catch {
    return TMP
  }
})()

/** A namespace is one path segment: never a slash, never `.` or `..`, so a
 *  value can only ever land INSIDE /tmp. Anything else is refused loudly
 *  rather than silently written somewhere surprising. */
export function assertNamespace(value) {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) ||
    value === '.' ||
    value === '..'
  )
    throw new Error(
      `${NAMESPACE_ENV} must be one path segment (letters, digits, . _ -), got ${JSON.stringify(value)}`
    )
  return value
}

/** The checkout these specs belong to: tests/e2e/../.. */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The namespace in force: the variable when set, else this checkout's. */
export function namespaceOf(env = process.env) {
  const raw = env[NAMESPACE_ENV]
  if (raw === undefined || raw.trim() === '') return defaultNamespace(REPO)
  return assertNamespace(raw.trim())
}

/** The directory every fixture of this run lives under: /tmp/<namespace>.
 *  `real` gives the resolved form (/private/tmp on macOS). */
export function fixtureRoot({ real = false, env = process.env } = {}) {
  return `${real ? REAL_TMP : TMP}/${namespaceOf(env)}`
}

/** A fixture path: `<root>/clave-e2e-<name>`. The `clave-e2e-` prefix is kept
 *  on the basename whatever the namespace, because the leaked-tmux cleanup in
 *  harness.mjs recognises the harness's own sessions by it (tmux names a
 *  session after the basename of its cwd). */
export function fixturePath(name, opts = {}) {
  return `${fixtureRoot(opts)}/clave-e2e-${name}`
}

/** A tmux session name a spec creates itself, as the app would have (a
 *  survivor to adopt, a marker to follow): `clave-e2e-<name>-<hash>`. The
 *  hash is six hex of the namespace, so two runs at once never ask tmux for
 *  the same name (`duplicate session`), and the name stays inside what
 *  the app accepts as its own, `clave-[A-Za-z0-9_-]+`. */
export function fixtureTmuxName(name, { env = process.env } = {}) {
  const hash = createHash('sha1').update(namespaceOf(env)).digest('hex').slice(0, 6)
  return `clave-e2e-${name}-${hash}`
}

/** The namespace used when none is given: the checkout's folder
 *  name, then six hex of a hash of its full path. The hash is there because two
 *  clones with the same folder name (`clave-app` twice on one machine) would
 *  otherwise share a folder — exactly the collision the namespace removes. */
export function defaultNamespace(repo) {
  const full = path.resolve(repo)
  const base = path
    .basename(full)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
  const hash = createHash('sha1').update(full).digest('hex').slice(0, 6)
  return `clave-e2e-${base || 'repo'}-${hash}`
}
