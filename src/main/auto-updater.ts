import { app, shell } from 'electron'
import { autoUpdater, CancellationToken } from 'electron-updater'
import log from 'electron-log/main'
import sanitizeHtml from 'sanitize-html'
import { broadcastToAllWindows } from './window-routing'
import { TEST_VERSION } from './test-mode'
import { isPrereleaseVersion } from '../shared/version'
import type { PrereleaseSnapshotOutcome } from './prerelease-snapshot-boot'
import type {
  DownloadProgress,
  ReleaseNote,
  ReleaseNoteFormat,
  UpdateChannel,
  UpdatePhase,
  UpdaterFlags,
  UpdaterState
} from '../shared/updater-types'

export type {
  DownloadProgress,
  ReleaseNote,
  ReleaseNoteFormat,
  UpdateChannel,
  UpdatePhase,
  UpdaterFlags,
  UpdaterState
}

const CHECK_INTERVAL = 30 * 60 * 1000 // 30 minutes
const INITIAL_DELAY = 5000
const RETRY_DELAY = 60 * 1000 // 1 minute

/** Where a user is sent when the updater cannot help itself. */
export const RELEASES_URL = 'https://github.com/antasphere/clave/releases/latest'

/**
 * Which try this is. Not a counter — the only distinction that changes what we
 * ask electron-updater to do is "first" vs "the user pressed Retry".
 */
export type DownloadAttempt = 'first' | 'retry'

export interface DownloadStrategy {
  /** Passed straight to `autoUpdater.disableDifferentialDownload`. */
  disableDifferentialDownload: boolean
}

/**
 * The first attempt takes the fast path: a differential download reads the
 * previous version's zip out of the updater cache and fetches only the blocks
 * that changed, which is the difference between a few MB and 220.
 *
 * A retry gives that up on purpose. We do not know why the first attempt
 * failed — electron-updater surfaces the download error verbatim, and
 * `net::ERR_FAILED` says only that an HTTP request did not complete — so the
 * retry's job is to remove variables rather than repeat the attempt. A full
 * download talks to one URL and reads nothing off disk.
 *
 * Disabling differential is enough on its own — MacUpdater checks the flag in
 * `canDifferentialDownload()` before it looks at the cached zip, so the retry
 * never touches the cache. We deliberately do NOT delete the cache: it would
 * only cost the *next* update its differential download, and removing a
 * directory in a shipped app is not a trade worth making for no gain.
 *
 * Worth knowing what this does NOT cover: `canDifferentialDownload()` also
 * returns false when the cache holds no `update.zip` at all, which is the case
 * on any machine whose last update did not complete. There the first attempt
 * was already a full download and the retry is byte-for-byte the same request.
 * That is why a failed download now also auto-retries once (see
 * `handleDownloadError`) and why the error state offers a direct download.
 */
export function downloadStrategy(attempt: DownloadAttempt): DownloadStrategy {
  return { disableDifferentialDownload: attempt === 'retry' }
}

/**
 * The channel, as the two electron-updater flags it resolves to.
 *
 * `allowPrerelease` IS the toggle: on, the GitHub provider reads the releases
 * feed and takes its newest entry, pre-release or stable, fetching
 * `beta-mac.yml` for a `-beta` tag; off, it reads `/releases/latest`, which
 * excludes pre-releases by construction, so a stable install can never be
 * offered a beta.
 *
 * `allowDowngrade` is the way back. A user on `2.0.0-beta.1` who turns the
 * toggle off is now asking `/releases/latest`, which answers `1.92.0` — a
 * lower version, which electron-updater refuses to offer unless downgrade is
 * allowed. So the flag is on exactly when the running build is a pre-release
 * AND the channel is stable: the next check offers the current stable and
 * the user leaves the beta the same way they would take an update. In every
 * other case it stays off, because a downgrade is otherwise never right.
 */
export function updaterFlags(prereleaseUpdates: boolean, currentVersion: string): UpdaterFlags {
  return {
    allowPrerelease: prereleaseUpdates,
    allowDowngrade: !prereleaseUpdates && isPrereleaseVersion(currentVersion)
  }
}

export function channelFor(prereleaseUpdates: boolean): UpdateChannel {
  return prereleaseUpdates ? 'beta' : 'stable'
}

/**
 * The phase transitions, pulled out of the event handlers so they can be
 * tested. Every one of them exists because a naive assignment was wrong:
 * updater events arrive on a 30-minute timer underneath whatever the user is
 * doing, so a handler that simply sets a phase will happily stomp a download
 * in flight with the result of a background check.
 */

/** A periodic check must not repaint a download as "checking". */
export function phaseOnCheckStart(current: UpdatePhase): UpdatePhase {
  return current === 'idle' || current === 'available' ? 'checking' : current
}

/**
 * A check that finds the version we are already downloading must leave the
 * download alone — otherwise the progress overlay is yanked back to a Download
 * button every 30 minutes.
 */
export function phaseOnAvailable(current: UpdatePhase, downloading: boolean): UpdatePhase {
  return downloading || current === 'downloaded' || current === 'error' ? current : 'available'
}

/** Nothing on the server: back to rest, unless something is in flight. */
export function phaseOnNotAvailable(current: UpdatePhase): UpdatePhase {
  return current === 'checking' || current === 'available' ? 'idle' : current
}

/**
 * A failed *check* is not a failed *update*. It must never reach the `error`
 * phase, because that phase raises a full-screen overlay over an app that is
 * working perfectly and merely does not know whether it is current.
 */
export function phaseOnCheckError(current: UpdatePhase): UpdatePhase {
  return current === 'checking' ? 'idle' : current
}

const initialProgress: DownloadProgress = {
  percent: 0,
  bytesPerSecond: 0,
  transferred: 0,
  total: 0
}

let state: UpdaterState = {
  supported: false,
  phase: 'idle',
  // Filled by initAutoUpdater. Kept off the module top level so importing this
  // file — as the tests do — does not need a live Electron app object.
  currentVersion: '',
  availableVersion: null,
  releaseNotes: null,
  progress: initialProgress,
  errorMessage: null,
  checkErrorMessage: null,
  lastCheckedAt: null,
  channel: 'stable',
  currentIsPrerelease: false,
  availableIsPrerelease: false,
  flags: { allowPrerelease: false, allowDowngrade: false },
  snapshotPath: null
}

/**
 * What the updater needs from the rest of main and cannot import: the
 * preference lives in `preferences-manager.ts`, which reads its file through
 * `app.getPath` at import time — an import this module's unit tests, which
 * run without Electron, cannot survive. Handed in by `initAutoUpdater`.
 */
export interface UpdaterDeps {
  /** The persisted "Receive pre-release builds" preference. */
  prereleaseUpdates: { get(): boolean; set(value: boolean): void }
  /** What the pre-release data snapshot did at boot. */
  snapshot: PrereleaseSnapshotOutcome
}

let deps: UpdaterDeps | null = null

let cancellationToken: CancellationToken | null = null
let downloadCancelled = false
let isDownloading = false
/** Guards the one automatic retry so a hard failure cannot loop. */
let autoRetried = false
let checkInterval: ReturnType<typeof setInterval> | null = null

/**
 * What electron-updater hands back for `releaseNotes`, before we have decided
 * it is usable. The GitHub provider gives a single string when `fullChangelog`
 * is off and an array of `{version, note}` when it is on; either can be null,
 * and either can carry an empty body for a release published with no notes.
 */
export type RawReleaseNotes = string | Array<{ version?: string; note?: string | null }> | null

/**
 * Normalise the provider's release notes into the one shape the UI reads.
 *
 * Every branch here is a real thing the GitHub provider does, and each one
 * fails the same quiet way if unhandled — a disclosure that opens onto nothing,
 * which reads as a broken control rather than as an absent changelog. So the
 * rule is: return null when there is nothing worth opening, never an empty
 * array or an array of blanks, and let the caller hide the affordance entirely.
 *
 * `fallbackVersion` names the release a bare string belongs to, since the
 * string form carries no version of its own.
 */
export function normalizeReleaseNotes(
  raw: RawReleaseNotes,
  fallbackVersion: string
): ReleaseNote[] | null {
  if (raw == null) return null

  if (typeof raw === 'string') {
    const body = normalizeReleaseBody(raw)
    return body ? [{ version: fallbackVersion, ...body }] : null
  }

  if (!Array.isArray(raw)) return null

  const notes: ReleaseNote[] = []
  for (const entry of raw) {
    const body = normalizeReleaseBody(entry?.note ?? '')
    // A release published with an empty body is skipped, not rendered as a
    // version heading with nothing under it.
    if (!body) continue
    notes.push({ version: (entry?.version ?? '').trim() || fallbackVersion, ...body })
  }
  return notes.length > 0 ? notes : null
}

/**
 * Whether a body is already-rendered HTML rather than the Markdown it was
 * authored in.
 *
 * It is a real fork, not a defensive one: GitHub's *releases feed* is where
 * `electron-updater` reads bodies from (`GitHubProvider.computeReleaseNotes`
 * takes the entry's `<content>`), and Atom content for a release is the body
 * already rendered — `<h3>Added</h3><ul><li>…`. Every other route into this
 * function (a `latest-mac.yml` `releaseNotes:` string, another provider) gives
 * the raw Markdown. Sniffing the body is what tells them apart, since nothing
 * upstream declares which one arrived.
 *
 * A block-level tag is the signal. Not `<` on its own: a Markdown note may well
 * say `<Cmd+K>` or name a generic type, and neither makes the body HTML.
 */
const LOOKS_LIKE_HTML =
  /<(?:p|div|ul|ol|li|h[1-6]|blockquote|pre|table|img|br|hr)\b[^>]*>|<\/(?:p|div|ul|ol|li|h[1-6]|blockquote|pre|table)>/i

/**
 * The tags a release note may keep, and the trust boundary for the renderer.
 *
 * The bodies come from our own releases over HTTPS, so this is a second lock
 * rather than the only one — but the renderer sets this string as markup, and
 * markup that reached a renderer unsanitised is an XSS hole whatever we believe
 * about its source. Everything not listed loses its box and keeps its text:
 * GitHub wraps bodies in `<div>`s and decorates author mentions with anchors
 * and images, none of which belong in a 260px card.
 */
const RELEASE_NOTE_SANITIZE: sanitizeHtml.IOptions = {
  allowedTags: [
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'p',
    'ul',
    'ol',
    'li',
    'strong',
    'b',
    'em',
    'i',
    'del',
    's',
    'code',
    'pre',
    'blockquote',
    'a',
    'br',
    'hr'
  ],
  // `target` is added here rather than trusted from the feed: a link in this
  // card must open in the browser, never navigate the renderer away from the
  // app (see the `a` component in ReleaseNotes.tsx, which does the same for
  // the Markdown branch).
  // `target`/`rel` are on the list because `transformTags` below ADDS them and
  // the attribute filter runs after the transform — left off, they are added
  // and then stripped, and the link navigates the renderer.
  allowedAttributes: { a: ['href', 'title', 'target', 'rel'] },
  allowedSchemes: ['http', 'https', 'mailto'],
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' })
  },
  // Dropped with their content, not unwrapped: an image in a sidebar card is
  // noise and a network fetch, and the rest cannot be rendered at all.
  nonTextTags: ['style', 'script', 'textarea', 'option', 'noscript', 'img', 'svg', 'iframe']
}

/**
 * One body, trimmed, sanitised if it is HTML, and told apart from an empty one.
 *
 * Returns null for anything that would open onto blank space — including a
 * body that survives sanitising as tags with no words left in it, which is
 * indistinguishable to a reader from a release published with no notes.
 */
export function normalizeReleaseBody(
  raw: string | null | undefined
): { note: string; format: ReleaseNoteFormat } | null {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return null
  if (!LOOKS_LIKE_HTML.test(trimmed)) return { note: trimmed, format: 'markdown' }

  const html = sanitizeHtml(trimmed, RELEASE_NOTE_SANITIZE).trim()
  if (!html.replace(/<[^>]*>/g, '').trim()) return null
  return { note: html, format: 'html' }
}

/**
 * The state patch an `update-available` event produces.
 *
 * Pulled out of the handler for one reason: the handler itself cannot be
 * reached from a test. `initAutoUpdater` early-returns unless the app is
 * packaged and then subscribes to the electron-updater singleton, so the line
 * that carries the release notes from the provider into the state — the whole
 * point of the update banner's disclosure — had no coverage at all. Dropping it
 * left every unit test green and the disclosure permanently absent, which is
 * indistinguishable from a release that simply had no notes.
 *
 * `phase` is decided by the caller, which owns the download-in-flight flag.
 */
export function availableStatePatch(
  info: { version: string; releaseNotes?: RawReleaseNotes },
  now: number
): Pick<
  UpdaterState,
  | 'availableVersion'
  | 'availableIsPrerelease'
  | 'releaseNotes'
  | 'lastCheckedAt'
  | 'checkErrorMessage'
> {
  return {
    availableVersion: info.version,
    // So the prompt can say "Beta" next to a version the user chose to see.
    availableIsPrerelease: isPrereleaseVersion(info.version),
    releaseNotes: normalizeReleaseNotes(info.releaseNotes ?? null, info.version),
    lastCheckedAt: now,
    checkErrorMessage: null
  }
}

/** The version this build reports itself as (a spec may override it, see test-mode.ts). */
function runningVersion(): string {
  return TEST_VERSION ?? app.getVersion()
}

/**
 * Apply the channel preference to electron-updater and mirror the result
 * into the state — read BACK off the singleton, so the state says what the
 * updater will do rather than what we asked of it.
 */
function applyChannel(): void {
  const enabled = deps?.prereleaseUpdates.get() === true
  const flags = updaterFlags(enabled, runningVersion())
  autoUpdater.allowPrerelease = flags.allowPrerelease
  autoUpdater.allowDowngrade = flags.allowDowngrade
  setState({
    channel: channelFor(enabled),
    flags: {
      allowPrerelease: autoUpdater.allowPrerelease,
      allowDowngrade: autoUpdater.allowDowngrade
    }
  })
}

/**
 * The toggle. Persists the preference, applies both flags, and checks at
 * once — a change of channel is a change of question, so whatever the last
 * check found on the old channel is dropped first. A download in flight or
 * finished is the user's and is left alone.
 */
export async function setPrereleaseUpdates(enabled: boolean): Promise<UpdaterState> {
  deps?.prereleaseUpdates.set(enabled)
  applyChannel()
  if (state.phase === 'idle' || state.phase === 'checking' || state.phase === 'available') {
    setState({
      availableVersion: null,
      availableIsPrerelease: false,
      releaseNotes: null,
      phase: state.phase === 'available' ? 'idle' : state.phase
    })
  }
  log.info(`[updater] Channel: ${state.channel} (${JSON.stringify(state.flags)})`)
  return checkForUpdatesNow()
}

function sendToRenderer(channel: string, ...args: unknown[]): void {
  // Update state is app-level; every window's updater overlay must hear it.
  broadcastToAllWindows(channel, ...args)
}

function setState(patch: Partial<UpdaterState>): void {
  state = { ...state, ...patch }
  sendToRenderer('updater:state', state)
}

export function getUpdaterState(): UpdaterState {
  return state
}

function handleDownloadError(message: string): void {
  // One silent retry, then give up and show the user something actionable.
  // `net::ERR_FAILED` on a 220 MB download is most often a connection that
  // dropped rather than anything reproducible, and asking a user to press
  // Retry for that is asking them to do the machine's job.
  if (!autoRetried) {
    autoRetried = true
    log.warn(`[updater] Download failed (${message}) — retrying once without differential`)
    startDownload('retry')
    return
  }
  setState({ phase: 'error', errorMessage: message })
}

export function initAutoUpdater(updaterDeps: UpdaterDeps): void {
  deps = updaterDeps
  // Set before the dev bail-out: the Software Update pane still names the
  // running version in development, it just says updates are unavailable.
  const version = runningVersion()
  setState({
    currentVersion: version,
    currentIsPrerelease: isPrereleaseVersion(version),
    supported: app.isPackaged,
    snapshotPath: updaterDeps.snapshot.result?.dir ?? null
  })
  // Also before the bail-out: the flags are state the pane and the E2E specs
  // read, and setting them on the singleton costs nothing in development.
  applyChannel()
  if (!app.isPackaged) return

  // electron-updater logs the entire download path through this logger — which
  // URL it fetched, whether it fell back from differential to full, why a
  // download aborted. Without it a packaged build writes to a console nobody
  // can read, which is why the 1.68.0 -> 1.69.0 `net::ERR_FAILED` could not be
  // traced: the only Clave files under ~/Library/Logs were crash reports.
  log.initialize()
  log.transports.file.level = 'info'
  autoUpdater.logger = log

  const { result: snapshot, failure: snapshotFailure } = updaterDeps.snapshot
  if (snapshotFailure) {
    log.error(`[updater] Pre-release data snapshot failed: ${snapshotFailure}`)
  } else if (snapshot) {
    log.info(
      `[updater] Pre-release ${version} first run on data last written by ${snapshot.fromVersion}: ` +
        `copied ${snapshot.copied.join(', ')} to ${snapshot.dir}`
    )
  }
  log.info(`[updater] Channel: ${state.channel} (${JSON.stringify(state.flags)})`)

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  // Gather EVERY release between the running version and the latest, not just
  // the newest one's body. A user who skipped two versions is told what all
  // three change; without this they are shown the top release's notes and
  // silently miss the rest.
  autoUpdater.fullChangelog = true

  autoUpdater.on('checking-for-update', () => {
    log.info('[updater] Checking for update...')
    // A check runs on a timer underneath whatever the user is doing. It must
    // not yank a finished download back to "checking".
    const phase = phaseOnCheckStart(state.phase)
    if (phase !== state.phase) setState({ phase, checkErrorMessage: null })
  })

  autoUpdater.on('update-available', (info) => {
    log.info(`[updater] Update available: ${info.version}`)
    setState({
      // Includes the release notes, which this event is the only source of:
      // built in `availableStatePatch` so the carry-through is testable.
      ...availableStatePatch(
        { version: info.version, releaseNotes: info.releaseNotes as RawReleaseNotes },
        Date.now()
      ),
      // Never demote an in-flight or finished download back to "available".
      phase: phaseOnAvailable(state.phase, isDownloading)
    })
    sendToRenderer('updater:update-available', info.version)
  })

  autoUpdater.on('update-not-available', () => {
    log.info('[updater] App is up to date')
    setState({
      availableVersion: null,
      availableIsPrerelease: false,
      // Cleared with the version they describe. Notes outliving their update
      // would let the banner open onto the changelog of a version that is no
      // longer on offer.
      releaseNotes: null,
      lastCheckedAt: Date.now(),
      checkErrorMessage: null,
      phase: phaseOnNotAvailable(state.phase)
    })
  })

  autoUpdater.on('download-progress', (progress) => {
    log.info(`[updater] Download: ${Math.round(progress.percent)}%`)
    const next: DownloadProgress = {
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total
    }
    setState({ phase: 'downloading', progress: next })
    sendToRenderer('updater:download-progress', next)
  })

  autoUpdater.on('update-downloaded', (info) => {
    log.info(`[updater] Update downloaded: ${info.version}`)
    isDownloading = false
    autoRetried = false
    setState({ phase: 'downloaded', availableVersion: info.version, errorMessage: null })
    sendToRenderer('updater:update-downloaded', info.version)
  })

  autoUpdater.on('error', (err) => {
    log.error('[updater] Error:', err.message)
    const wasDownloading = isDownloading && !downloadCancelled
    downloadCancelled = false
    isDownloading = false

    if (wasDownloading) {
      handleDownloadError(err.message)
      sendToRenderer('updater:download-error', err.message)
      return
    }

    // A failed check used to vanish entirely. It still must not raise an
    // overlay, but it has to be visible somewhere the user can look — the
    // Updates pane renders it next to Check Again.
    setState({
      checkErrorMessage: err.message,
      lastCheckedAt: Date.now(),
      phase: phaseOnCheckError(state.phase)
    })
  })

  const check = (): void => {
    autoUpdater.checkForUpdates().catch((err) => {
      log.error('[updater] Check failed:', err?.message)
      setTimeout(() => {
        autoUpdater.checkForUpdates().catch((retryErr) => {
          log.error('[updater] Retry failed:', retryErr?.message)
        })
      }, RETRY_DELAY)
    })
  }

  setTimeout(check, INITIAL_DELAY)
  checkInterval = setInterval(check, CHECK_INTERVAL)
}

/**
 * A check the user asked for, by pressing a button or picking the menu item.
 * Resolves with the state once the check has settled so the caller can react,
 * and never rejects — a failed check is a state, not an exception.
 */
export async function checkForUpdatesNow(): Promise<UpdaterState> {
  if (!state.supported) {
    return state
  }
  setState({ phase: phaseOnCheckStart(state.phase), checkErrorMessage: null })
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('[updater] Manual check failed:', message)
    setState({
      checkErrorMessage: message,
      lastCheckedAt: Date.now(),
      phase: phaseOnCheckError(state.phase)
    })
  }
  return state
}

export function startDownload(attempt: DownloadAttempt = 'first'): void {
  const strategy = downloadStrategy(attempt)
  // Set on every attempt, not just the retry: the flag lives on the shared
  // autoUpdater singleton, so a retry that is not reset would quietly make
  // every later update a full download.
  autoUpdater.disableDifferentialDownload = strategy.disableDifferentialDownload
  log.info(
    `[updater] Starting download (attempt=${attempt}, differential=${!strategy.disableDifferentialDownload})`
  )

  if (attempt === 'first') autoRetried = false
  downloadCancelled = false
  isDownloading = true
  setState({ phase: 'downloading', progress: initialProgress, errorMessage: null })
  cancellationToken = new CancellationToken()
  autoUpdater.downloadUpdate(cancellationToken).catch((err) => {
    if (!downloadCancelled) {
      log.error('[updater] Download failed:', err?.message)
    }
    isDownloading = false
  })
}

export function cancelDownload(): void {
  if (cancellationToken) {
    downloadCancelled = true
    isDownloading = false
    cancellationToken.cancel()
    cancellationToken = null
  }
  autoRetried = false
  setState({
    phase: state.availableVersion ? 'available' : 'idle',
    progress: initialProgress,
    errorMessage: null
  })
}

export function cleanupAutoUpdater(): void {
  if (checkInterval) {
    clearInterval(checkInterval)
    checkInterval = null
  }
}

/**
 * Open the log file the updater writes to. The escape hatch's escape hatch:
 * when an update fails for a reason the UI cannot explain, this is the thing a
 * user can actually send us.
 */
export function openUpdaterLog(): Promise<string> {
  return shell.openPath(log.transports.file.getFile().path)
}

/** The releases page — the manual way out when the updater cannot deliver. */
export function openReleasesPage(): Promise<void> {
  return shell.openExternal(RELEASES_URL)
}

export function installUpdate(): void {
  // Do NOT call app.relaunch() here — it races with Squirrel.Mac's ShipIt process.
  // app.relaunch() fires immediately on quit, relaunching the OLD binary before
  // ShipIt has finished replacing it. Let quitAndInstall() handle everything:
  // Squirrel.Mac's ShipIt waits for the app to quit, replaces the binary, then relaunches.
  autoUpdater.quitAndInstall()
}
