import { randomUUID } from 'node:crypto'
import { ptyBackend, type PtySession, type PtySpawnOptions } from './sessions/adapters/pty-backend'
import { ptyAdapter } from './sessions/adapters/pty-adapter'
import { ClaudeAdapter } from './sessions/adapters/claude-adapter'
import { EchoAdapter } from './sessions/adapters/echo-adapter'
import { sessionManager } from './sessions/session-manager'
import { eventsProfile, isEchoLaunchProfile, launchProfileManager } from './launch-profile-manager'
import type { Session } from '../shared/session-model'

// Keep all existing helper/type imports stable while the process engine lives
// behind the adapter. No renderer PTY channel or spawn result changes.
export * from './sessions/adapters/pty-backend'
const echoAdapter = new EchoAdapter()
const claudeAdapter = new ClaudeAdapter()
sessionManager.registerAdapter(ptyAdapter)
sessionManager.registerAdapter(echoAdapter)
sessionManager.registerAdapter(claudeAdapter)

class PtyManager {
  private eventSessions = new Map<string, PtySession>()
  private listeners = new Map<string, () => void>()

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
    if (events?.id === 'claude-chat' && process.platform === 'win32')
      throw new Error('Claude chat sessions are not supported on Windows')
    const adapter = events
      ? sessionManager.getAdapter(events.adapterId)
      : echo
        ? echoAdapter
        : ptyAdapter
    if (!adapter) throw new Error(`Adapter unavailable: ${events?.adapterId}`)
    const isEvents = !!events || echo
    const session: PtySession = isEvents
      ? {
          id: randomUUID(),
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
      groupId: options?.link?.kind === 'group-terminal' ? options.link.groupId : undefined
    }
    if (isEvents && adapter.id === 'claude-chat') {
      session.claudeSessionId = options?.resumeSessionId ?? options?.claudeSessionId ?? randomUUID()
      claudeAdapter.configure(session.id, { ...options, claudeSessionId: session.claudeSessionId })
    }
    const handle = isEvents
      ? await adapter.spawn({
          ...record,
          options: {
            resume: options?.resumeSessionId,
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
    return session
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
        const session = this.eventSessions.get(id)
        if (session) {
          session.model = stream.event.model ?? undefined
        }
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
    if (!killTmuxSession && !this.eventSessions.has(id)) ptyAdapter.detach({ id })
    else await sessionManager.kill(id)
    this.listeners.get(id)?.()
    this.listeners.delete(id)
    this.eventSessions.delete(id)
    sessionManager.forget(id)
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
  setSessionViewRecord = ptyBackend.setSessionViewRecord.bind(ptyBackend)
  setSessionWorkspace = ptyBackend.setSessionWorkspace.bind(ptyBackend)
  setSessionClaudeSessionId = ptyBackend.setSessionClaudeSessionId.bind(ptyBackend)
  listAdoptableSessions = ptyBackend.listAdoptableSessions.bind(ptyBackend)
  discardSessionRecord = ptyBackend.discardSessionRecord.bind(ptyBackend)
}
export const ptyManager = new PtyManager()
