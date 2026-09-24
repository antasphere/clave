import { migrateSessionAdapterRecord } from '../../session-records-index'
import * as pty from 'node-pty'
import { execFile, execFileSync } from 'child_process'
import { randomUUID } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { DEFAULT_TERMINAL_COLS, DEFAULT_TERMINAL_ROWS, INITIAL_COMMAND_DELAY_MS } from '../../constants'
import { stateFilePath } from '../../agent-state-manager'
import { getMcpRuntime, writeSessionMcpConfig, deleteSessionMcpConfig } from '../../mcp/mcp-runtime'
import { workspaceManager } from '../../workspace-manager'
import { dismissSessionOffers } from '../../copy-offer-manager'
import { launchProfileManager } from '../../launch-profile-manager'
import { claudeAccountsManager } from '../../claude-accounts'
import { resolvePosixShellLaunch } from '../../shell-launch'
import { CODEX_TITLE_CONFIG } from '../../../shared/codex-state'
import { isValidModelName } from '../../../shared/model-name'
import { tmuxKillSessionArgs } from '../../tmux-args'
import {
  buildAgentArgv,
  type AgentKind,
  type LaunchProfile,
  type PiThinkingLevel
} from '../../../shared/agent-launch'

const isWindows = process.platform === 'win32'

/** Wrap a string as a single shell-quoted token (safe for embedding in `zsh -c`). */
export function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * Claude session ids are UUIDs. They are interpolated into the shell command
 * string used to spawn the CLI, so a value carrying shell metacharacters (from
 * a poisoned tmux sidecar or persisted session state) would be code execution.
 * Restrict to the UUID-safe alphabet.
 */
export function isValidClaudeSessionId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(id)
}

/** Pi accepts model patterns in addition to ids. Keep the field free-form as
 * advertised while refusing empty/control-bearing values and flag smuggling;
 * shellSingleQuote remains the command-injection boundary. */
function isValidPiOptionValue(value: string): boolean {
  return (
    value.length <= 200 &&
    value.trim() === value &&
    !value.startsWith('-') &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}

/**
 * Build the `--settings` argument that wires Claude Code lifecycle hooks to a
 * per-session state file owned by agent-state-manager. Returns the raw JSON
 * argument; the shared argv renderer quotes it as one shell token. Returns null
 * on Windows (hooks use POSIX `printf`/`grep`; the app ships macOS-only).
 *
 * State words written: idle (start), working (prompt/tool activity), blocked
 * (permission/elicitation prompt), done (turn complete), ended (session end).
 * `--settings` merges with (never replaces) the user's own settings.
 */
export function buildClaudeHookSettingsArg(claveSessionId: string): string | null {
  if (isWindows) return null
  const statePath = stateFilePath(claveSessionId)
  const q = JSON.stringify(statePath) // double-quoted shell token for the path
  // Recreate the parent dir on every write: the hook path is baked in at spawn,
  // so a vanished userData dir (cleanup script, manual delete) must not turn
  // every lifecycle hook into a visible "No such file or directory" error.
  const qDir = JSON.stringify(path.dirname(statePath))
  const write = (word: string): { hooks: { type: 'command'; command: string }[] } => ({
    hooks: [{ type: 'command', command: `mkdir -p ${qDir} && printf ${word} > ${q}` }]
  })
  const settings = {
    hooks: {
      SessionStart: [write('idle')],
      UserPromptSubmit: [write('working')],
      PreToolUse: [write('working')],
      PostToolUse: [write('working')],
      // Notification fires for both permission prompts and ~60s idle. Only the
      // permission/elicitation case is a real "blocked"; match the payload text
      // (robust to the exact field name) and ignore the idle case.
      Notification: [
        {
          hooks: [
            {
              type: 'command',
              command: `grep -qiE "permission|elicitation" && mkdir -p ${qDir} && printf blocked > ${q} || true`
            }
          ]
        }
      ],
      Stop: [write('done')],
      SessionEnd: [write('ended')]
    }
  }
  return JSON.stringify(settings)
}

let loginShellEnv: Record<string, string> | null = null

export function getUserShell(): string {
  if (isWindows) {
    return process.env.COMSPEC || 'cmd.exe'
  }
  return process.env.SHELL || '/bin/zsh'
}

function parseEnvOutput(output: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const entry of output.split('\0')) {
    const idx = entry.indexOf('=')
    if (idx > 0) {
      env[entry.slice(0, idx)] = entry.slice(idx + 1)
    }
  }
  return env
}

/**
 * Pre-cache the login shell environment asynchronously.
 * On Windows, we just use the current process env (no login shell concept).
 * On macOS/Linux, call the login shell so that PATH and other vars are populated.
 */
export function preloadLoginShellEnv(): void {
  if (loginShellEnv !== null) return

  if (isWindows) {
    loginShellEnv = { ...process.env } as Record<string, string>
    return
  }

  execFile(getUserShell(), ['-lic', 'env -0'], {
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024
  }, (err, stdout) => {
    if (loginShellEnv !== null) return // already set by sync fallback
    if (err) {
      loginShellEnv = { ...process.env } as Record<string, string>
      return
    }
    const env = parseEnvOutput(stdout)
    loginShellEnv = Object.keys(env).length > 0 ? env : { ...process.env } as Record<string, string>
  })
}

export function getLoginShellEnv(): Record<string, string> {
  if (loginShellEnv !== null) return loginShellEnv

  if (isWindows) {
    loginShellEnv = { ...process.env } as Record<string, string>
    return loginShellEnv
  }

  // Sync fallback if async preload hasn't finished yet
  try {
    const output = execFileSync(getUserShell(), ['-lic', 'env -0'], {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024
    })
    const env = parseEnvOutput(output)
    loginShellEnv = Object.keys(env).length > 0 ? env : { ...process.env } as Record<string, string>
  } catch {
    loginShellEnv = { ...process.env } as Record<string, string>
  }
  return loginShellEnv
}

// ---------------------------------------------------------------------------
// tmux integration (opt-in, macOS/Linux)
//
// When enabled, a session's agent runs *inside* a named tmux session. The
// node-pty process is merely the tmux client; the agent lives in the tmux
// server (a daemon), so it survives the client dying — i.e. the app quitting
// or crashing. Re-opening the same session slot reattaches the live process,
// and it can also be reached from any terminal via `tmux -L clave attach`.
// ---------------------------------------------------------------------------

/** Dedicated tmux socket so Clave's sessions never collide with the user's
 *  default tmux server (and a stray `tmux kill-server` can't nuke their work). */
const TMUX_SOCKET = 'clave'

// undefined = not probed yet, null = tmux not installed, string = absolute path
let tmuxPathCache: string | null | undefined
let tmuxConfigPathCache: string | null = null

/** Resolve tmux against the *login* shell PATH (Homebrew lives in /opt/homebrew
 *  which is usually absent from Electron's process.env.PATH). Uses the already
 *  preloaded login-shell env instead of spawning another `-lic` shell, so it
 *  doesn't block the main thread on the user's rc files. */
function detectTmux(): string | null {
  if (tmuxPathCache !== undefined) return tmuxPathCache
  if (isWindows) {
    tmuxPathCache = null
    return null
  }
  const env = getLoginShellEnv()
  const pathDirs = (env.PATH || process.env.PATH || '').split(':')
  for (const dir of pathDirs) {
    if (!dir) continue
    const candidate = path.join(dir, 'tmux')
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      tmuxPathCache = candidate
      return candidate
    } catch {
      // not here, keep looking
    }
  }
  tmuxPathCache = null
  return null
}

export function isTmuxAvailable(): boolean {
  return detectTmux() !== null
}

/**
 * Jump a tmux-backed pane to a past message (the message trail's click):
 * enter copy-mode and search upward for the text, `fromBottom` times — the
 * way a repeated prompt ("continue") is told apart from its newer twins.
 * tmux owns the scrollback for these sessions (xterm's buffer only ever held
 * the visible screen), so this is the one way to scroll them; the search also
 * highlights the match, and scrolling back down exits copy-mode like the
 * wheel does. tmux exits 0 whether or not the text was found, so the return
 * only says the command was issued.
 */
export function scrollTmuxSessionToText(tmuxName: string, needle: string, fromBottom: number): boolean {
  const tmuxPath = detectTmux()
  if (!tmuxPath) return false
  // Literal text search; strip control characters, and leading dashes so the
  // needle can never be read as a flag. A substring still matches.
  // eslint-disable-next-line no-control-regex
  const text = needle.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/^[-\s]+/, '').trim().slice(0, 120)
  if (text.length < 3) return false
  const times = Math.max(1, Math.min(50, Math.floor(fromBottom)))
  const args = ['-L', TMUX_SOCKET, 'copy-mode', '-e', '-t', tmuxName]
  for (let i = 0; i < times; i++) {
    args.push(';', 'send-keys', '-t', tmuxName, '-X', 'search-backward-text', text)
  }
  execFile(tmuxPath, args, (err) => {
    if (err) console.error('[pty] tmux scroll-to-text failed', err)
  })
  return true
}

/** Minimal, predictable config for embedded agent terminals. Passed via `-f`
 *  so the user's ~/.tmux.conf can't change behaviour (no surprise keybindings,
 *  no `destroy-unattached on` killing our sessions, no status bar stealing a
 *  row). Truecolor is forwarded and ESC latency dropped for snappy TUIs. */
/**
 * The per-session account variables a tmux-backed session must carry.
 *
 * A tmux server copies its OWN global environment into every new session,
 * not the creating client's: only the variables named in `update-environment`
 * cross from the client (and are removed from the session when the client
 * lacks them, which is what a Default-account session wants). Clave's server
 * is shared by every session and outlives the app, so a per-session account
 * would otherwise reach only the very first session the server ever ran.
 * Passing them as shell assignments or `new-session -e` would put the token
 * in the process list for the session's whole life; this keeps it in the
 * environment alone.
 */
export const TMUX_SESSION_ENV_VARS = ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN'] as const

/** The `set-option` calls that bring a live server's `update-environment` up
 *  to TMUX_SESSION_ENV_VARS; none when it already lists them. Pure, for the
 *  test: the config file only reaches a server at its first start. */
export function tmuxEnvironmentReconcileArgs(current: readonly string[]): string[][] {
  const present = new Set(current.map((v) => v.trim()))
  return TMUX_SESSION_ENV_VARS.filter((name) => !present.has(name)).map((name) => [
    'set-option',
    '-ga',
    'update-environment',
    name
  ])
}

function getTmuxConfigPath(): string {
  if (tmuxConfigPathCache) return tmuxConfigPathCache
  const conf = [
    'set -g default-terminal "tmux-256color"',
    'set -as terminal-features ",xterm-256color:RGB"',
    'set -g destroy-unattached off',
    'set -g status off',
    'set -g history-limit 50000',
    'set -sg escape-time 10',
    'set -g focus-events on',
    // Forward each pane's OSC title to its attached xterm. Codex includes its
    // runtime state here, including when a surviving session is reattached.
    'set -g set-titles on',
    'set -g set-titles-string "#{pane_title}"',
    // Mouse on, but with scrollback wiring: a bare `set -g mouse on` makes the
    // wheel send arrow keys to the shell (it mangles the prompt). Instead, the
    // wheel scrolls tmux's scrollback (entering copy-mode) unless the app inside
    // the pane wants the mouse itself (#{mouse_any_flag}), in which case we pass
    // the event through. Drag copies the selection to the macOS clipboard; scroll
    // back down (or finishing a selection) returns to the live prompt. We do NOT
    // bind MouseDown1Pane to cancel: the press fires before the drag, so canceling
    // on it jumps to the bottom and makes highlighting scrollback text impossible.
    'set -g mouse on',
    'bind -n WheelUpPane if -Ft= "#{mouse_any_flag}" "send -M" "if -Ft= \'#{pane_in_mode}\' \'send -X -N 3 scroll-up\' \'copy-mode -e\'"',
    'bind -n WheelDownPane if -Ft= "#{mouse_any_flag}" "send -M" "if -Ft= \'#{pane_in_mode}\' \'send -X -N 3 scroll-down\' \'send -M\'"',
    'bind -T copy-mode    MouseDragEnd1Pane send -X copy-pipe-and-cancel pbcopy',
    'bind -T copy-mode-vi MouseDragEnd1Pane send -X copy-pipe-and-cancel pbcopy',
    // If a second client (e.g. an external `tmux attach`) joins, follow the
    // most-recently-active client's size instead of shrinking to the smallest.
    'set -g window-size latest',
    // The account variables travel from the creating client into the new
    // session (see TMUX_SESSION_ENV_VARS); without this a session on a
    // running server gets the server's environment, never the account's.
    ...TMUX_SESSION_ENV_VARS.map((name) => `set -ga update-environment ${name}`),
    ''
  ].join('\n')
  const p = path.join(app.getPath('userData'), 'clave.tmux.conf')
  try {
    fs.writeFileSync(p, conf, 'utf-8')
    tmuxConfigPathCache = p
  } catch {
    // Fall back to running without a config file rather than failing the spawn.
    return ''
  }
  return tmuxConfigPathCache
}

function agentModeTag(options?: PtySpawnOptions): string {
  if (options?.piMode) return 'pi'
  if (options?.antigravityMode) return 'antigravity'
  if (options?.codexMode) return 'codex'
  if (options?.claudeAgentsMode) return 'agents'
  if (options?.claudeMode === false) return 'shell'
  return 'claude'
}

/** Tiny stable hash (djb2) → base36, so the same session slot maps to the same
 *  tmux session name across app restarts (enabling reattach on re-open). */
function shortHash(input: string): string {
  let h = 5381
  for (let i = 0; i < input.length; i++) {
    h = (h * 33) ^ input.charCodeAt(i)
  }
  return (h >>> 0).toString(36).slice(0, 6)
}

/** Deterministic, human-readable, tmux-legal session name (no `.` or `:`). */
function baseTmuxName(cwd: string, modeTag: string): string {
  const folder = (cwd.split('/').pop() || 'clave')
    .replace(/[^A-Za-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 24)
  return `clave-${folder}-${shortHash(`${cwd}|${modeTag}`)}`
}

// --- Sidecar metadata + orphan management -------------------------------------
//
// tmux sessions outlive the app, so the tmux server itself is our source of
// truth for "what was running". For each tmux-backed session we drop a tiny
// JSON sidecar describing how to recreate its tab. On launch the renderer asks
// for the adoptable list: we cross-check sidecars against the live tmux server,
// hand back the survivors (to be reattached as tabs), prune sidecars whose
// session is gone, and reap any stray `clave-*` session that has no sidecar —
// so nothing can pile up invisibly.

/** Who owns a session that is not a tab of its own (SessionRecord.link).
 *  The boot restore reads it to bring the session back as that half instead
 *  of as a top-level tab — see `lib/boot-adoption.ts` in the renderer, which
 *  owns the rules. */
export type SessionLink =
  /** A group's quick-launch terminal (the icons on a group row). */
  | { kind: 'group-terminal'; groupId: string; terminalId: string }
  /** The hidden process serving a single session's attached web view. */
  | { kind: 'session-view'; ownerId: string }
  /** A toolbar button's persistent terminal — never a sidebar row at all;
   *  `key` is the `${pinId}:${terminalIndex}` of the toolbar registry. */
  | { kind: 'toolbar'; key: string }

/** What the renderer needs to recreate + reattach a surviving session's tab.
 *
 *  Historically this metadata only existed for tmux-backed sessions (the
 *  "sidecar"). It is now a SESSION RECORD written for every local session,
 *  tmux or not: plain sessions can't be reattached (their process dies with
 *  the app), but the record lets the launch flow offer to RELAUNCH them —
 *  fresh shell in the same cwd, Claude conversations resumed via
 *  claudeSessionId — which is exactly the dead-tmux path that always existed. */
export interface SessionRecord {
  adapterId?: string
  transport?: 'pty' | 'events'
  /** Backing tmux session, when there is one. Absent = plain record: the
   *  session runs (ran) directly on a PTY and is only ever relaunched. */
  tmuxName?: string
  /** Original PTY session id, reused on adoption so the Claude lifecycle-hook
   *  state file (keyed by this id) keeps matching after reattach. */
  id: string
  claudeSessionId?: string
  piSessionId?: string
  cwd: string
  folderName: string
  /** The tab label as the user sees it — a manual rename or an auto-generated
   *  title. Absent means the tab still shows `folderName`. Kept in the sidecar
   *  (not just renderer memory) so a crash or reboot can't revert the name. */
  displayName?: string
  /** True when `displayName` came from an explicit rename, which protects it
   *  from being overwritten by the auto-title generator after re-adoption. */
  userRenamed?: boolean
  claudeMode: boolean
  antigravityMode: boolean
  codexMode: boolean
  piMode: boolean
  claudeAgentsMode: boolean
  dangerousMode: boolean
  /** Model the session was launched on (claude/codex), so a dead-sidecar
   *  re-spawn after a reboot relaunches the CLI on the same model. */
  model?: string
  launchProfileId?: string
  piProvider?: string
  piThinking?: PiThinkingLevel
  /** Claude account/profile this session runs under, so the badge + config dir
   *  survive an app restart and re-adoption. */
  configDir?: string
  claudeProfileId?: string
  claudeProfileLabel?: string
  /** Workspace this session belongs to. Stamped at spawn from the active
   *  workspace (or an explicit caller override) and carried forward across
   *  adoption rewrites. Legacy records without it are annotated at list time
   *  by inferring from cwd against registered workspace roots. */
  workspaceId?: string
  /** The WINDOW this session lives in (PRDCT-1703): the persisted key of the
   *  window that spawned or last adopted it. At boot each window adopts its
   *  own records; a record whose window no longer exists is an orphan the
   *  primary window takes. Rewritten on every adoption, so a move between
   *  windows (detach + re-adopt) re-stamps it. Legacy records without it are
   *  orphans, adopted by the primary. */
  windowKey?: string
  /** Attached web view (renderer session.view): the page behind the row's
   *  dashboard icon, restored at adoption. The hidden serving session's id is
   *  deliberately absent — it never survives a restart; the view's start
   *  action respawns the command. Mirrors displayName: renderer state dies
   *  with the window, the record is what survives. */
  view?: { url: string; title?: string; command?: string; cwd?: string }
  /** What this session IS — absent means an ordinary tab, which is every
   *  session the user opened and every record written before this field
   *  existed. A session spawned as the hidden half of something else (a
   *  group's quick-launch terminal, a session view's serving process, a
   *  toolbar server button) carries the identity of that owner here.
   *
   *  Without it the record is indistinguishable from a tab's, and the next
   *  launch brings a dev server back as a mystery tab in the sidebar while
   *  its owner shows "not running" and starts a duplicate. The renderer's
   *  own links do not close that gap: the toolbar's is in-memory, the
   *  session view's is deliberately not persisted, and the group's lives in
   *  the sidebar layout, which drops it with the group. */
  link?: SessionLink
  /** Populated only on the listAdoptableSessions() path (not persisted in
   *  the record). True when the backing tmux session is still running (app
   *  quit/reopen, no reboot) → reattach to the live process. False when the
   *  tmux server died (e.g. a shutdown/reboot killed it) but the sidecar
   *  metadata survives → re-spawn fresh (Claude resumes via claudeSessionId). */
  live?: boolean
}

/** tmux session names we create are always `clave-<sanitized>`. Validate before
 *  using a name in a filesystem path or a kill-session call — it crosses the IPC
 *  boundary on the adoption/discard paths. */
function isValidTmuxName(name: string): boolean {
  return /^clave-[A-Za-z0-9_-]+$/.test(name)
}

/** Plain records are keyed by the PTY session id (a UUID). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A record file's basename: the tmux name for tmux-backed sessions, the
 *  session id for plain ones. Everything that touches the filesystem or a
 *  kill-session call validates through this. */
function isValidRecordKey(key: string): boolean {
  return isValidTmuxName(key) || UUID_RE.test(key)
}

function recordKeyOf(meta: SessionRecord): string {
  return meta.tmuxName ?? meta.id
}

let recordsDirEnsured = false

export function sessionRecordsDir(): string {
  const dir = path.join(app.getPath('userData'), 'session-records')
  if (!recordsDirEnsured) {
    recordsDirEnsured = true
    // One-time move: records used to live in clave-tmux-sessions/ back when
    // only tmux-backed sessions had them.
    const legacy = path.join(app.getPath('userData'), 'clave-tmux-sessions')
    try {
      if (!fs.existsSync(dir) && fs.existsSync(legacy)) fs.renameSync(legacy, dir)
    } catch {
      // Fall through — worst case the legacy dir stays and records start fresh.
    }
  }
  return dir
}

/** Persist restore metadata. Returns false if it couldn't be written — the
 *  tmux path then falls back to a non-tmux spawn so we never create a tmux
 *  session we can't track (and would later be unable to adopt or clean up). */
function writeSessionRecord(meta: SessionRecord): boolean {
  const key = recordKeyOf(meta)
  if (!isValidRecordKey(key)) return false
  try {
    const dir = sessionRecordsDir()
    fs.mkdirSync(dir, { recursive: true })
    // Write-then-rename: records are rewritten on every rename, so a kill
    // mid-write must never be able to leave a truncated file behind — that
    // would lose the whole session, not just its name.
    const target = path.join(dir, `${key}.json`)
    const tmp = `${target}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(migrateSessionAdapterRecord(meta)), 'utf-8')
    fs.renameSync(tmp, target)
    return true
  } catch {
    return false
  }
}

function readSessionRecord(key: string): SessionRecord | null {
  if (!isValidRecordKey(key)) return null
  try {
    return migrateSessionAdapterRecord(JSON.parse(
      fs.readFileSync(path.join(sessionRecordsDir(), `${key}.json`), 'utf-8')
    ) as SessionRecord)
  } catch {
    return null
  }
}

function deleteSessionRecord(key: string): void {
  if (!isValidRecordKey(key)) return
  try {
    fs.unlinkSync(path.join(sessionRecordsDir(), `${key}.json`))
  } catch {
    // already gone
  }
}

/** The tmux config (`-f`) is read only when the server *first* starts. Clave's
 *  sessions outlive the app, so a server from before a config change keeps the
 *  old key bindings. For bindings we've *removed* from the config, omission
 *  can't unset them on a live server — reconcile them explicitly here. No-op
 *  when no server is running: the fresh server loads the current config via -f.
 *  (Starting a server here would race that load, so we only touch a live one.) */
function reconcileTmuxBindings(tmuxPath: string): void {
  if (liveTmuxSessions(tmuxPath).size === 0) return
  try {
    execFileSync(tmuxPath, ['-L', TMUX_SOCKET,
      'set-option', '-g', 'set-titles', 'on', ';',
      'set-option', '-g', 'set-titles-string', '#{pane_title}'], { stdio: 'ignore' })
  } catch {
    // Older tmux versions may not support title forwarding.
  }
  // Drop the legacy `MouseDown1Pane -> cancel` binding: the press fires before
  // the drag, so it snapped scrollback to the bottom on click and made
  // highlighting impossible. Without it, copy-mode's default drag-select works.
  for (const table of ['copy-mode', 'copy-mode-vi']) {
    try {
      execFileSync(tmuxPath, ['-L', TMUX_SOCKET, 'unbind', '-T', table, 'MouseDown1Pane'], {
        stdio: 'ignore'
      })
    } catch {
      // Best effort — the binding is already absent on a fresh-enough server.
    }
  }
}

/** A server started before the account variables were in the config keeps
 *  its old `update-environment`; add what is missing so the NEXT session on
 *  it carries its account. No-op with no live server (the config does it). */
function reconcileTmuxEnvironment(tmuxPath: string): void {
  if (liveTmuxSessions(tmuxPath).size === 0) return
  let current: string[] = []
  try {
    current = execFileSync(
      tmuxPath,
      ['-L', TMUX_SOCKET, 'show-options', '-gv', 'update-environment'],
      { encoding: 'utf-8' }
    )
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  } catch {
    // Unreadable: try the appends anyway, a duplicate entry is harmless.
  }
  for (const args of tmuxEnvironmentReconcileArgs(current)) {
    try {
      execFileSync(tmuxPath, ['-L', TMUX_SOCKET, ...args], { stdio: 'ignore' })
    } catch {
      // Best effort: the session still starts, on the server's environment.
    }
  }
}

/** List live tmux sessions on the clave socket (empty if tmux/socket absent). */
function liveTmuxSessions(tmuxPath: string): Set<string> {
  try {
    const out = execFileSync(
      tmuxPath,
      ['-L', TMUX_SOCKET, 'list-sessions', '-F', '#{session_name}'],
      { encoding: 'utf-8' }
    )
    return new Set(out.split('\n').map((s) => s.trim()).filter(Boolean))
  } catch {
    // No server running → no sessions.
    return new Set()
  }
}

export interface PtySpawnOptions {
  dangerousMode?: boolean
  /** Model the agent CLI starts on (alias like "opus" or a full model id).
   *  claude → `--model`, codex → `-m`; ignored for antigravity/terminal.
   *  Undefined = the CLI's own default. */
  model?: string
  claudeMode?: boolean
  antigravityMode?: boolean
  codexMode?: boolean
  piMode?: boolean
  claudeAgentsMode?: boolean
  resumeSessionId?: string
  claudeSessionId?: string
  piSessionId?: string
  launchProfileId?: string
  piProvider?: string
  piThinking?: PiThinkingLevel
  initialCommand?: string
  autoExecute?: boolean
  /** Initial prompt handed to the agent CLI's interactive mode (claude/codex
   *  positional arg, agy -i). One-shot: not persisted to the tmux sidecar,
   *  so adoption re-spawns never re-submit it. */
  initialPrompt?: string
  /** Opt-in: run this session inside a persistent tmux session. */
  tmuxMode?: boolean
  /** Reattach to this exact existing tmux session instead of deriving a new
   *  name. Set when adopting a session that survived a previous app run. */
  adoptTmuxName?: string
  /** Reuse this exact PTY session id (instead of a fresh UUID) when adopting,
   *  so the Claude lifecycle-hook state file keeps matching the live agent. */
  adoptSessionId?: string
  /** CLAUDE_CONFIG_DIR for this session — selects the Claude account/profile.
   *  Empty/undefined leaves the env untouched (default passthrough). */
  configDir?: string
  /** Profile metadata persisted for restore + the session-header badge. */
  claudeProfileId?: string
  claudeProfileLabel?: string
  /** Workspace to stamp on the session record. The pty:spawn handler defaults
   *  it to the active workspace; explicit values win (pin launches, MCP). */
  workspaceId?: string
  /** The persisted key of the window asking (stamped by pty-handlers from the
   *  sender; adoption and re-homing re-stamp through the same path). */
  windowKey?: string
  /** What this session is the hidden half of, when it is one — persisted on
   *  the record so the next launch can put it back there. Omitted = a tab.
   *  Carried forward across adoption like the display name. */
  link?: SessionLink
}

/** Validate a link crossing the IPC boundary. It is only ever compared to
 *  renderer ids and echoed back, but it lands in a JSON file we re-read at
 *  boot, so the shape is pinned here rather than trusted. Unknown kinds and
 *  over-long ids are dropped, never coerced. */
function sanitizeSessionLink(link: unknown): SessionLink | undefined {
  if (!link || typeof link !== 'object') return undefined
  const l = link as Record<string, unknown>
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.length > 0 && v.length <= 200 ? v : null
  if (l.kind === 'group-terminal') {
    const groupId = str(l.groupId)
    const terminalId = str(l.terminalId)
    return groupId && terminalId ? { kind: 'group-terminal', groupId, terminalId } : undefined
  }
  if (l.kind === 'session-view') {
    const ownerId = str(l.ownerId)
    return ownerId ? { kind: 'session-view', ownerId } : undefined
  }
  if (l.kind === 'toolbar') {
    const key = str(l.key)
    return key ? { kind: 'toolbar', key } : undefined
  }
  return undefined
}

interface PendingSpawn {
  file: string
  args: string[]
  cwd: string
  initialCommand?: string
  autoExecute?: boolean
  /** CLAUDE_CONFIG_DIR to set on the spawn env (account/profile selection). */
  configDir?: string
  /** CLAUDE_CODE_OAUTH_TOKEN for a token account: read from the encrypted
   *  store at spawn, held here until the PTY starts, never on the record. */
  oauthToken?: string
}

/**
 * The token a session starts with: the account's, and ONLY for a Claude
 * session. A plain terminal, Codex, Antigravity or Pi handed an account id
 * (a duplicate of a Claude tab switched to another agent, a caller's
 * mistake) must never inherit a subscription token into its environment.
 * Pure over the account store, so the boundary has a test of its own.
 */
export function accountTokenForSpawn(
  kind: AgentKind | null,
  accountId: string | undefined,
  getToken: (id: string | undefined) => string | undefined = (id) =>
    claudeAccountsManager.getToken(id)
): string | undefined {
  if (kind !== 'claude' && kind !== 'claude-agents') return undefined
  return getToken(accountId)
}

/**
 * The environment a session's process starts with. Pure, so a test can prove
 * an account actually reaches the process: nothing here fails loudly, and a
 * dropped field spawns a session that looks right and runs on the wrong
 * account.
 *
 * `CLAUDECODE` is stripped so a session started from inside another Claude
 * session does not think it is nested. The account fields are only set when
 * the account carries them: the Default account keeps whatever the user's own
 * shell exports.
 */
export function buildSpawnEnv(
  base: Record<string, string>,
  account: { configDir?: string; oauthToken?: string }
): Record<string, string> {
  const env: Record<string, string> = {
    ...base,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor'
  }
  delete env.CLAUDECODE
  if (account.configDir) env.CLAUDE_CONFIG_DIR = account.configDir
  if (account.oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = account.oauthToken
  return env
}

export interface PtySession {
  id: string
  cwd: string
  folderName: string
  ptyProcess: pty.IPty | null
  alive: boolean
  claudeSessionId?: string
  piSessionId?: string
  launchProfileId?: string
  model?: string
  piProvider?: string
  piThinking?: PiThinkingLevel
  /** Set when this session is backed by a tmux session (the tmux session name). */
  tmuxName?: string
  pending?: PendingSpawn
  onData?: (data: string) => void
  onExit?: (exitCode: number) => void
}

export class PtyBackend {
  private sessions = new Map<string, PtySession>()

  /**
   * Plan a PTY spawn but defer the actual `pty.spawn()` until the renderer
   * has fit its xterm and reported real cols/rows. This avoids the TUI
   * (claude/agy) being born at the default 80×24 and then being mangled
   * by xterm's reflow when the renderer resizes to the real width.
   *
   * `start(id, cols, rows)` finalises the spawn at the correct size.
   */
  spawn(cwd: string, options?: PtySpawnOptions): PtySession {
    // Reuse the original id when adopting/relaunching a survivor, so the
    // Claude hook state file (baked with this id at first spawn) still routes
    // to this tab. Plain records relaunch with adoptSessionId alone.
    const id =
      options?.adoptSessionId && UUID_RE.test(options.adoptSessionId)
        ? options.adoptSessionId
        : randomUUID()
    const folderName = (isWindows ? cwd.split('\\') : cwd.split('/')).pop() || cwd
    const useAgentsMode = options?.claudeAgentsMode === true
    const useAntigravityMode = options?.antigravityMode === true
    const useCodexMode = options?.codexMode === true
    const usePiMode = options?.piMode === true
    const useClaudeMode = options?.claudeMode !== false && !useAntigravityMode && !useCodexMode && !useAgentsMode && !usePiMode

    let claudeSessionId: string | undefined
    let piSessionId: string | undefined
    const kind: AgentKind | null = usePiMode
      ? 'pi'
      : useAntigravityMode
        ? 'antigravity'
        : useCodexMode
          ? 'codex'
          : useAgentsMode
            ? 'claude-agents'
            : useClaudeMode
              ? 'claude'
              : null
    const launchProfile: LaunchProfile | undefined = kind
      ? launchProfileManager.resolve(
          kind === 'claude-agents' ? 'claude' : kind,
          options?.workspaceId,
          options?.launchProfileId
        )
      : undefined
    const model = options?.model ?? (usePiMode ? launchProfile?.pi?.model : undefined)
    const piProvider = usePiMode ? options?.piProvider ?? launchProfile?.pi?.provider : undefined
    const piThinking = usePiMode ? options?.piThinking ?? launchProfile?.pi?.thinking : undefined

    // These values cross IPC and round-trip through the restore record. Shell
    // quoting is the injection boundary; shape checks also prevent accidental
    // flag-looking or malformed provider/model references from reaching a CLI.
    if (model !== undefined && !(usePiMode ? isValidPiOptionValue(model) : isValidModelName(model))) {
      throw new Error('Invalid model name')
    }
    if (piProvider !== undefined && !isValidPiOptionValue(piProvider)) throw new Error('Invalid Pi provider')
    if (piThinking !== undefined && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(piThinking)) {
      throw new Error('Invalid Pi thinking level')
    }

    // Windows spawns the user shell with these args. POSIX renders the agent
    // wrapper instead and lets resolvePosixShellLaunch pick file and args.
    let shellArgs: string[] = []
    let posixAgentCommand: string | undefined
    if (isWindows) {
      // Windows: cmd.exe with /c to exec the command directly (no echoed prompt).
      if (usePiMode) {
        throw new Error('Pi sessions are supported on macOS only')
      } else if (useAntigravityMode) {
        shellArgs = ['/c', 'agy']
      } else if (useCodexMode) {
        const parts = ['codex']
        if (options?.dangerousMode) parts.push('--yolo')
        if (model) parts.push('-m', model)
        parts.push('-c', CODEX_TITLE_CONFIG)
        shellArgs = ['/c', ...parts]
      } else if (useAgentsMode) {
        // `claude agents` is an interactive subcommand and does not accept
        // --session-id / --resume / --dangerously-skip-permissions, so spawn it bare.
        shellArgs = ['/c', 'claude', 'agents']
      } else if (!useClaudeMode) {
        shellArgs = []
      } else {
        const parts = ['claude']
        if (options?.resumeSessionId) {
          if (!isValidClaudeSessionId(options.resumeSessionId)) {
            throw new Error('Invalid resume session id')
          }
          parts.push('--resume', options.resumeSessionId)
          claudeSessionId = options.resumeSessionId
        } else {
          const requested = options?.claudeSessionId
          claudeSessionId = requested && isValidClaudeSessionId(requested) ? requested : randomUUID()
          parts.push('--session-id', claudeSessionId)
        }
        if (options?.dangerousMode) parts.push('--dangerously-skip-permissions')
        if (model) parts.push('--model', model)
        shellArgs = ['/c', ...parts]
      }
    } else {
      // POSIX agent commands run non-interactively (no echo, no prompt, no
      // rc-file chatter). Plain terminals open the user's login shell.
      if (kind) {
        const profile = launchProfile!
        if ((kind === 'claude' || kind === 'pi') && options?.resumeSessionId && !isValidClaudeSessionId(options.resumeSessionId)) {
          throw new Error('Invalid resume session id')
        }
        if (kind === 'claude') {
          claudeSessionId = options?.resumeSessionId
            ?? (options?.claudeSessionId && isValidClaudeSessionId(options.claudeSessionId)
              ? options.claudeSessionId
              : randomUUID())
        }
        if (kind === 'pi') {
          piSessionId = options?.resumeSessionId
            ?? (options?.piSessionId && isValidClaudeSessionId(options.piSessionId)
              ? options.piSessionId
              : randomUUID())
        }
        const mcpConfigPath = kind === 'claude' && getMcpRuntime() ? writeSessionMcpConfig(id) : null
        const piExtensionPath = kind === 'pi'
          ? path
              .join(__dirname, '../../resources/pi-clave-state.js')
              .replace('app.asar', 'app.asar.unpacked')
          : undefined
        const argv = buildAgentArgv({
          kind,
          profile,
          sessionId: kind === 'pi' ? piSessionId : claudeSessionId,
          resumeSessionId: options?.resumeSessionId,
          dangerousMode: options?.dangerousMode,
          model,
          provider: piProvider,
          thinking: piThinking,
          initialPrompt: options?.initialPrompt,
          claudeSettings: kind === 'claude' ? buildClaudeHookSettingsArg(id) ?? undefined : undefined,
          mcpConfigPath: mcpConfigPath ?? undefined,
          piStateExtensionPath: piExtensionPath
        })
        const assignments = [`CLAVE_SESSION_ID=${shellSingleQuote(id)}`]
        if (kind === 'pi') assignments.push(`CLAVE_AGENT_STATE_FILE=${shellSingleQuote(stateFilePath(id))}`)
        const rendered = `${assignments.join(' ')} ${argv.map(shellSingleQuote).join(' ')}`
        const failure = `__clave_status=$?; if [ $__clave_status -ne 0 ]; then printf '\\r\\n[Clave] Agent command exited with status %d\\r\\nCommand: %s\\r\\n' $__clave_status ${shellSingleQuote(argv.map(shellSingleQuote).join(' '))}; fi; exit $__clave_status`
        posixAgentCommand = `${rendered}; ${failure}`
      }
    }

    // Plain terminals belong to the user's shell, and so do agent commands
    // while that shell speaks POSIX. Selecting Nushell or Fish diverts the
    // wrapper to a shell that can parse it instead of making it a syntax
    // error. tmux receives the same resolved file and arguments.
    const userShell = getUserShell()
    const directLaunch = isWindows
      ? { file: userShell, args: shellArgs }
      : resolvePosixShellLaunch(userShell, posixAgentCommand)
    const shellName = directLaunch.file
    let spawnFile = shellName
    let spawnArgs = directLaunch.args
    let tmuxName: string | undefined

    // Adoption/relaunch rewrites the record from scratch, so carry the tab's
    // name and workspace forward — otherwise bringing a session back would
    // erase the very metadata we persisted for it.
    const previousKey =
      options?.adoptTmuxName && isValidTmuxName(options.adoptTmuxName)
        ? options.adoptTmuxName
        : options?.adoptSessionId && UUID_RE.test(options.adoptSessionId)
          ? options.adoptSessionId
          : null
    const previous = previousKey ? readSessionRecord(previousKey) : null

    const recordBase: SessionRecord = {
      adapterId: 'pty',
      transport: 'pty',
      id,
      claudeSessionId,
      piSessionId,
      cwd,
      folderName,
      displayName: previous?.displayName,
      userRenamed: previous?.userRenamed,
      claudeMode: useClaudeMode,
      antigravityMode: useAntigravityMode,
      codexMode: useCodexMode,
      piMode: usePiMode,
      claudeAgentsMode: useAgentsMode,
      dangerousMode: options?.dangerousMode === true,
      model,
      launchProfileId: launchProfile?.id,
      piProvider,
      piThinking,
      configDir: options?.configDir,
      claudeProfileId: options?.claudeProfileId,
      claudeProfileLabel: options?.claudeProfileLabel,
      workspaceId: previous?.workspaceId ?? options?.workspaceId,
      // The asking window is the home from now on — an adoption or a move
      // re-stamps; only a windowless spawn keeps what the record had.
      windowKey: options?.windowKey ?? previous?.windowKey,
      // What the session is the hidden half of. The caller wins (a re-spawn
      // may hang the same terminal off a different group), else what the
      // record already said, so an adoption never erases the ownership that
      // keeps the session out of the sidebar.
      link: sanitizeSessionLink(options?.link) ?? previous?.link
    }
    let recordKey: string | null = null

    const tmuxPath = options?.tmuxMode ? detectTmux() : null
    if (tmuxPath) {
      // When adopting a survivor, reattach to its exact (validated) name;
      // otherwise derive a fresh name that doesn't clash with any live session.
      const adopt = options?.adoptTmuxName
      const candidateName =
        adopt && isValidTmuxName(adopt) ? adopt : this.uniqueTmuxName(cwd, agentModeTag(options))

      // Persist restore metadata first. If we can't track the session, fall back
      // to a plain shell spawn rather than create an untrackable tmux session.
      const sidecarOk = writeSessionRecord({ ...recordBase, tmuxName: candidateName })

      if (sidecarOk) {
        recordKey = candidateName
        tmuxName = candidateName
        const confPath = getTmuxConfigPath()
        // A server predating this fix still carries the old click-to-cancel
        // binding; strip it from the live server so the fix applies without a
        // server restart (the -f config below only takes effect on a new one).
        reconcileTmuxBindings(tmuxPath)
        reconcileTmuxEnvironment(tmuxPath)
        // `-u` forces UTF-8 client output. Electron apps are launched without a
        // UTF-8 locale (no LANG/LC_* in the GUI environment), so tmux would
        // otherwise run the client in non-UTF-8 mode and downsample every
        // multibyte glyph — box-drawing, the agent's logo, em-dashes — to `_`.
        // (Direct, non-tmux PTYs are unaffected: the agent + xterm.js are always
        // UTF-8; only tmux gates UTF-8 on the locale env.)
        const tmuxArgs: string[] = ['-u', '-L', TMUX_SOCKET]
        if (confPath) tmuxArgs.push('-f', confPath)
        // `new-session -A`: attach if the session already exists (reattach a live
        // agent after an app restart / from elsewhere), otherwise create it and
        // run the shell command. Attaching never re-runs the command. Fresh names
        // are guaranteed not to collide with a survivor, so `-A` only reattaches
        // on the explicit adoption path.
        tmuxArgs.push('new-session', '-A', '-s', tmuxName, shellName, ...directLaunch.args)
        spawnFile = tmuxPath
        spawnArgs = tmuxArgs
      }
    }

    // Plain session (tmux off or unavailable) — record it anyway, keyed by the
    // session id. The process can't outlive the app, but the record lets the
    // next launch offer to RELAUNCH the whole setup (fresh shell in the same
    // cwd; Claude resumes via claudeSessionId).
    if (!recordKey && writeSessionRecord(recordBase)) {
      recordKey = id
    }
    // A record can change keys across an adoption (plain→tmux when the global
    // toggle flipped, or tmux→plain after it was turned off) — drop the stale
    // file or the next launch would offer the same session twice.
    if (previousKey && previousKey !== recordKey) {
      deleteSessionRecord(previousKey)
    }

    const session: PtySession = {
      id,
      cwd,
      folderName,
      ptyProcess: null,
      alive: true,
      pending: {
        file: spawnFile,
        args: spawnArgs,
        cwd,
        initialCommand: options?.initialCommand,
        autoExecute: options?.autoExecute,
        configDir: options?.configDir,
        // The token is looked up here, by account id, and only for a Claude
        // session: the renderer never holds it, and a terminal or another
        // agent never inherits it.
        oauthToken: accountTokenForSpawn(kind, options?.claudeProfileId)
      }
    }
    if (claudeSessionId) session.claudeSessionId = claudeSessionId
    if (piSessionId) session.piSessionId = piSessionId
    if (launchProfile) session.launchProfileId = launchProfile.id
    if (model) session.model = model
    if (piProvider) session.piProvider = piProvider
    if (piThinking) session.piThinking = piThinking
    if (tmuxName) session.tmuxName = tmuxName
    this.sessions.set(id, session)
    return session
  }

  /** Pick a fresh tmux session name that clashes with neither an in-process
   *  session nor a live session on the tmux server. Checking the server too is
   *  essential: it stops a brand-new session from silently `-A`-attaching to a
   *  not-yet-adopted survivor of the same cwd+mode (which would hijack it). */
  private uniqueTmuxName(cwd: string, modeTag: string): string {
    const base = baseTmuxName(cwd, modeTag)
    const taken = new Set(
      Array.from(this.sessions.values())
        .map((s) => s.tmuxName)
        .filter((n): n is string => !!n)
    )
    const tmuxPath = detectTmux()
    if (tmuxPath) for (const n of liveTmuxSessions(tmuxPath)) taken.add(n)
    if (!taken.has(base)) return base
    let n = 2
    while (taken.has(`${base}-${n}`)) n++
    return `${base}-${n}`
  }

  /**
   * Register the data/exit listeners that should be wired up as soon as the
   * underlying pty.spawn() runs. Must be called BEFORE start().
   */
  attachListeners(
    id: string,
    onData: (data: string) => void,
    onExit: (exitCode: number) => void
  ): void {
    const session = this.sessions.get(id)
    if (!session) return
    session.onData = onData
    session.onExit = onExit
  }

  /**
   * Actually spawn the PTY at the renderer-measured cols/rows. Safe to call
   * once per session id; subsequent calls just resize.
   */
  start(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id)
    if (!session) return
    if (session.ptyProcess) {
      // Already started — treat as resize.
      if (session.alive) session.ptyProcess.resize(cols, rows)
      return
    }
    if (!session.pending) return
    const { file, args, cwd, initialCommand, autoExecute, configDir, oauthToken } = session.pending
    session.pending = undefined

    const ptyName = isWindows ? undefined : 'xterm-256color'

    // Per-session Claude account: a config dir and/or a pasted token, set only
    // when the account carries them (see buildSpawnEnv). A tmux-backed session
    // gets the same environment: tmux seeds a new session from the creating
    // client's, which is this one.
    const ptyProcess = pty.spawn(file, args, {
      name: ptyName,
      cols: Math.max(1, cols),
      rows: Math.max(1, rows),
      cwd,
      env: buildSpawnEnv(getLoginShellEnv(), { configDir, oauthToken })
    })

    session.ptyProcess = ptyProcess

    if (session.onData) {
      ptyProcess.onData(session.onData)
    }
    ptyProcess.onExit(({ exitCode }) => {
      session.alive = false
      session.onExit?.(exitCode)
    })

    // For plain-shell mode (no claude/agy), honour an explicit initialCommand.
    if (initialCommand) {
      setTimeout(() => {
        if (session.alive && session.ptyProcess) {
          session.ptyProcess.write(autoExecute === true ? initialCommand + '\r' : initialCommand)
        }
      }, INITIAL_COMMAND_DELAY_MS)
    }
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.ptyProcess?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id)
    if (!session) return
    if (!session.ptyProcess) {
      // Not yet started — promote first resize into start().
      this.start(id, cols, rows)
      return
    }
    if (session.alive) {
      session.ptyProcess.resize(Math.max(1, cols), Math.max(1, rows))
    }
  }

  /**
   * Terminate a session.
   *
   * @param killTmuxSession when true (a user explicitly closing the session)
   *   the backing tmux session is destroyed for real. When false (the app is
   *   quitting) we only kill the local tmux *client*, which detaches and leaves
   *   the agent running in the tmux server to be reattached next launch.
   */
  kill(id: string, killTmuxSession = true): void {
    const session = this.sessions.get(id)
    if (session) {
      if (killTmuxSession) {
        // Real close: destroy the backing tmux session (if any) and the
        // session record — the tab is gone for good. On app quit we keep both
        // so the next launch can reattach (tmux) or offer a relaunch (plain).
        if (session.tmuxName) {
          const tmuxPath = detectTmux()
          if (tmuxPath) {
            execFile(tmuxPath, tmuxKillSessionArgs(TMUX_SOCKET, session.tmuxName), () => {})
          }
        }
        deleteSessionRecord(session.tmuxName ?? id)
      }
      // On a real close the session is gone for good; on app quit (tmux
      // survivor) the config must stay valid for the reattached agent.
      if (killTmuxSession) {
        deleteSessionMcpConfig(id)
        // Copy offers are surfaced in the tab's own header — once the tab is
        // gone they are unreachable, so don't keep their values in memory.
        dismissSessionOffers(id)
      }
      if (session.alive && session.ptyProcess) {
        session.ptyProcess.kill()
      }
      this.sessions.delete(id)
    }
  }

  /**
   * Record the tab's display name in the session's tmux sidecar so it survives
   * an app restart, a crash, or a reboot. Renames live in the renderer store,
   * which dies with the window — the sidecar is the only per-session record
   * that outlives it. Called on every rename (manual, auto-title, or reset to
   * the folder name); a no-op for sessions with no tmux sidecar to update.
   */
  /** The persisted record key for an in-memory session (tmux name or id). */
  private recordKeyForSession(id: string): string | null {
    const session = this.sessions.get(id)
    if (session) return session.tmuxName ?? id
    // An events session (a chat tab) has no PTY here, only its record, keyed
    // by its id: the renames, moves and re-stamps below reach it through that.
    return UUID_RE.test(id) && readSessionRecord(id) ? id : null
  }

  /** Persist an events session's record (a chat tab). It has no process this
   *  backend owns, so nothing else writes one, and without it the tab is gone
   *  at the next launch. The restore path relaunches it with --resume, like a
   *  plain terminal record. Returns false when it could not be written. */
  writeEventSessionRecord(meta: SessionRecord): boolean {
    if (meta.tmuxName || !UUID_RE.test(meta.id)) return false
    return writeSessionRecord(meta)
  }

  /** The backing tmux session's name, or null for plain (non-tmux) tabs —
   *  which is also the answer to "who owns this tab's scrollback". */
  tmuxNameOf(id: string): string | null {
    return this.sessions.get(id)?.tmuxName ?? null
  }

  setSessionDisplayName(id: string, displayName: string | null, userRenamed: boolean): void {
    const key = this.recordKeyForSession(id)
    if (!key) return
    const meta = readSessionRecord(key)
    if (!meta) return
    const next = displayName?.trim() || undefined
    if (meta.displayName === next && !!meta.userRenamed === userRenamed) return
    writeSessionRecord({ ...meta, displayName: next, userRenamed })
  }

  /** Persist (or clear, with null) a session's attached web view in its
   *  record. Mirrors setSessionDisplayName — see SessionRecord.view. */
  setSessionViewRecord(id: string, view: { url: string; title?: string; command?: string; cwd?: string } | null): void {
    const key = this.recordKeyForSession(id)
    if (!key) return
    const meta = readSessionRecord(key)
    if (!meta) return
    writeSessionRecord({ ...meta, view: view ?? undefined })
  }

  /**
   * Re-stamp a session's workspace in its persisted record (workspace removal
   * reassigns sessions; a future "move to workspace" uses the same primitive).
   * Mirrors setSessionDisplayName: renderer state dies with the window, the
   * record is what survives.
   */
  setSessionWorkspace(id: string, workspaceId: string | null): void {
    const key = this.recordKeyForSession(id)
    if (!key) return
    const meta = readSessionRecord(key)
    if (!meta) return
    const next = workspaceId ?? undefined
    if (meta.workspaceId === next) return
    writeSessionRecord({ ...meta, workspaceId: next })
  }

  /** Follow a `/clear`: Claude Code rotated to a new transcript, so the
   *  session's id — in memory and in the record — moves with it. Mirrors
   *  setSessionDisplayName: what is not in the record does not survive a
   *  restart, and a stale id would resume the pre-/clear conversation. */
  setSessionClaudeSessionId(id: string, claudeSessionId: string): void {
    if (!isValidClaudeSessionId(claudeSessionId)) return
    const session = this.sessions.get(id)
    if (session) session.claudeSessionId = claudeSessionId
    const key = this.recordKeyForSession(id)
    if (!key) return
    const meta = readSessionRecord(key)
    if (!meta || meta.claudeSessionId === claudeSessionId) return
    writeSessionRecord({ ...meta, claudeSessionId })
  }

  /** Re-home a record to another window WITHOUT touching the process — used
   *  when a closing window hands a non-tmux session (whose pty dies with the
   *  window) to the primary, so the next boot offers it there. */
  setSessionWindowKey(id: string, windowKey: string): void {
    const key = this.recordKeyForSession(id)
    if (!key) return
    const meta = readSessionRecord(key)
    if (!meta || meta.windowKey === windowKey) return
    writeSessionRecord({ ...meta, windowKey })
  }

  /**
   * Reconcile session records with the live tmux server and return the
   * sessions that survived a previous run. Each is flagged `live`:
   *   - `live: true`  → the tmux session is still running (app quit/reopen, no
   *     reboot). The caller reattaches to the live process silently — the
   *     session was never disrupted.
   *   - `live: false` → the process is gone: a plain record (its PTY died with
   *     the app), or a tmux record whose server a shutdown/reboot killed. The
   *     caller RELAUNCHES it — fresh spawn in the same cwd, Claude resuming
   *     via claudeSessionId — behind the launch restore prompt.
   *
   * We deliberately do NOT kill live sessions that lack a record: the `clave`
   * socket is user-attachable (the settings panel advertises `tmux -L clave
   * attach`), so a name prefix isn't proof of ownership. Because every
   * Clave-created session is written a record before it is spawned, our own
   * sessions are always tracked. Records are pruned only when malformed or
   * when their cwd no longer exists (un-restorable) — so they can't
   * accumulate across reboots.
   */
  listAdoptableSessions(): SessionRecord[] {
    const tmuxPath = detectTmux()
    const live = tmuxPath ? liveTmuxSessions(tmuxPath) : new Set<string>()
    const adoptedTmuxNames = new Set(
      Array.from(this.sessions.values())
        .map((s) => s.tmuxName)
        .filter((n): n is string => !!n)
    )
    const adoptedIds = new Set(this.sessions.keys())

    const dir = sessionRecordsDir()
    let files: string[] = []
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
    } catch {
      files = []
    }

    const adoptable: SessionRecord[] = []
    for (const file of files) {
      let meta: SessionRecord | null = null
      try {
        meta = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'))
      } catch {
        meta = null
      }
      if (meta) meta = migrateSessionAdapterRecord(meta)
      if (meta && meta.antigravityMode === undefined) {
        // Legacy records (written before the Antigravity switch) carry the old
        // `antigravityMode`'s predecessor key. Map it forward so a survivor of the
        // retired Gemini CLI re-spawns as Antigravity (`agy`) on adoption.
        meta.antigravityMode = (meta as { geminiMode?: boolean }).geminiMode ?? false
      }
      // Malformed record → prune the file. Valid shapes: tmux-backed (valid
      // tmux name) or plain (no tmuxName, uuid session id).
      const validShape =
        meta &&
        (meta.tmuxName ? isValidTmuxName(meta.tmuxName) : !!meta.id && UUID_RE.test(meta.id))
      if (!meta || !validShape) {
        try {
          fs.unlinkSync(path.join(dir, file))
        } catch {
          /* ignore */
        }
        continue
      }
      const isLive = !!meta.tmuxName && live.has(meta.tmuxName)
      if (!isLive && !fs.existsSync(meta.cwd)) {
        // The working directory is gone — the session can't be relaunched, so
        // its record is dead weight. Prune it.
        deleteSessionRecord(recordKeyOf(meta))
        continue
      }
      const alreadyAdopted = meta.tmuxName ? adoptedTmuxNames.has(meta.tmuxName) : adoptedIds.has(meta.id)
      if (!alreadyAdopted) {
        adoptable.push({
          ...meta,
          // Legacy inference, implemented once: records written before the
          // workspace model (or spawned with none active) are placed by cwd —
          // under a registered root → that workspace; else left unstamped for
          // the renderer to assign to the active workspace.
          workspaceId: meta.workspaceId ?? workspaceManager.resolveWorkspaceForCwd(meta.cwd) ?? undefined,
          live: isLive
        })
      }
    }

    return adoptable
  }

  /** Destroy a surviving session the user chose not to bring back: kill the
   *  backing tmux session when there is one, then drop the record. */
  discardSessionRecord(key: string): void {
    if (!isValidRecordKey(key)) return
    if (isValidTmuxName(key)) {
      const tmuxPath = detectTmux()
      if (tmuxPath) {
        execFile(tmuxPath, tmuxKillSessionArgs(TMUX_SOCKET, key), () => {})
      }
    }
    deleteSessionRecord(key)
  }

  getSession(id: string): PtySession | undefined {
    return this.sessions.get(id)
  }

  getAllSessions(): { id: string; cwd: string; folderName: string; alive: boolean }[] {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      cwd: s.cwd,
      folderName: s.folderName,
      alive: s.alive
    }))
  }

  /**
   * Kill every session. Used on app quit: tmux-backed sessions are only
   * detached (not destroyed) so the agents survive until the next launch.
   */
  killAll(): void {
    for (const [id] of this.sessions) {
      this.kill(id, false)
    }
  }
}

// Re-export the default constants so existing imports remain valid.
export { DEFAULT_TERMINAL_COLS, DEFAULT_TERMINAL_ROWS }

export const ptyBackend = new PtyBackend()
