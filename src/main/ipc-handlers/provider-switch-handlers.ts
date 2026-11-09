/**
 * A tab changes provider (PRDCT-4300): the calls the chat's chip and its
 * popover make on this Mac, over IPC whatever server holds the sessions,
 * because what they need is here: the CLIs on the login shell's PATH, the
 * Claude transcripts under ~/.claude, the Codex account homes the shell
 * syncs. The restart itself is the lifecycle's (`pty:restart`, the server's
 * `RestartSession`) with a provider override; the rules are in
 * `sessions/provider-switch.ts`.
 *
 * - `adapters:list`: the providers a tab can move to on this host.
 * - `adapters:models`: a provider's models with no session of it open, cached
 *   for the boot (a failure is not cached).
 * - `provider-switch:plan`: the road a move would take, before Continue.
 * - `provider-switch:convert`: the Claude transcript written as a Codex
 *   thread in the target account's home through `@clave/session-bridge`,
 *   read back through the real Codex; refused with a reason otherwise.
 * - `provider-switch:handoff`: the full conversation written beside the
 *   work, and the worktree's `git diff --stat`, for the handoff message.
 */
import { app, ipcMain } from 'electron'
import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { codexVersion } from '@clave/session-bridge'
import type { ModelOption } from '../../shared/session-model'
import type { ProviderChoice, ProviderSwitchPlan } from '../../preload/index.d'
import { ptyManager, buildSpawnEnv, codexHomeForSpawn, getLoginShellEnv } from '../pty-manager'
import { sessionManager } from '../sessions/session-manager'
import { ClaudeAdapter, findTranscript } from '../sessions/adapters/claude-adapter'
import { CodexAdapter } from '../sessions/adapters/codex-adapter'
import { EchoAdapter } from '../sessions/adapters/echo-adapter'
import { isEchoLaunchProfile, launchProfileManager } from '../launch-profile-manager'
import { findExecutable } from '../shell-launch'
import {
  PROVIDER_LABELS,
  convertTranscriptToCodex,
  planRoad,
  providerOf
} from '../sessions/provider-switch'

/** The providers a tab can move to: the built-in chat adapters this build
 *  registered (Claude's is not offered on Windows, as the launcher does not),
 *  and the echo fixture while its flag is on. A plugin's adapter is not
 *  listed: its models cannot be asked without a session. */
export function providerChoices(): ProviderChoice[] {
  const choices: ProviderChoice[] = []
  const add = (adapterId: string): void => {
    if (!sessionManager.getAdapter(adapterId)) return
    const provider = providerOf(adapterId)
    choices.push({ adapterId, provider, label: PROVIDER_LABELS[provider] ?? provider })
  }
  if (process.platform !== 'win32') add('claude-chat')
  add('codex-chat')
  if (isEchoLaunchProfile('dev-echo-adapter')) add('echo')
  return choices
}

/** One list per adapter per boot: the Claude list costs a process start,
 *  the Codex one an app-server start, and neither changes while the app
 *  runs. A list that failed is asked again next time. */
const modelLists = new Map<string, Promise<ModelOption[]>>()
export function providerModels(adapterId: string, cwd: string): Promise<ModelOption[]> {
  const cached = modelLists.get(adapterId)
  if (cached) return cached
  const adapter = sessionManager.getAdapter(adapterId)
  const listing: Promise<ModelOption[]> =
    adapter instanceof ClaudeAdapter
      ? adapter.listModels(cwd)
      : adapter instanceof CodexAdapter
        ? adapter.listModelsWithoutSession(
            cwd,
            launchProfileManager.resolve('codex', undefined, 'codex-chat'),
            buildSpawnEnv(getLoginShellEnv(), { codexHome: codexHomeForSpawn('codex', undefined) })
          )
        : adapter instanceof EchoAdapter
          ? adapter.models()
          : Promise.reject(new Error(`No model list without a session for ${adapterId}`))
  modelLists.set(adapterId, listing)
  listing.catch(() => modelLists.delete(adapterId))
  return listing
}

/** The installed Codex, on the login shell's PATH; null when it cannot be run. */
async function installedCodex(): Promise<{ bin: string; version: string } | null> {
  const bin = findExecutable('codex', getLoginShellEnv().PATH)
  if (!bin) return null
  try {
    return { bin, version: await codexVersion(bin) }
  } catch {
    return null
  }
}

/** The record of a session, with what a move reads off it. */
function sessionOf(sessionId: string): {
  adapterId: string
  cwd: string
  claudeSessionId?: string
  configDir?: string
} {
  const record = ptyManager.getSessionRecord(sessionId)
  const live = sessionManager.get(sessionId)
  if (!record && !live) throw new Error(`Unknown session: ${sessionId}`)
  return {
    adapterId: record?.adapterId ?? live?.adapterId ?? '',
    cwd: record?.cwd ?? live?.cwd ?? '',
    claudeSessionId: record?.claudeSessionId,
    configDir: record?.configDir
  }
}

/** The road a move of `sessionId` to `adapterId` takes, said before Continue. */
export async function planProviderSwitch(
  sessionId: string,
  adapterId: string
): Promise<ProviderSwitchPlan> {
  const session = sessionOf(sessionId)
  const transcript =
    session.adapterId === 'claude-chat' && session.claudeSessionId
      ? findTranscript(session.claudeSessionId, session.cwd, session.configDir)
      : null
  const codex = adapterId === 'codex-chat' ? await installedCodex() : null
  return planRoad({
    fromAdapterId: session.adapterId,
    toAdapterId: adapterId,
    transcriptFound: transcript !== null,
    codexVersion: codex?.version ?? null
  })
}

/** The conversation written as a Codex thread in the target account's home
 *  and read back through the real Codex (the bridge's own verify: a read,
 *  else one resume of a thread Codex never loaded). The thread id on
 *  success; the reason otherwise, and nothing to resume. */
export async function convertToCodex(
  sessionId: string,
  target: { codexAccountId?: string; model?: string }
): Promise<{ ok: true; threadId: string } | { ok: false; reason: string }> {
  const session = sessionOf(sessionId)
  if (session.adapterId !== 'claude-chat' || !session.claudeSessionId)
    return { ok: false, reason: 'Only a Claude conversation can be converted today.' }
  const transcript = findTranscript(session.claudeSessionId, session.cwd, session.configDir)
  if (!transcript) return { ok: false, reason: 'This conversation has no transcript on disk yet.' }
  const codex = await installedCodex()
  if (!codex) return { ok: false, reason: 'Codex could not be run on this Mac.' }
  let codexHome: string
  try {
    codexHome =
      codexHomeForSpawn('codex', target.codexAccountId) ??
      (getLoginShellEnv().CODEX_HOME?.trim() || join(app.getPath('home'), '.codex'))
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
  const converted = await convertTranscriptToCodex({
    transcript,
    codexHome,
    cwd: session.cwd,
    bin: codex.bin,
    ...(target.model ? { model: target.model } : {})
  })
  return converted.ok ? { ok: true, threadId: converted.threadId } : converted
}

/** The full conversation written beside the work, and the worktree's diff
 *  summary; a folder that is not a git checkout gives none. */
export async function writeHandoff(
  sessionId: string,
  tape: string
): Promise<{ path: string; diffStat: string | null }> {
  const session = sessionOf(sessionId)
  const dir = join(app.getPath('userData'), 'handoffs')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // One file per move: a second move of the same tab writes beside the first.
  const path = join(dir, `${sessionId}-${new Date().toISOString().replace(/[:.]/g, '-')}.md`)
  writeFileSync(path, tape, { mode: 0o600 })
  const diffStat = await new Promise<string | null>((resolve) => {
    execFile(
      'git',
      ['diff', '--stat'],
      { cwd: session.cwd, timeout: 10_000, env: getLoginShellEnv() },
      (error, stdout) => resolve(error ? null : String(stdout).trim() || null)
    )
  })
  return { path, diffStat }
}

export function registerProviderSwitchHandlers(): void {
  ipcMain.handle('adapters:list', () => providerChoices())
  ipcMain.handle('adapters:models', (_event, adapterId: unknown, cwd: unknown) => {
    if (typeof adapterId !== 'string' || typeof cwd !== 'string')
      throw new Error('adapters:models takes an adapter id and a folder')
    return providerModels(adapterId, cwd)
  })
  ipcMain.handle('provider-switch:plan', (_event, sessionId: unknown, adapterId: unknown) => {
    if (typeof sessionId !== 'string' || typeof adapterId !== 'string')
      throw new Error('provider-switch:plan takes a session id and an adapter id')
    return planProviderSwitch(sessionId, adapterId)
  })
  ipcMain.handle('provider-switch:convert', (_event, sessionId: unknown, target: unknown) => {
    if (typeof sessionId !== 'string') throw new Error('provider-switch:convert takes a session id')
    const t = (target ?? {}) as { codexAccountId?: unknown; model?: unknown }
    return convertToCodex(sessionId, {
      ...(typeof t.codexAccountId === 'string' ? { codexAccountId: t.codexAccountId } : {}),
      ...(typeof t.model === 'string' ? { model: t.model } : {})
    })
  })
  ipcMain.handle('provider-switch:handoff', (_event, sessionId: unknown, tape: unknown) => {
    if (typeof sessionId !== 'string' || typeof tape !== 'string')
      throw new Error('provider-switch:handoff takes a session id and the conversation')
    return writeHandoff(sessionId, tape)
  })
}
