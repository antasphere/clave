/**
 * The updater contract, shared by main, preload and renderer.
 *
 * It lives here because the state has to be pull-able from the renderer, and a
 * pull needs a shape both sides agree on. Before this existed the renderer
 * rebuilt its own idea of the updater out of four separate push events; if it
 * missed the one that mattered — because it had not mounted yet, because it
 * reloaded, or because the check errored and the error was swallowed — there
 * was no way to ask what the truth was.
 */

export type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error'

/**
 * Which releases the updater reads. `stable` is GitHub's /releases/latest,
 * which excludes pre-releases by construction; `beta` is the releases feed,
 * newest entry first, pre-release or not. The user picks with "Receive
 * pre-release builds" (off by default), and the choice is persisted with the
 * other preferences.
 */
export type UpdateChannel = 'stable' | 'beta'

/**
 * The two electron-updater flags the channel resolves to, read BACK from the
 * updater singleton after they are applied — so a test that asserts on them
 * is asserting on what electron-updater will actually do, not on what we
 * meant to set.
 */
export interface UpdaterFlags {
  allowPrerelease: boolean
  allowDowngrade: boolean
}

/**
 * How a release body is written, because the provider decides and not us.
 *
 * GitHub's releases *feed* — the one `electron-updater` reads — carries each
 * body already rendered to HTML in its `<content>` element, not the Markdown
 * the release was authored in. A body assumed to be Markdown therefore reaches
 * the card as `<h3>Added</h3> <ul> <li>…` in plain text: every tag visible,
 * nothing formatted. The other providers (and a `latest-mac.yml` note) hand
 * back the raw body, which is Markdown. So the format travels with the note.
 */
export type ReleaseNoteFormat = 'markdown' | 'html'

/** One release's notes: the version it belongs to, and its body. */
export interface ReleaseNote {
  version: string
  /**
   * The release body. Empty bodies are dropped before this point, and an HTML
   * one has been through `sanitize-html` in the main process — the renderer
   * sets it as markup, so this field is the trust boundary.
   */
  note: string
  /** Which of the two the body is. Absent means Markdown, the old default. */
  format?: ReleaseNoteFormat
}

export interface DownloadProgress {
  percent: number
  bytesPerSecond: number
  transferred: number
  total: number
}

export interface UpdaterState {
  /** False in dev and anywhere else electron-updater cannot run. */
  supported: boolean
  phase: UpdatePhase
  currentVersion: string
  /** The version on the server once a check has found one. */
  availableVersion: string | null
  /**
   * What the available version changes, straight from the GitHub release
   * bodies — the ONLY changelog a running app can have for a version it
   * has not installed. `help/whats-new.json` is stamped and bundled at build
   * time, so v1.79 ships no note for v1.80; that note exists only inside the
   * v1.80 binary. This field is how "what's in the update" can be read BEFORE
   * taking it.
   *
   * With `fullChangelog` on, it is every release between the running version
   * and the latest, newest first — a user three versions behind sees all three.
   * Null when no check has found an update, or when the provider gave no body.
   */
  releaseNotes: ReleaseNote[] | null
  progress: DownloadProgress
  /** Set only in the `error` phase — a download that failed. */
  errorMessage: string | null
  /**
   * A *check* that failed, which is not the same thing and must not take over
   * the screen: the app is still perfectly usable, it just does not know
   * whether it is current.
   */
  checkErrorMessage: string | null
  /** Epoch ms of the last completed check, successful or not. */
  lastCheckedAt: number | null
  /** The channel the updater reads, per the "Receive pre-release builds" toggle. */
  channel: UpdateChannel
  /** True when the running build is itself a pre-release (`2.0.0-beta.1`). */
  currentIsPrerelease: boolean
  /** True when the version on offer is a pre-release, so the prompt can say so. */
  availableIsPrerelease: boolean
  flags: UpdaterFlags
  /**
   * Where the stable app's state files were copied the first time this
   * pre-release ran on a data directory a stable version had written — a beta
   * shares ~/Library/Application Support/Clave with the stable app. Null when
   * no snapshot was taken on this launch.
   */
  snapshotPath: string | null
}
