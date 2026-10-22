/** Directories to always exclude from file listings and watchers */
export const IGNORED_DIRECTORIES = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '__pycache__',
  '.next',
  '.svelte-kit',
  '.DS_Store',
  'coverage',
  '.cache'
]

/** Set version for fast lookup in file watchers */
export const IGNORED_DIRECTORIES_SET = new Set<string>(IGNORED_DIRECTORIES)

/** Maximum number of files returned by listFiles */
export const MAX_FILES = 50_000

/** Maximum file size (bytes) for readFile before truncation */
export const MAX_FILE_SIZE = 1024 * 1024 // 1 MB

/** Buffer size for binary file detection probe */
export const BINARY_PROBE_SIZE = 8192

/** Default terminal dimensions */
export const DEFAULT_TERMINAL_COLS = 80
export const DEFAULT_TERMINAL_ROWS = 24

/** Delay (ms) before writing an initial command to a new PTY */
export const INITIAL_COMMAND_DELAY_MS = 150

/** Debounce delay (ms) for file system watcher change events */
export const FS_WATCH_DEBOUNCE_MS = 300

// ─── Git repo discovery (RepoIndexManager) ───────────────────────────────────

/**
 * Directory NAMES to skip while discovering git repos. Superset of the file-tree
 * ignore list — these never contain repos worth surfacing and are huge/noisy.
 */
export const DISCOVERY_SKIP_NAMES = new Set<string>([
  ...IGNORED_DIRECTORIES,
  'Library',
  'Applications',
  '.Trash',
  '.npm',
  '.pnpm-store',
  '.gradle',
  '.cargo',
  '.rustup',
  'venv',
  '.venv',
  'vendor',
  'Pods'
])

/**
 * Absolute system paths to never descend into during discovery. Critical when a
 * user opens "/" — these trees are enormous and contain no user repos.
 */
export const DISCOVERY_SKIP_PATHS = new Set<string>([
  '/System',
  '/Library',
  '/private',
  '/usr',
  '/bin',
  '/sbin',
  '/dev',
  '/Volumes',
  '/cores',
  '/opt',
  '/Network',
  '/Applications',
  '/.Spotlight-V100',
  '/.fseventsd',
  '/.DocumentRevisions-V100',
  '/.TemporaryItems',
  '/.vol'
])

/** Max concurrent readdir workers during a discovery scan */
export const DISCOVERY_CONCURRENCY = 8

/** Hard cap on directories visited in a single scan (runaway-tree backstop) */
export const MAX_DISCOVERY_DIRS = 15_000

/** Hard cap on repos returned by a single scan */
export const MAX_DISCOVERY_REPOS = 300

/** How long a completed scan result stays valid before a re-scan (ms) */
export const DISCOVERY_CACHE_TTL_MS = 120_000

/** Max background git jobs (status reads and fetches) running at once across
 *  the whole app — the queue in `git-queue.ts`. One job is a repo's status
 *  read or its fetch, each a handful of git processes run mostly in sequence. */
export const GIT_QUEUE_CONCURRENCY = 4

/** Of those, how many may be fetches: a stalled remote must never take every
 *  slot from the status reads the panel is waiting on. */
export const GIT_QUEUE_FETCH_CONCURRENCY = 2

/** A background fetch of a repo fetched less than this long ago (by any
 *  window, any panel) is skipped. The panel asks every three minutes. */
export const GIT_BACKGROUND_FETCH_MIN_AGE_MS = 150_000

/** How long a repo's identity (is it a repo, its top level, its git dirs) is
 *  trusted before it is read again. These change only when a repo is created,
 *  moved or deleted. */
export const GIT_REPO_INFO_TTL_MS = 300_000

/** The same for a folder that is NOT a repo, shorter: `git init` there should
 *  show up without a restart. */
export const GIT_NOT_REPO_TTL_MS = 30_000

/** Backstop on a cached worktree reading: even when none of the refs it
 *  depends on moved, it is read again after this long. */
export const GIT_WORKTREE_CACHE_TTL_MS = 300_000

/** The repo watcher (`git-watch.ts`): quiet time after a change before the
 *  panel is told, and the longest it is held while changes keep coming (an
 *  agent writing files, an install). */
export const GIT_WATCH_DEBOUNCE_MS = 300
export const GIT_WATCH_MAX_WAIT_MS = 1500

/** Max concurrent `git fetch` calls in the Refresh sweep the user clicked */
export const FETCH_BATCH_CONCURRENCY = 4

/** Max concurrent `git pull` calls in a Pull all batch */
export const PULL_BATCH_CONCURRENCY = 4

/** How long a git call that talks to a remote may go SILENT before it is
 *  killed. An idle timer, not a deadline: any output resets it, so a large
 *  fetch that is making progress is never cut off, and only a stalled remote —
 *  the one that used to hold the whole serial batch — is. */
export const GIT_NETWORK_TIMEOUT_MS = 20_000
