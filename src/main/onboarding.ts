import { spawn } from 'node:child_process'
import { accessSync, constants, mkdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { preferencesManager } from './preferences-manager'
import { loginShellEnvAsync, refreshLoginShellEnv } from './sessions/adapters/pty-backend'
import { agentUpdateManager } from './agent-updates'
import { TEST_NO_ACTIVATE, TEST_ONBOARDING } from './test-mode'
import { rememberChatView } from './sessions/chat-view-default'
import { HARNESS_BY_ID } from '../shared/harness'
import type {
  InstallableAgentId,
  OnboardingAgent,
  OnboardingInstallResult,
  OnboardingState
} from '../shared/onboarding'

/**
 * The first-run walk's side in main: whether to show it (the `onboarding`
 * preference, decided once from the data directory), and the two agents it
 * offers, found on the login PATH and installed in one click when they are
 * not there. Generic on purpose: Clave is public, so the walk names an agent
 * and its maker, never a team, a server or a company.
 *
 *  - Claude Code installs with Anthropic's native installer, which needs no
 *    Node, npm or Homebrew: one binary into ~/.local/bin, the launcher and
 *    the shell's PATH set up by the binary's own `install`.
 *  - Codex installs with npm when npm is on the PATH, else the Homebrew cask;
 *    with neither, the walk links to its install page instead of guessing.
 *
 *  - Antigravity, Pi and OpenCode (Settings → Harnesses only) take the
 *    harness table's own line (`HARNESS_BY_ID[id].install`); Pi's is an npm
 *    install, so it needs npm on the PATH like Codex; OpenCode's is its own
 *    curl installer, which puts it in `~/.opencode/bin` and on the PATH of
 *    the shell's rc file (read again by the interactive login shell).
 *
 * After an install the login environment is read again, so the session the
 * walk ends on finds the new command without a restart.
 */

const CLAUDE_INSTALL = HARNESS_BY_ID.claude.install as string
const CODEX_HELP = 'https://developers.openai.com/codex/cli'
/** An install that has not finished by then is not going to. */
const INSTALL_TIMEOUT_MS = 10 * 60_000
/** How much of a failed install's output is told back, from the end. */
const OUTPUT_TAIL = 600

const COMMANDS: Record<InstallableAgentId, string> = {
  claude: HARNESS_BY_ID.claude.command,
  codex: HARNESS_BY_ID.codex.command,
  antigravity: HARNESS_BY_ID.antigravity.command,
  pi: HARNESS_BY_ID.pi.command,
  opencode: HARNESS_BY_ID.opencode.command
}

function executable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The first folder of the PATH holding `command`, as its full path. */
export function findOnPath(command: string, pathValue: string | undefined): string | null {
  for (const dir of (pathValue || '').split(':')) {
    if (!dir) continue
    const file = join(dir, command)
    if (executable(file)) return file
  }
  return null
}

/** How Codex would be installed here: npm first, then the Homebrew cask. */
export function codexInstallCommand(pathValue: string | undefined): string | null {
  if (findOnPath('npm', pathValue)) return 'npm install -g @openai/codex'
  if (findOnPath('brew', pathValue)) return 'brew install --cask codex'
  return null
}

/** The shell line that installs a harness here, or null when this Mac has
 *  nothing to run it with: Claude's native installer, Codex by npm or the
 *  Homebrew cask, Antigravity and Pi by the harness table's line (Pi's is an
 *  npm install, so it needs npm on the PATH). */
export function installCommandFor(
  id: InstallableAgentId,
  pathValue: string | undefined
): string | null {
  if (id === 'claude') return CLAUDE_INSTALL
  if (id === 'codex') return codexInstallCommand(pathValue)
  const line = HARNESS_BY_ID[id].install
  if (!line) return null
  if (/^npm\s/.test(line) && !findOnPath('npm', pathValue)) return null
  return line
}

/** Why there is no install command, said to the person. */
function noInstallerMessage(id: InstallableAgentId): string {
  if (id === 'codex') return 'Codex needs npm or Homebrew to install from here.'
  if (HARNESS_BY_ID[id].install) return `${HARNESS_BY_ID[id].name} needs npm to install from here.`
  return `${HARNESS_BY_ID[id].name} installs from its own page.`
}

/** The agents whose installer is running, claimed before the first await so
 *  two clicks can never start the same install twice. */
const installing = new Set<InstallableAgentId>()

/** The two agents as the walk shows them. `fresh` reads the login shell
 *  again (after an install, or on "Check again"); otherwise the cached copy.
 *  The login PATH always ends with the native installer's folder
 *  (`withNativeAgentDirs`), so a Claude installed there is found either way. */
export async function describeAgents(fresh = false): Promise<OnboardingAgent[]> {
  const env = fresh ? await refreshLoginShellEnv() : await loginShellEnvAsync()
  const codexCommand = codexInstallCommand(env.PATH)
  return (['claude', 'codex'] as const).map((id) => {
    const found = findOnPath(COMMANDS[id], env.PATH)
    return {
      id,
      installed: found !== null,
      installing: installing.has(id),
      installCommand: id === 'claude' ? CLAUDE_INSTALL : codexCommand,
      helpUrl: id === 'codex' && !codexCommand ? CODEX_HELP : null
    }
  })
}

/** The window the walk was handed to in this run: only that one shows it,
 *  so a second window opened meanwhile never starts a second walk. */
let walkWindow: number | null = null

/** The walk's window closed: the next window that asks takes the walk. */
export function releaseOnboardingWindow(windowId: number): void {
  if (walkWindow === windowId) walkWindow = null
}

/** Cheap: read at every window's start, so it runs no shell. `windowId` is
 *  the asking window's web contents. */
export function getOnboardingState(windowId: number | null = null): OnboardingState {
  const pending =
    preferencesManager.get('onboarding') === 'pending' && (!TEST_NO_ACTIVATE || TEST_ONBOARDING)
  if (pending && walkWindow === null) walkWindow = windowId
  const chatView = preferencesManager.get('chatView')
  return {
    show: pending && walkWindow === windowId,
    home: homedir(),
    chatView: typeof chatView === 'string' ? chatView : null,
    skin: preferencesManager.get('activeSkinId')
  }
}

/** The chat style the walk's reader picked: the view every new chat opens in,
 *  remembered the way a pane's own view picker remembers it. */
export function setChatView(viewId: string): void {
  rememberChatView(viewId)
}

export function completeOnboarding(): void {
  preferencesManager.set('onboarding', 'done')
}

/**
 * Run a constant installer command: under bash with pipefail, so a download
 * that fails fails the pipe (`curl … | bash` exits 0 otherwise); in a process
 * group of its own, so the timeout ends every child (curl, the installer,
 * npm, brew) and not only the shell.
 */
export function runInstaller(
  command: string,
  env: Record<string, string>,
  timeoutMs: number = INSTALL_TIMEOUT_MS
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    let output = ''
    let settled = false
    const child = spawn('/bin/bash', ['-c', `set -o pipefail; ${command}`], {
      env: { ...env, NONINTERACTIVE: '1', HOMEBREW_NO_AUTO_UPDATE: '1' },
      cwd: homedir(),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const keep = (chunk: Buffer): void => {
      output = (output + chunk.toString()).slice(-64 * 1024)
    }
    child.stdout?.on('data', keep)
    child.stderr?.on('data', keep)
    const finish = (ok: boolean, extra = ''): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok, output: output + extra })
    }
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
      finish(false, '\nThe install took too long and was stopped.')
    }, timeoutMs)
    child.on('error', (error) => finish(false, `\n${error.message}`))
    child.on('close', (code) => finish(code === 0))
  })
}

/** Whether a harness's command is on the login PATH now (read fresh). */
async function installedNow(id: InstallableAgentId): Promise<boolean> {
  const env = await loginShellEnvAsync()
  return findOnPath(COMMANDS[id], env.PATH) !== null
}

/** Run the agent's installer, then look again. `agents` stays the walk's
 *  two; for Antigravity and Pi the outcome is read off the PATH directly. */
export async function installAgent(id: InstallableAgentId): Promise<OnboardingInstallResult> {
  if (installing.has(id)) {
    return { ok: false, message: 'Already installing.', agents: await describeAgents() }
  }
  installing.add(id)
  try {
    const env = await refreshLoginShellEnv()
    const command = installCommandFor(id, env.PATH)
    if (!command) {
      return { ok: false, message: noInstallerMessage(id), agents: await describeAgents() }
    }
    const outcome = await runInstaller(command, env)
    installing.delete(id)
    const agents = await describeAgents(true)
    // The agent updater's view (Settings → Harnesses) catches up in the background.
    void agentUpdateManager.checkAll().catch(() => undefined)
    const found =
      id === 'claude' || id === 'codex'
        ? agents.find((a) => a.id === id)?.installed === true
        : await installedNow(id)
    if (found) return { ok: true, message: null, agents }
    const tail = outcome.output.trim().slice(-OUTPUT_TAIL)
    return {
      ok: false,
      message: outcome.ok
        ? 'The installer finished, but the command is still not found.'
        : tail || 'The install failed.',
      agents
    }
  } finally {
    installing.delete(id)
  }
}

/** A folder name the walk may create: one segment, nothing hidden. */
export function folderNameOf(name: string): string | null {
  const clean = name
    .replace(/[/:\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
  return clean.length > 0 && clean.length <= 120 ? clean : null
}

/** The first workspace's folder: `<parent>/<name>`, created when it is not
 *  there, taken as it is when it is. Returns its absolute path. */
export function createWorkspaceFolder(parent: string, name: string): string {
  if (!isAbsolute(parent)) throw new Error('Choose where to put the folder.')
  const folder = folderNameOf(name)
  if (!folder) throw new Error('Give the workspace a name.')
  const target = join(parent, folder)
  try {
    if (!statSync(target).isDirectory()) throw new Error(`${target} is a file, not a folder.`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    mkdirSync(target, { recursive: true })
  }
  return target
}
