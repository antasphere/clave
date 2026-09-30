import { execFile } from 'node:child_process'
import { getLoginShellEnv } from './sessions/adapters/pty-backend'
import {
  ghArgs,
  ghSpawnEnv,
  pullRequestFromGh,
  splitUnifiedDiff,
  type GithubResult,
  type GithubFailureKind,
  type MergeMethod,
  type PullDiffFile,
  type PullRef,
  type PullRequestView,
  type ReviewEvent
} from '../shared/github-pull'

/**
 * The GitHub pull request panel's process: `gh`, the user's own CLI, on the
 * user's own login. Clave holds no GitHub token and never sees one — `gh`
 * keeps its credentials, and every call is one `gh pr …` with the login
 * shell's PATH (the packaged app's own PATH has no `gh` in it, see the PATH
 * gotcha in CLAUDE.md) — minus the shell's own `GH_TOKEN` / `GITHUB_TOKEN`,
 * which `gh` would take over the stored login (`ghSpawnEnv`): a token the
 * shell exports for something else cannot see the repositories the login
 * can, and `gh` then reports the repository as not existing. The token is
 * tried once, after, only when there is no stored login to use. Arguments
 * are built by `ghArgs` in the shared module and validated in the IPC
 * handler before they get here; bodies travel on stdin so they can never be
 * read as flags.
 */

const TIMEOUT_MS = 60_000
/** A pull request's diff can be large; `gh pr diff` streams the whole thing. */
const MAX_BUFFER = 32 * 1024 * 1024

interface GhRun {
  stdout: string
  stderr: string
}

function classify(stderr: string): GithubFailureKind {
  return /gh auth login|not logged in|authentication|HTTP 401|Bad credentials/i.test(stderr)
    ? 'auth'
    : 'failed'
}

/** Run `gh` once on the stored login, and once more on the login shell's own
 *  token only when `gh` has no login stored. A missing binary is its own
 *  failure kind so the panel can say "install gh" rather than showing an ENOENT. */
export async function runGh(args: string[], input?: string): Promise<GithubResult<GhRun>> {
  const plan = ghSpawnEnv(getLoginShellEnv())
  const first = await spawnGh(args, plan.env, input)
  if (first.ok || first.kind !== 'auth' || !plan.withToken) return first
  return spawnGh(args, plan.withToken, input)
}

function spawnGh(
  args: string[],
  env: Record<string, string>,
  input?: string
): Promise<GithubResult<GhRun>> {
  return new Promise((resolve) => {
    const child = execFile(
      'gh',
      args,
      {
        env: { ...env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
        encoding: 'utf-8',
        maxBuffer: MAX_BUFFER,
        timeout: TIMEOUT_MS
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ ok: true, value: { stdout, stderr } })
          return
        }
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT') {
          resolve({
            ok: false,
            kind: 'missing',
            message: 'The GitHub CLI (gh) is not installed, or not on the login shell’s PATH.'
          })
          return
        }
        const detail = (stderr || error.message).trim()
        resolve({ ok: false, kind: classify(detail), message: detail || 'gh failed' })
      }
    )
    if (input !== undefined && child.stdin) {
      child.stdin.on('error', () => {
        /* gh exited before reading the body; the exit reports the failure. */
      })
      child.stdin.end(input)
    } else child.stdin?.end()
  })
}

export async function fetchPullRequest(ref: PullRef): Promise<GithubResult<PullRequestView>> {
  const run = await runGh(ghArgs.view(ref))
  if (!run.ok) return run
  try {
    return { ok: true, value: pullRequestFromGh(ref, JSON.parse(run.value.stdout)) }
  } catch (error) {
    return {
      ok: false,
      kind: 'failed',
      message: `gh returned no readable record: ${String(error)}`
    }
  }
}

export async function fetchPullRequestDiff(ref: PullRef): Promise<GithubResult<PullDiffFile[]>> {
  const run = await runGh(ghArgs.diff(ref))
  return run.ok ? { ok: true, value: splitUnifiedDiff(run.value.stdout) } : run
}

export async function commentOnPullRequest(
  ref: PullRef,
  body: string
): Promise<GithubResult<void>> {
  const run = await runGh(ghArgs.comment(ref), body)
  return run.ok ? { ok: true, value: undefined } : run
}

export async function reviewPullRequest(
  ref: PullRef,
  event: ReviewEvent,
  body: string
): Promise<GithubResult<void>> {
  const run = await runGh(ghArgs.review(ref, event), body)
  return run.ok ? { ok: true, value: undefined } : run
}

export async function mergePullRequest(
  ref: PullRef,
  method: MergeMethod
): Promise<GithubResult<void>> {
  const run = await runGh(ghArgs.merge(ref, method))
  return run.ok ? { ok: true, value: undefined } : run
}
