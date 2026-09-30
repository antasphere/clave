import { execFile, execFileSync } from 'child_process'
import type { MutationResult, MutationScope } from '../shared/extensions-types'

// ── Mutating extensions operations — wrap the `claude plugin` CLI ─────────────
//
// State (installed_plugins.json, known_marketplaces.json, settings.json) is
// owned by Claude Code. We never write those files ourselves — we shell out to
// the official, non-interactive `claude plugin` subcommands, then the reader
// re-reads whatever the CLI produced. This keeps us forward-compatible if the
// on-disk format changes.
//
// SECURITY: every command is run with `execFile` and an ARGUMENT ARRAY — never
// a shell string — so user-supplied values (plugin ids, marketplace sources)
// cannot inject shell metacharacters. The only login-shell invocation is the
// one-shot PATH probe below, which runs a fixed command with no interpolation.
// On top of that, inputs are validated (and positional args that could be
// mistaken for CLI flags are rejected) as defense in depth.

const COMMAND_TIMEOUT_MS = 180_000 // installs clone repos / run npm — allow time
const MAX_BUFFER = 8 * 1024 * 1024

// ── PATH resolution (packaged-app gotcha) ─────────────────────────────────────
// A packaged Electron app inherits a minimal PATH, so `claude` is not findable.
// Resolve the user's real PATH by sourcing their login+interactive shell once
// (zsh -lic reads .zprofile AND .zshrc, where PATH edits usually live), cache
// it, then run `claude` via execFile with that PATH in the env. We deliberately
// do NOT run the actual plugin command through the shell — only this probe.
let cachedUserPath: string | null = null

function resolveUserPath(): string {
  if (cachedUserPath !== null) return cachedUserPath
  try {
    const out = execFileSync('/bin/zsh', ['-lic', 'echo __CLAVE_PATH__$PATH'], {
      encoding: 'utf-8',
      timeout: 5000
    })
    const m = /__CLAVE_PATH__(.+)/.exec(out)
    cachedUserPath = m?.[1]?.trim() || process.env.PATH || ''
  } catch {
    cachedUserPath = process.env.PATH || ''
  }
  return cachedUserPath
}

// ── Input validation ──────────────────────────────────────────────────────────

/** Plugin id: "<name>" or "<name>@<marketplace>". */
const PLUGIN_ID_RE = /^[A-Za-z0-9._-]+(@[A-Za-z0-9._-]+)?$/
/** Marketplace name. */
const MARKETPLACE_NAME_RE = /^[A-Za-z0-9._-]+$/
/** Any char <= 0x20 — all C0 control characters plus the space. None of these
 *  is ever valid in a repo / URL / path, so their presence flags a malformed
 *  marketplace source. (Written as a code-point range to avoid a literal space
 *  byte in the class.) */
// eslint-disable-next-line no-control-regex -- matching control characters is the point: it rejects them
const ILLEGAL_SOURCE_RE = /[\u0000-\u0020]/
const VALID_SCOPES: MutationScope[] = ['user', 'project', 'local']

function assertPluginId(id: string): void {
  if (!PLUGIN_ID_RE.test(id)) throw new Error(`Invalid plugin id: ${id}`)
}

function assertMarketplaceName(name: string): void {
  if (!MARKETPLACE_NAME_RE.test(name)) throw new Error(`Invalid marketplace name: ${name}`)
}

function assertScope(scope: string): asserts scope is MutationScope {
  if (!VALID_SCOPES.includes(scope as MutationScope)) throw new Error(`Invalid scope: ${scope}`)
}

/**
 * A marketplace source is free-form (owner/repo, git URL, or local path), so we
 * can't pin it to one shape. But because it's passed as a POSITIONAL arg, a
 * value beginning with "-" would be parsed by the CLI as a flag (argument
 * injection). Reject that, plus empty/whitespace/control input. Shell injection
 * is already impossible (no shell), so this is purely about clean arg parsing.
 */
function assertMarketplaceSource(source: string): void {
  const s = source.trim()
  if (!s) throw new Error('Marketplace source is required')
  if (s.startsWith('-')) throw new Error('Marketplace source must not start with a dash')
  if (ILLEGAL_SOURCE_RE.test(s)) throw new Error('Marketplace source contains invalid characters')
}

// ── Serialized CLI runner ───────────────────────────────────────────────────
// Mutations touch the same JSON files (installed_plugins.json, settings.json).
// Running two at once could interleave read-modify-write and corrupt them, so
// every mutation funnels through one promise chain — only one runs at a time.

let queue: Promise<unknown> = Promise.resolve()

function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn)
  // Keep the chain alive regardless of this op's outcome.
  queue = next.then(
    () => undefined,
    () => undefined
  )
  return next
}

/** Run `claude <args>` non-interactively with the resolved PATH + config dir. */
function runClaude(args: string[], configDir?: string): Promise<MutationResult> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: resolveUserPath() }
    const trimmed = configDir?.trim()
    if (trimmed) env.CLAUDE_CONFIG_DIR = trimmed

    execFile(
      'claude',
      args,
      { env, timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_BUFFER, encoding: 'utf-8' },
      (err, stdout, stderr) => {
        const out = `${stdout || ''}\n${stderr || ''}`.trim()
        if (!err) {
          resolve({ ok: true, message: out || 'Done.' })
          return
        }
        // ENOENT → claude binary not on PATH. Common in packaged builds with an
        // unusual shell setup; give an actionable message.
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ENOENT') {
          resolve({
            ok: false,
            message: 'Claude Code CLI not found. Make sure `claude` is installed and on your PATH.'
          })
          return
        }
        if ((err as { killed?: boolean }).killed) {
          resolve({ ok: false, message: 'The operation timed out. Please try again.' })
          return
        }
        resolve({ ok: false, message: out || err.message || 'The command failed.' })
      }
    )
  })
}

// ── Public mutators ───────────────────────────────────────────────────────────

export function installPlugin(
  pluginId: string,
  scope: MutationScope,
  configDir?: string
): Promise<MutationResult> {
  return runExclusive(async () => {
    try {
      assertPluginId(pluginId)
      assertScope(scope)
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : 'Invalid input' }
    }
    return runClaude(['plugin', 'install', pluginId, '--scope', scope], configDir)
  })
}

export function uninstallPlugin(
  pluginId: string,
  scope: MutationScope,
  configDir?: string
): Promise<MutationResult> {
  return runExclusive(async () => {
    try {
      assertPluginId(pluginId)
      assertScope(scope)
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : 'Invalid input' }
    }
    // `-y` is required because we are not a TTY (skips the prune confirmation).
    return runClaude(['plugin', 'uninstall', pluginId, '--scope', scope, '-y'], configDir)
  })
}

export function setPluginEnabled(
  pluginId: string,
  enabled: boolean,
  scope: MutationScope,
  configDir?: string
): Promise<MutationResult> {
  return runExclusive(async () => {
    try {
      assertPluginId(pluginId)
      assertScope(scope)
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : 'Invalid input' }
    }
    const verb = enabled ? 'enable' : 'disable'
    return runClaude(['plugin', verb, pluginId, '--scope', scope], configDir)
  })
}

export function addMarketplace(source: string, configDir?: string): Promise<MutationResult> {
  return runExclusive(async () => {
    try {
      assertMarketplaceSource(source)
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : 'Invalid input' }
    }
    return runClaude(['plugin', 'marketplace', 'add', source.trim()], configDir)
  })
}

export function removeMarketplace(name: string, configDir?: string): Promise<MutationResult> {
  return runExclusive(async () => {
    try {
      assertMarketplaceName(name)
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : 'Invalid input' }
    }
    return runClaude(['plugin', 'marketplace', 'remove', name], configDir)
  })
}
