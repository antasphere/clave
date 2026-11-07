import { execFile } from 'node:child_process'
import { accessSync, constants, mkdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { preferencesManager } from './preferences-manager'
import {
  getUserShell,
  loginShellEnvAsync,
  refreshLoginShellEnv
} from './sessions/adapters/pty-backend'
import { agentUpdateManager } from './agent-updates'
import { TEST_NO_ACTIVATE, TEST_ONBOARDING } from './test-mode'
import { rememberChatView } from './sessions/chat-view-default'
import type {
  OnboardingAgent,
  OnboardingAgentId,
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
 * After an install the login environment is read again, so the session the
 * walk ends on finds the new command without a restart.
 */

const CLAUDE_INSTALL = 'curl -fsSL https://claude.ai/install.sh | bash'
const CLAUDE_DIR = join(homedir(), '.local', 'bin')
const CODEX_HELP = 'https://developers.openai.com/codex/cli'
/** An install that has not finished by then is not going to. */
const INSTALL_TIMEOUT_MS = 10 * 60_000
/** How much of a failed install's output is told back, from the end. */
const OUTPUT_TAIL = 600

const COMMANDS: Record<OnboardingAgentId, string> = { claude: 'claude', codex: 'codex' }

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

/** Append a folder to the cached login PATH (the object Clave's spawns read). */
function ensureOnPath(env: Record<string, string>, dir: string): void {
  const dirs = (env.PATH || '').split(':').filter(Boolean)
  if (!dirs.includes(dir)) env.PATH = [...dirs, dir].join(':')
}

let installing: OnboardingAgentId | null = null

/** The two agents as the walk shows them. `fresh` reads the login shell
 *  again (after an install, or on "Check again"); otherwise the cached copy. */
export async function describeAgents(fresh = false): Promise<OnboardingAgent[]> {
  // The Claude binary in its native folder counts even when the PATH does not
  // name that folder yet: the cached PATH is told about it, and Clave's own
  // spawns find it.
  const nativeClaude = executable(join(CLAUDE_DIR, 'claude'))
  const env = fresh ? await refreshLoginShellEnv() : await loginShellEnvAsync()
  if (nativeClaude) ensureOnPath(env, CLAUDE_DIR)
  const codexCommand = codexInstallCommand(env.PATH)
  return (['claude', 'codex'] as const).map((id) => {
    const found = findOnPath(COMMANDS[id], env.PATH)
    return {
      id,
      installed: found !== null,
      installing: installing === id,
      installCommand: id === 'claude' ? CLAUDE_INSTALL : codexCommand,
      helpUrl: id === 'codex' && !codexCommand ? CODEX_HELP : null
    }
  })
}

/** Cheap: read at every window's start, so it runs no shell. */
export function getOnboardingState(): OnboardingState {
  const pending = preferencesManager.get('onboarding') === 'pending'
  const chatView = preferencesManager.get('chatView')
  return {
    show: pending && (!TEST_NO_ACTIVATE || TEST_ONBOARDING),
    home: homedir(),
    chatView: typeof chatView === 'string' ? chatView : null
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

/** Run the agent's installer in the login shell, then look again. */
export async function installAgent(id: OnboardingAgentId): Promise<OnboardingInstallResult> {
  if (installing) {
    return { ok: false, message: 'Another install is running.', agents: await describeAgents() }
  }
  const env = await refreshLoginShellEnv()
  const command = id === 'claude' ? CLAUDE_INSTALL : codexInstallCommand(env.PATH)
  if (!command) {
    return {
      ok: false,
      message: 'Codex needs npm or Homebrew to install from here.',
      agents: await describeAgents()
    }
  }
  installing = id
  const outcome = await new Promise<{ ok: boolean; output: string }>((resolve) => {
    execFile(
      getUserShell(),
      ['-lc', command],
      {
        env: { ...env, NONINTERACTIVE: '1', HOMEBREW_NO_AUTO_UPDATE: '1' },
        cwd: homedir(),
        timeout: INSTALL_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        resolve({ ok: !error, output: `${stdout ?? ''}${stderr ?? ''}` })
      }
    )
  })
  installing = null
  const agents = await describeAgents(true)
  // The agent updater's view (Settings → Agents) catches up in the background.
  void agentUpdateManager.checkAll().catch(() => undefined)
  const installed = agents.find((a) => a.id === id)?.installed === true
  if (installed) return { ok: true, message: null, agents }
  const tail = outcome.output.trim().slice(-OUTPUT_TAIL)
  return {
    ok: false,
    message: outcome.ok
      ? 'The installer finished, but the command is still not found.'
      : tail || 'The install failed.',
    agents
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
