/**
 * The triage bundle on disk (issue #227): `<userData>/triage/<stamp>/` with
 * the snapshot, the context file and the prompt. Private and local: the
 * folders are 0700, the files 0600, and nothing here follows a symbolic
 * link. The `triage` folder must be a real directory, each bundle folder is
 * created new (never reused), and each file is opened exclusively with
 * O_NOFOLLOW, so a link planted at any of those names makes the write fail
 * instead of landing somewhere else. Bundles are kept: there is no cleanup
 * pass, which would be a deletion walking user data.
 */
import * as fs from 'fs'
import * as path from 'path'
import type { TriageBundle } from '../../shared/triage'

export const TRIAGE_FOLDER = 'triage'

/** `2026-10-21T12-34-56-789Z`: an ISO time a file name can carry. */
export function bundleStamp(date: Date): string {
  return date.toISOString().replace(/:/g, '-').replace('.', '-')
}

/** Make `dir` exist as a real 0700 directory, refusing a link or a file. */
function ensurePrivateDir(dir: string): void {
  let stat: fs.Stats | null = null
  try {
    stat = fs.lstatSync(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (stat) {
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error(`${dir} is not a plain directory; the triage bundle is not written there`)
    fs.chmodSync(dir, 0o700)
    return
  }
  fs.mkdirSync(dir, { mode: 0o700 })
  fs.chmodSync(dir, 0o700)
}

/** Create a NEW directory under `parent`, `base` or `base-1`…: never one that exists. */
function createFreshDir(parent: string, base: string): string {
  for (let i = 0; i < 100; i++) {
    const dir = path.join(parent, i === 0 ? base : `${base}-${i}`)
    try {
      fs.mkdirSync(dir, { mode: 0o700 })
      fs.chmodSync(dir, 0o700)
      return dir
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  throw new Error(`could not create a new triage folder under ${parent}`)
}

/** Write a new 0600 file, failing if anything (a link included) is there. */
function writePrivateFile(file: string, content: string): void {
  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    (fs.constants.O_NOFOLLOW ?? 0)
  const fd = fs.openSync(file, flags, 0o600)
  try {
    fs.fchmodSync(fd, 0o600)
    fs.writeSync(fd, content)
  } finally {
    fs.closeSync(fd)
  }
}

export interface BundleContents {
  snapshot: string
  /** Renders the context file, told where the snapshot is. */
  context: (snapshotPath: string) => string
  /** Renders the prompt file, told where the context and snapshot are. */
  prompt: (contextPath: string, snapshotPath: string) => string
}

/** Write a bundle; answers its paths and the context text actually written.
 *  Throws (the caller reports it) when the folder cannot be made private. */
export function writeBundle(
  userData: string,
  date: Date,
  contents: BundleContents
): { bundle: TriageBundle; context: string } {
  const root = path.join(userData, TRIAGE_FOLDER)
  ensurePrivateDir(root)
  const dir = createFreshDir(root, bundleStamp(date))
  const bundle: TriageBundle = {
    dir,
    snapshotPath: path.join(dir, 'snapshot.json'),
    contextPath: path.join(dir, 'context.md'),
    promptPath: path.join(dir, 'prompt.md')
  }
  const context = contents.context(bundle.snapshotPath)
  writePrivateFile(bundle.snapshotPath, contents.snapshot)
  writePrivateFile(bundle.contextPath, context)
  writePrivateFile(bundle.promptPath, contents.prompt(bundle.contextPath, bundle.snapshotPath))
  return { bundle, context }
}
