/**
 * The git domain's client (wave wcs1023, lane C, #242): every call of
 * `@clave/contract/git` at exactly one endpoint, the server that holds the
 * checkout. No local fallback on failure: a server that cannot answer is
 * something the panel must hear about.
 */
import type { GitOperations } from '@clave/contract/git'
import type { Call } from './call'

export type GitClient = GitOperations

const flag = (value: boolean): 'true' | 'false' => (value ? 'true' : 'false')

export const gitClient = (call: Call): GitClient => ({
  status: (cwd) => call((c) => c.git.status({ payload: { cwd } })),
  statusBatch: (paths) => call((c) => c.git.statusBatch({ payload: { paths } })),
  // A GET carries its flags and numbers as strings (the contract decodes them).
  discover: (cwd, force) =>
    call((c) =>
      c.git.discover({ payload: { cwd, ...(force !== undefined && { force: flag(force) }) } })
    ),
  checkIgnored: (cwd, paths) => call((c) => c.git.checkIgnored({ payload: { cwd, paths } })),
  fetch: (cwd) => call((c) => c.git.fetch({ payload: { cwd } })).then(() => undefined),
  fetchBatch: (paths) =>
    call((c) => c.git.fetchBatch({ payload: { paths } })).then(() => undefined),
  refreshRemotes: (paths) => call((c) => c.git.refreshRemotes({ payload: { paths } })),
  watch: (subscriberId, paths) => call((c) => c.git.watch({ payload: { subscriberId, paths } })),
  unwatch: (subscriberId) =>
    call((c) => c.git.unwatch({ payload: { subscriberId } })).then(() => undefined),
  stage: (cwd, files) =>
    call((c) => c.git.stage({ payload: { cwd, files } })).then(() => undefined),
  unstage: (cwd, files) =>
    call((c) => c.git.unstage({ payload: { cwd, files } })).then(() => undefined),
  discard: (cwd, files) =>
    call((c) => c.git.discard({ payload: { cwd, files } })).then(() => undefined),
  commit: (cwd, message) => call((c) => c.git.commit({ payload: { cwd, message } })),
  push: (cwd) => call((c) => c.git.push({ payload: { cwd } })).then(() => undefined),
  publishBranch: (cwd) =>
    call((c) => c.git.publishBranch({ payload: { cwd } })).then(() => undefined),
  pull: (cwd, strategy) =>
    call((c) => c.git.pull({ payload: { cwd, ...(strategy !== undefined && { strategy }) } })).then(
      () => undefined
    ),
  diff: (cwd, filePath, staged, isUntracked) =>
    call((c) =>
      c.git.diff({
        payload: { cwd, filePath, staged: flag(staged), isUntracked: flag(isUntracked) }
      })
    ),
  rangeFiles: (cwd, direction) => call((c) => c.git.rangeFiles({ payload: { cwd, direction } })),
  rangeDiff: (cwd, direction, filePath) =>
    call((c) => c.git.rangeDiff({ payload: { cwd, direction, filePath } })),
  commitFiles: (cwd, hash) => call((c) => c.git.commitFiles({ payload: { cwd, hash } })),
  commitDiff: (cwd, hash, filePath) =>
    call((c) => c.git.commitDiff({ payload: { cwd, hash, filePath } })),
  log: (cwd, maxCount) =>
    call((c) =>
      c.git.log({ payload: { cwd, ...(maxCount !== undefined && { maxCount: String(maxCount) }) } })
    ),
  outgoing: (cwd) => call((c) => c.git.outgoing({ payload: { cwd } })),
  incoming: (cwd) => call((c) => c.git.incoming({ payload: { cwd } })),
  journey: (cwd, maxCount) =>
    call((c) =>
      c.git.journey({
        payload: { cwd, ...(maxCount !== undefined && { maxCount: String(maxCount) }) }
      })
    ),
  generateCommitMessage: (cwd) => call((c) => c.git.generateCommitMessage({ payload: { cwd } })),
  summarizePush: (cwd, commitMessages, diffStats) =>
    call((c) => c.git.summarizePush({ payload: { cwd, commitMessages, diffStats } })),
  magicSync: (paths) => call((c) => c.git.magicSync({ payload: { paths } })),
  magicPull: (paths) => call((c) => c.git.magicPull({ payload: { paths } }))
})
