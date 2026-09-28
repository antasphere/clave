import { randomUUID } from 'node:crypto'
import {
  ptyBackend,
  buildSpawnEnv,
  codexHomeForSpawn,
  getLoginShellEnv,
  type PtySession,
  type PtySpawnOptions
} from './sessions/adapters/pty-backend'
import { codexRoot, findCodexThreadForSession, hasCodexRollout } from './session-history/codex'
import { ptyAdapter } from './sessions/adapters/pty-adapter'
import { ClaudeAdapter, findTranscript } from './sessions/adapters/claude-adapter'
import { CodexAdapter } from './sessions/adapters/codex-adapter'
import { EchoAdapter } from './sessions/adapters/echo-adapter'
import { sessionManager } from './sessions/session-manager'
import * as titleGenerator from './title-generator'
import { rememberedChatModel } from './sessions/chat-model-default'
import {
  defaultViewFor,
  eventsProfile,
  isEchoLaunchProfile,
  launchProfileManager
} from './launch-profile-manager'
import type { Session, UserMessageInput } from '../shared/session-model'

// Keep all existing helper/type imports stable while the process engine lives
// behind the adapter. No renderer PTY channel or spawn result changes.
export * from './sessions/adapters/pty-backend'
const echoAdapter = new EchoAdapter()
const claudeAdapter = new ClaudeAdapter()
sessionManager.registerAdapter(ptyAdapter)
sessionManager.registerAdapter(echoAdapter)
sessionManager.registerAdapter(claudeAdapter)
const codexAdapter = new CodexAdapter()
sessionManager.registerAdapter(codexAdapter)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The notices the CLI writes itself, in the model's place, when the account
 *  cannot take the turn: out of credits, the cap of the org or the seat, the
 *  usage limit of the plan. Read on a `<synthetic>` reply only. */
const CLAUDE_LIMIT_NOTICE =
  /out of usage credits|out of usage\b|usage credit cap|usage limit|hit your limit|limit reached/i

/**
 * Whether a provider's own frame says the account is out (ADR 0002): Claude's
 * `rate_limit_event` with a rejected status or the synthetic reply it writes
 * in the model's place ("You're out of usage credits…") — the CLI in `-p`
 * mode ends its process right after that reply, and the reply is the only
 * word some limits get; Codex's `account/rateLimits/updated` at the cap or
 * with a reached type. Pure, for the tests; every other frame is nothing.
 */
export function providerEventReportsLimit(provider: string, payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false
  const p = payload as Record<string, unknown>
  if (provider === 'claude') {
    if (p.type === 'assistant') {
      const message = p.message as Record<string, unknown> | undefined
      if (message?.model !== '<synthetic>' || !Array.isArray(message.content)) return false
      return message.content.some(
        (block) =>
          !!block &&
          typeof block === 'object' &&
          (block as Record<string, unknown>).type === 'text' &&
          CLAUDE_LIMIT_NOTICE.test(String((block as Record<string, unknown>).text ?? ''))
      )
    }
    if (p.type !== 'rate_limit_event') return false
    const info = p.rate_limit_info as Record<string, unknown> | undefined
    return info?.status === 'rejected'
  }
  if (provider === 'codex') {
    if (p.method !== 'account/rateLimits/updated') return false
    const params = p.params as Record<string, unknown> | undefined
    const limits = params?.rateLimits as Record<string, unknown> | undefined
    if (!limits) return false
    if (limits.rateLimitReachedType) return true
    for (const slot of ['primary', 'secondary']) {
      const w = limits[slot] as Record<string, unknown> | undefined
      if (w && typeof w.usedPercent === 'number' && w.usedPercent >= 95) return true
    }
  }
  return false
}

/** What a restart on another account changes: the account fields, and
 *  whether the message the limit rejected goes again on the new account. */
export interface RestartOverrides {
  claudeProfileId?: string
  claudeProfileLabel?: string
  codexAccountId?: string
  codexAccountLabel?: string
  resendRejected?: boolean
}

class PtyManager {
  private eventSessions = new Map<string, PtySession>()
  private listeners = new Map<string, () => void>()
  /** What each live session was spawned with, so a restart on another
   *  account (ADR 0002) rebuilds the same spawn with the account changed. */
  private spawns = new Map<string, { cwd: string; options?: PtySpawnOptions }>()
  /** A Codex chat session's thread, from the app-server's own meta. */
  private codexThreads = new Map<string, string>()
  private limitListeners = new Set<(sessionId: string) => void>()
  /** The message a chat session's account rejected, kept from the CLI's own
   *  report to the restart that resends it on the next account. */
  private rejected = new Map<string, UserMessageInput>()

  /** A chat session's CLI reported its account's limit (ADR 0002). */
  onLimitReported(listener: (sessionId: string) => void): () => void {
    this.limitListeners.add(listener)
    return () => this.limitListeners.delete(listener)
  }

  async spawn(cwd: string, options?: PtySpawnOptions): Promise<PtySession> {
    const family = options?.piMode
      ? 'pi'
      : options?.antigravityMode
        ? 'antigravity'
        : options?.codexMode
          ? 'codex'
          : options?.claudeAgentsMode || options?.claudeMode !== false
            ? 'claude'
            : null
    const profileId =
      options?.launchProfileId ??
      (family ? launchProfileManager.resolve(family, options?.workspaceId).id : undefined)
    const echo = isEchoLaunchProfile(profileId)
    if (profileId === 'dev-echo-adapter' && !echo) throw new Error('Echo adapter is disabled')
    const events = eventsProfile(profileId)
    if (events?.adapterId === 'claude-chat' && process.platform === 'win32')
      throw new Error('Claude chat sessions are not supported on Windows')
    const adapter = events
      ? sessionManager.getAdapter(events.adapterId)
      : echo
        ? echoAdapter
        : ptyAdapter
    if (!adapter) throw new Error(`Adapter unavailable: ${events?.adapterId}`)
    const isEvents = !!events || echo
    // A fresh chat that names no model starts on the one last picked in a
    // chat composer. A restored or resumed tab keeps its own, and a launch
    // that names a model (MCP, a .clave file) gets exactly that.
    const remembered =
      events && !options?.model && !options?.adoptSessionId && !options?.resumeSessionId
        ? rememberedChatModel(adapter.id)
        : undefined
    if (remembered) options = { ...options, model: remembered }
    const session: PtySession = isEvents
      ? {
          // A restored chat tab keeps its id, as a restored terminal does: the
          // sidebar layout, MCP addressing and capture all key on it.
          id:
            options?.adoptSessionId && UUID_RE.test(options.adoptSessionId)
              ? options.adoptSessionId
              : randomUUID(),
          cwd,
          folderName: cwd.split('/').pop() || cwd,
          alive: true,
          ptyProcess: null,
          launchProfileId: profileId,
          model: options?.model
        }
      : ptyAdapter.prepare(cwd, options)
    const record: Session = {
      id: session.id,
      cwd,
      provider: isEvents
        ? adapter.provider
        : options?.piMode
          ? 'pi'
          : options?.codexMode
            ? 'codex'
            : options?.antigravityMode
              ? 'antigravity'
              : options?.claudeAgentsMode
                ? 'claude-agents'
                : options?.claudeMode === false
                  ? 'terminal'
                  : 'claude',
      transport: isEvents ? 'events' : 'pty',
      adapterId: adapter.id,
      windowKey: options?.windowKey ?? '',
      state: 'idle',
      createdAt: Date.now(),
      title: session.folderName,
      groupId: options?.link?.kind === 'group-terminal' ? options.link.groupId : undefined,
      // The profile's default view, when it names one; the pane's picker
      // overwrites it on the record from there on.
      viewId: defaultViewFor(profileId)
    }
    // A restored chat tab that never got a message has an id but no
    // transcript (Claude) or rollout (Codex), and resuming it fails: it
    // relaunches fresh under the same id instead.
    const resume =
      options?.resumeSessionId &&
      ((adapter.id === 'claude-chat' &&
        !findTranscript(options.resumeSessionId, cwd, options.configDir)) ||
        (adapter.id === 'codex-chat' &&
          !hasCodexRollout(options.resumeSessionId, codexRoot(getLoginShellEnv()))))
        ? undefined
        : options?.resumeSessionId
    if (isEvents && adapter.id === 'claude-chat') {
      session.claudeSessionId = options?.resumeSessionId ?? options?.claudeSessionId ?? randomUUID()
      claudeAdapter.configure(session.id, {
        ...options,
        launchProfileId: profileId,
        claudeSessionId: session.claudeSessionId
      })
    }
    if (isEvents && adapter.id === 'codex-chat') {
      // The account's home reaches the app-server the way it reaches a
      // Codex terminal: synced now, set on the process (ADR 0002). The
      // launch's prompt rides along as it does for Claude chat: a workspace
      // session's prompt used to reach a Claude tab and never a Codex one.
      codexAdapter.configure(
        session.id,
        launchProfileManager.resolve('codex', options?.workspaceId, profileId),
        buildSpawnEnv(getLoginShellEnv(), {
          codexHome: codexHomeForSpawn('codex', options?.codexAccountId)
        }),
        options?.initialPrompt
      )
    }
    const handle = isEvents
      ? await adapter.spawn({
          ...record,
          options: {
            resume,
            model: options?.model,
            permissionMode: options?.dangerousMode
              ? adapter.provider === 'codex'
                ? 'never'
                : adapter.provider === 'claude'
                  ? 'bypassPermissions'
                  : undefined
              : undefined
          }
        })
      : session
    try {
      sessionManager.adopt(record, handle, adapter)
    } catch (error) {
      await adapter.kill(handle)
      throw error
    }
    if (isEvents) this.eventSessions.set(session.id, session)
    if (isEvents) session.startedAt = Date.now()
    this.spawns.set(session.id, { cwd, options })
    if (isEvents && (adapter.id === 'claude-chat' || adapter.id === 'codex-chat'))
      this.writeChatRecord(adapter.id, session, profileId, options, resume)
    // A fresh conversation is named by its first message (the terminal path
    // reads it off the transcript; a chat tab's crosses `sessions:write`). A
    // resumed one keeps the name it was saved under. The title runs the agent
    // the tab runs when that agent is Claude, on the tab's account; the title
    // generator's resolver names Claude for another agent's tab (Codex, a
    // plugin), never that agent's own command.
    if (isEvents && !resume)
      titleGenerator.scheduleChatTitle(session.id, {
        workspaceId: options?.workspaceId,
        launchProfileId: profileId,
        claudeProfileId: options?.claudeProfileId,
        configDir: options?.configDir
      })
    return session
  }

  /** A chat tab's session record: what brings it back after a quit, an
   *  update or a crash. Claude's resumes its `claudeSessionId`; Codex's resumes
   *  the thread the app-server opened, which is known only once the thread is
   *  up — a resumed tab carries it from the start, a fresh one gets it from
   *  its first `session_meta` (attachListeners). Without a record the tab is
   *  simply gone at the next launch, which is what every Codex chat tab was. */
  private writeChatRecord(
    adapterId: 'claude-chat' | 'codex-chat',
    session: PtySession,
    profileId: string | undefined,
    options: PtySpawnOptions | undefined,
    resume: string | undefined
  ): void {
    const codex = adapterId === 'codex-chat'
    ptyBackend.writeEventSessionRecord({
      adapterId,
      transport: 'events',
      id: session.id,
      claudeSessionId: codex ? undefined : session.claudeSessionId,
      codexThreadId: codex ? resume : undefined,
      cwd: session.cwd,
      folderName: session.folderName,
      claudeMode: !codex,
      antigravityMode: false,
      codexMode: codex,
      piMode: false,
      claudeAgentsMode: false,
      dangerousMode: options?.dangerousMode === true,
      model: options?.model,
      launchProfileId: profileId,
      configDir: codex ? undefined : options?.configDir,
      claudeProfileId: codex ? undefined : options?.claudeProfileId,
      claudeProfileLabel: codex ? undefined : options?.claudeProfileLabel,
      codexAccountId: codex ? options?.codexAccountId : undefined,
      codexAccountLabel: codex ? options?.codexAccountLabel : undefined,
      workspaceId: options?.workspaceId,
      windowKey: options?.windowKey
    })
  }

  attachListeners(
    id: string,
    onData: (data: string) => void,
    onExit: (code: number) => void
  ): void {
    this.listeners.get(id)?.()
    if (!sessionManager.get(id)) return
    const decoder = new TextDecoder()
    const stopStream = sessionManager.subscribe(id, (stream) => {
      if (stream.kind === 'event' && stream.event.type === 'session_meta') {
        // A meta naming no model means "the provider's default": it refines
        // nothing, so it never erases a model already known here.
        const session = this.eventSessions.get(id)
        if (session && stream.event.model) session.model = stream.event.model
        // The thread the app-server opened: what a restart resumes.
        if (sessionManager.get(id)?.adapterId === 'codex-chat' && stream.event.providerSessionId) {
          this.codexThreads.set(id, stream.event.providerSessionId)
          ptyBackend.setSessionCodexThreadId(id, stream.event.providerSessionId)
        }
      }
      if (
        stream.kind === 'event' &&
        stream.event.type === 'provider_event' &&
        providerEventReportsLimit(stream.event.provider, stream.event.payload)
      ) {
        const last = claudeAdapter.lastUserMessage(id)
        if (last) this.rejected.set(id, last)
        for (const listener of this.limitListeners) listener(id)
      }
      if (stream.kind === 'pty') onData(decoder.decode(stream.data, { stream: true }))
    })
    const stopExit = sessionManager.subscribeExit(id, (code) => {
      const session = this.getSession(id)
      if (session) session.alive = false
      onExit(code)
    })
    this.listeners.set(id, () => {
      stopStream()
      stopExit()
    })
  }

  start(id: string, cols: number, rows: number): void {
    if (sessionManager.get(id)) sessionManager.resize(id, cols, rows)
  }
  resize(id: string, cols: number, rows: number): void {
    if (sessionManager.get(id)) sessionManager.resize(id, cols, rows)
  }
  write(id: string, data: string): void {
    if (sessionManager.get(id)?.transport === 'pty')
      sessionManager.write(id, new TextEncoder().encode(data))
  }
  async kill(id: string, killTmuxSession = true): Promise<void> {
    if (!sessionManager.get(id)) return
    // A chat tab closed for good takes its record with it, first, so a kill
    // that throws cannot leave a closed tab to be offered back at the next
    // launch. On quit (killTmuxSession false) the record stays for the restore.
    if (killTmuxSession && this.eventSessions.has(id)) ptyBackend.discardSessionRecord(id)
    if (!killTmuxSession && !this.eventSessions.has(id)) ptyAdapter.detach({ id })
    else await sessionManager.kill(id)
    this.listeners.get(id)?.()
    this.listeners.delete(id)
    if (this.eventSessions.has(id)) titleGenerator.cleanup(id)
    this.eventSessions.delete(id)
    if (killTmuxSession) {
      this.spawns.delete(id)
      this.codexThreads.delete(id)
      this.rejected.delete(id)
    }
    sessionManager.forget(id)
  }

  /** The conversation a session would resume: Claude's session id, a Codex
   *  chat's thread, or the rollout a Codex terminal wrote (found by its cwd
   *  and start). Null when the session has nothing to resume. */
  conversationIdOf(id: string): string | null {
    const session = this.getSession(id)
    if (!session) return null
    if (session.claudeSessionId) return session.claudeSessionId
    const chatThread = this.codexThreads.get(id)
    if (chatThread) return chatThread
    const spawn = this.spawns.get(id)
    if (spawn?.options?.codexMode && session.startedAt) {
      return findCodexThreadForSession(
        session.cwd,
        session.startedAt,
        codexRoot(getLoginShellEnv())
      )
    }
    return null
  }

  /**
   * The spawn that brings a session back on another account (ADR 0002): the
   * same cwd, agent and profile, the conversation resumed, the tab's id kept
   * so the sidebar, the MCP addressing and the capture stay on it. Read
   * BEFORE the kill: the kill forgets the spawn. Null for a session this
   * process did not spawn (nothing to rebuild from).
   */
  restartSpawn(
    id: string,
    overrides: RestartOverrides
  ): { cwd: string; options: PtySpawnOptions; resumed: boolean } | null {
    const spawn = this.spawns.get(id)
    if (!spawn) return null
    const conversationId = this.conversationIdOf(id)
    const previous = spawn.options ?? {}
    const { resendRejected, ...account } = overrides
    const options: PtySpawnOptions = {
      ...previous,
      adoptSessionId: id,
      // A fresh tmux name: the old session may still be dying (see
      // killAndWait) and `-A` on its name would reattach the old process.
      adoptTmuxName: undefined,
      resumeSessionId: conversationId ?? undefined,
      claudeSessionId: undefined,
      piSessionId: undefined,
      // The prompt and the command ran once already.
      initialPrompt: undefined,
      initialCommand: undefined,
      autoExecute: undefined,
      // The message the limit rejected, when the move is the limit's doing:
      // the reader asked once and gets the answer on the next account.
      initialInput: resendRejected ? this.rejected.get(id) : undefined,
      ...account
    }
    return { cwd: spawn.cwd, options, resumed: conversationId !== null }
  }

  /** `kill`, resolved once a tmux-backed process is really gone. */
  async killAndWait(id: string): Promise<void> {
    const tmuxName = ptyBackend.tmuxNameOf(id)
    await this.kill(id, true)
    if (tmuxName) await ptyBackend.waitForTmuxSessionGone(tmuxName)
  }
  async killAll(): Promise<void> {
    await Promise.all(sessionManager.list().map((session) => this.kill(session.id, false)))
  }
  getSession(id: string): PtySession | undefined {
    return this.eventSessions.get(id) ?? ptyBackend.getSession(id)
  }
  getAllSessions(): { id: string; cwd: string; folderName: string; alive: boolean }[] {
    return [...ptyBackend.getAllSessions(), ...this.eventSessions.values()].map(
      ({ id, cwd, folderName, alive }) => ({ id, cwd, folderName, alive })
    )
  }
  tmuxNameOf(id: string): string | null {
    return ptyBackend.tmuxNameOf(id)
  }
  setSessionDisplayName(id: string, name: string | null, userRenamed: boolean): void {
    const session = this.getSession(id)
    if (session) sessionManager.update(id, { title: name?.trim() || session.folderName })
    ptyBackend.setSessionDisplayName(id, name, userRenamed)
  }
  setSessionWindowKey(id: string, windowKey: string): void {
    if (sessionManager.get(id)) sessionManager.update(id, { windowKey })
    ptyBackend.setSessionWindowKey(id, windowKey)
  }
  /** The persisted record of a live session, as it is now. */
  getSessionRecord = ptyBackend.getSessionRecord.bind(ptyBackend)
  setSessionViewRecord = ptyBackend.setSessionViewRecord.bind(ptyBackend)
  setSessionWorkspace = ptyBackend.setSessionWorkspace.bind(ptyBackend)
  setSessionClaudeSessionId = ptyBackend.setSessionClaudeSessionId.bind(ptyBackend)
  listAdoptableSessions = ptyBackend.listAdoptableSessions.bind(ptyBackend)
  discardSessionRecord = ptyBackend.discardSessionRecord.bind(ptyBackend)
}
export const ptyManager = new PtyManager()
