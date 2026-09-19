import { randomUUID } from 'node:crypto'
import { ptyBackend, type PtySession, type PtySpawnOptions } from './sessions/adapters/pty-backend'
import { ptyAdapter } from './sessions/adapters/pty-adapter'
import { EchoAdapter } from './sessions/adapters/echo-adapter'
import { sessionManager } from './sessions/session-manager'
import { isEchoLaunchProfile, launchProfileManager } from './launch-profile-manager'
import type { Session } from '../shared/session-model'

// Keep all existing helper/type imports stable while the process engine lives
// behind the adapter. No renderer PTY channel or spawn result changes.
export * from './sessions/adapters/pty-backend'
const echoAdapter = new EchoAdapter()
sessionManager.registerAdapter(ptyAdapter)
sessionManager.registerAdapter(echoAdapter)

class PtyManager {
  private echoSessions = new Map<string, PtySession>()
  private listeners = new Map<string, () => void>()

  spawn(cwd: string, options?: PtySpawnOptions): PtySession {
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
    const session: PtySession = echo
      ? {
          id: randomUUID(),
          cwd,
          folderName: cwd.split('/').pop() || cwd,
          alive: true,
          ptyProcess: null,
          launchProfileId: profileId
        }
      : ptyAdapter.prepare(cwd, options)
    const record: Session = {
      id: session.id,
      cwd,
      provider: echo
        ? 'echo'
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
      transport: echo ? 'events' : 'pty',
      adapterId: echo ? echoAdapter.id : ptyAdapter.id,
      windowKey: options?.windowKey ?? '',
      state: 'idle',
      createdAt: Date.now(),
      title: session.folderName,
      groupId: options?.link?.kind === 'group-terminal' ? options.link.groupId : undefined
    }
    const handle = echo ? echoAdapter.prepare(record) : session
    try {
      sessionManager.adopt(record, handle, echo ? echoAdapter : ptyAdapter)
    } catch (error) {
      if (echo) echoAdapter.kill(handle)
      else ptyAdapter.kill(handle)
      throw error
    }
    if (echo) this.echoSessions.set(session.id, session)
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
    if (sessionManager.get(id)) sessionManager.write(id, new TextEncoder().encode(data))
  }
  kill(id: string, killTmuxSession = true): void {
    if (!sessionManager.get(id)) return
    if (!killTmuxSession && !this.echoSessions.has(id)) ptyAdapter.detach({ id })
    else sessionManager.kill(id)
    this.listeners.get(id)?.()
    this.listeners.delete(id)
    this.echoSessions.delete(id)
    sessionManager.forget(id)
  }
  killAll(): void {
    for (const session of sessionManager.list()) this.kill(session.id, false)
  }
  getSession(id: string): PtySession | undefined {
    return this.echoSessions.get(id) ?? ptyBackend.getSession(id)
  }
  getAllSessions(): { id: string; cwd: string; folderName: string; alive: boolean }[] {
    return [...ptyBackend.getAllSessions(), ...this.echoSessions.values()].map(
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
