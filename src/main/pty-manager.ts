import { randomUUID } from 'node:crypto'
import path from 'node:path'
import {
  buildAgentArgv,
  isCodexRung,
  profileSetsPermissions,
  sanitizeCarriedLaunchProfile,
  type LauncherFamily
} from '../shared/agent-launch'
import { HARNESS_BY_ID, sanitizeHarnessSettings } from '../shared/harness'
import { preferencesManager } from './preferences-manager'
import { findExecutable } from './shell-launch'
import { accountOverrides } from './restart-overrides'
import { dismissSessionOffers } from './copy-offer-manager'
import { terminalJournal } from './terminal-journal'
import { lastHookState } from './agent-state-manager'
import {
  ptyBackend,
  accountTokenForSpawn,
  buildSpawnEnv,
  codexHomeForSpawn,
  getLoginShellEnv,
  type PtySession,
  type PtySpawnOptions
} from './sessions/adapters/pty-backend'
import {
  piSessionLookupEnv,
  providerInjectionForSpawn,
  type ProviderSpawnFields
} from './provider-injection-spawn'
import { opencodeConfiguredModel } from './provider-injection'
import { lineageOf } from './sessions/lineage'
import { limitLiftedBy, limitReportOf } from './sessions/limit-report'
import type { LimitReport } from '../shared/limit-report'
import { runtimeChoices } from '../shared/runtime-choices'

/** The runtime choices a restart carries (PRDCT-4191): the record's, which
 *  the provider's acknowledgements keep current, over the launch's. A record
 *  that never heard the provider changes nothing of the spawn's own. */
function restartRuntime(
  record: {
    model?: string
    dangerousMode?: boolean
    permissionMode?: string
    effort?: string
  } | null,
  previous: { model?: string; dangerousMode?: boolean; permissionMode?: string; effort?: string }
): Pick<
  PtySpawnOptions,
  'model' | 'dangerousMode' | 'permissionMode' | 'effort' | 'allowDangerous'
> {
  if (!record) return {}
  const runtime = runtimeChoices({ ...previous, ...record })
  return {
    ...(runtime.model !== undefined ? { model: runtime.model } : {}),
    dangerousMode: runtime.dangerousMode,
    ...(runtime.permissionMode !== undefined ? { permissionMode: runtime.permissionMode } : {}),
    ...(runtime.allowDangerous ? { allowDangerous: true } : {}),
    ...(runtime.effort !== undefined ? { effort: runtime.effort } : {})
  }
}
/** The rung a harness's launches start on when the spawn names none: the
 *  person's setting, kept only when it is a rung of that harness's ladder.
 *  Read off the preferences as `getLaunchSettings` reads them, without its
 *  Electron half: the session host runs in the standalone server too. */
function permissionDefaultFor(family: LauncherFamily): string | undefined {
  const rung = sanitizeHarnessSettings(preferencesManager.get('harnessSettings'))[family]
    ?.permissionDefault
  return rung && HARNESS_BY_ID[family].permissionRungs.some((entry) => entry.id === rung)
    ? rung
    : undefined
}
import { sanitizeWork, type WorkAssignment } from '@clave/contract/work-rules'
import type { ContinuedFrom } from '@clave/contract/sessions'
import {
  familyOfOptions,
  isTransportSwitch,
  providerSwitchOptions,
  transportSwitchOptions,
  transportTarget
} from './sessions/provider-switch'
import { codexRoot, findCodexThreadForSession, hasCodexRollout } from './session-history/codex'
import { findPiSession } from './session-history/pi'
import { ptyAdapter } from './sessions/adapters/pty-adapter'
import { ClaudeAdapter, findTranscript } from './sessions/adapters/claude-adapter'
import { CodexAdapter } from './sessions/adapters/codex-adapter'
import { AcpAdapter } from './sessions/adapters/acp-adapter'
import { PiRpcAdapter } from './sessions/adapters/pi-rpc-adapter'
import { EchoAdapter } from './sessions/adapters/echo-adapter'
import { installE2eHooks } from './sessions/e2e-hooks'
import { noteSize } from './sessions/terminal-screen'
import { sessionManager } from './sessions/session-manager'
import * as titleGenerator from './title-generator'
import * as exchangeDigest from './exchange-digest'
import { rememberedChatEffort, rememberedChatModel } from './sessions/chat-model-default'
import { sessionModelChanged } from './server/session-events'
import { initialChatView } from './sessions/chat-view-default'
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
// The suite's way to inject a frame into an echo session, in test mode only
// (`sessions/e2e-hooks.ts`); outside test mode nothing is installed.
installE2eHooks({ echo: { inject: (id, stream) => echoAdapter.inject(id, stream) } })
const claudeAdapter = new ClaudeAdapter()
sessionManager.registerAdapter(ptyAdapter)
sessionManager.registerAdapter(echoAdapter)
sessionManager.registerAdapter(claudeAdapter)
const codexAdapter = new CodexAdapter()
sessionManager.registerAdapter(codexAdapter)
// Lane D (PRDCT-4427): OpenCode in the chat view, over the Agent Client
// Protocol its own binary speaks (`opencode acp`).
const opencodeChatAdapter = new AcpAdapter({
  id: 'opencode-chat',
  provider: 'opencode',
  label: 'OpenCode'
})
sessionManager.registerAdapter(opencodeChatAdapter)
// Lane D (PRDCT-4427): Pi in the chat view, over Pi's own rpc mode
// (`pi --mode rpc`).
const piChatAdapter = new PiRpcAdapter({ id: 'pi-chat', provider: 'pi', label: 'Pi' })
sessionManager.registerAdapter(piChatAdapter)
/** The chat adapters whose tab keeps a session record (lane D, PRDCT-4427). */
type ChatRecordAdapter = 'claude-chat' | 'codex-chat' | 'opencode-chat' | 'pi-chat'
const CHAT_RECORD_ADAPTERS = new Set<string>([
  'claude-chat',
  'codex-chat',
  'opencode-chat',
  'pi-chat'
])

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The CLI's own word on its account's limit moved to `sessions/limit-report.ts`
 *  (PRDCT-4302), where it reads WHICH cap was hit; re-exported for the callers
 *  that only ask whether it was. */
export { limitReportOf, providerEventReportsLimit } from './sessions/limit-report'

/** What a restart on another account changes: the account fields, and
 *  whether the message the limit rejected goes again on the new account. */
export interface RestartOverrides {
  claudeProfileId?: string
  claudeProfileLabel?: string
  codexAccountId?: string
  codexAccountLabel?: string
  resendRejected?: boolean
  /** A Resume: refused while the session runs (PRDCT-4193). */
  onlyIfStopped?: boolean
  /** The tab comes back on another provider (PRDCT-4300): the adapter, the
   *  model, the thread to resume there or the first message to send, and
   *  the note the first card reads (`sessions/provider-switch.ts`). */
  adapterId?: string
  model?: string
  resume?: string
  firstMessage?: string
  continuedFrom?: ContinuedFrom
  /** Lane D (PRDCT-4427): the view the tab opens in after a move onto its
   *  family's chat adapter (`<pluginId>/<viewId>`); ignored on a move to the
   *  terminal. */
  viewId?: string
}

class PtyManager {
  private eventSessions = new Map<string, PtySession>()
  private listeners = new Map<string, () => void>()
  /** What each live session was spawned with, so a restart on another
   *  account (ADR 0002) rebuilds the same spawn with the account changed. */
  private spawns = new Map<string, { cwd: string; options?: PtySpawnOptions }>()
  /** A Codex chat session's thread, from the app-server's own meta. */
  private codexThreads = new Map<string, string>()
  /** An OpenCode chat session's id, from the ACP agent's own meta (lane D,
   *  PRDCT-4427). */
  private opencodeSessions = new Map<string, string>()
  private limitListeners = new Set<(sessionId: string, report: LimitReport) => void>()
  /** The limit report still open on a session (ADR 0002, PRDCT-4302): the
   *  message the CLI's report rejected, whatever cap the CLI typed (its enum
   *  has no Fable value and types a Fable rejection as a plain week, so the
   *  WINDOW decides the rung from its read, never main). Closed when that
   *  message goes again on another model, when a restart carries it, or when
   *  the person writes something else. While it is open, the next model the
   *  provider confirms resends that one message. */
  private openReports = new Map<string, UserMessageInput>()
  /** The sessions whose window holds a limit report (PRDCT-4415): reported,
   *  and no turn served since. The provider's next word that the account
   *  serves again closes it there, whatever closed `openReports` here. */
  private reported = new Set<string>()
  /** A report the restart now under way carries across its kill (PRDCT-4422):
   *  the window keeps a report through a restart on the same account (a
   *  Resume once the cap is back, an agent update), so main must still know
   *  it is open when the new process serves its first turn. One-shot: the
   *  kill that follows consumes it. */
  private carriedReports = new Set<string>()
  private clearedListeners = new Set<(sessionId: string) => void>()
  /** The message a chat session's account rejected, kept from the CLI's own
   *  report to the restart that resends it on the next account. */
  private rejected = new Map<string, UserMessageInput>()

  /** A chat session's CLI reported its account's limit (ADR 0002), and which
   *  cap it hit (PRDCT-4302). */
  onLimitReported(listener: (sessionId: string, report: LimitReport) => void): () => void {
    this.limitListeners.add(listener)
    return () => this.limitListeners.delete(listener)
  }

  /** The account served a session a turn again after its limit report
   *  (PRDCT-4415): the window closes the report it holds. */
  onLimitCleared(listener: (sessionId: string) => void): () => void {
    this.clearedListeners.add(listener)
    return () => this.clearedListeners.delete(listener)
  }

  async spawn(cwd: string, options?: PtySpawnOptions): Promise<PtySession> {
    // The journal (test mode only) sees every spawn here, below IPC and the
    // server alike, before anything can refuse it: the specs that assert a
    // launch read it where they used to tap `pty:spawn` inside main.
    terminalJournal()?.spawn(cwd, options)
    const family = options?.piMode
      ? 'pi'
      : options?.opencodeMode
        ? 'opencode'
        : options?.antigravityMode
          ? 'antigravity'
          : options?.codexMode
            ? 'codex'
            : options?.claudeAgentsMode || options?.claudeMode !== false
              ? 'claude'
              : null
    const carried =
      family && options?.launchProfile
        ? sanitizeCarriedLaunchProfile(options.launchProfile)
        : undefined
    if (options?.launchProfile && family && !carried)
      throw new Error('The carried launch profile is not valid')
    if (carried && carried.family !== family)
      throw new Error(`Launch profile "${carried.name}" is for ${carried.family}, not ${family}`)
    options = { ...options, launchProfile: carried ?? undefined }
    // The person's permission default (Settings → Harnesses, PRDCT-4423,
    // PRDCT-4424) for a spawn that names no mode and does not skip the
    // permissions: the launcher's, an agent's and a routine's launches alike;
    // a mode the spawn names (a routine's own, a restart's) wins. The rung is
    // checked against the harness's ladder; its bypass rung is the dangerous
    // flag, never a mode passed as such.
    // A profile that sets its own permissions keeps them (verifier, round 2).
    const ownProfile = family
      ? (carried ??
        launchProfileManager.resolve(family, options?.workspaceId, options?.launchProfileId))
      : undefined
    if (
      family &&
      !options.claudeAgentsMode &&
      !options.dangerousMode &&
      !options.permissionMode &&
      !(ownProfile && profileSetsPermissions(ownProfile))
    ) {
      const rung = permissionDefaultFor(family)
      if (rung === HARNESS_BY_ID[family].bypassRung) options = { ...options, dangerousMode: true }
      else if (rung)
        options = {
          ...options,
          // The spawn options still type Claude's modes alone; the argv
          // builder takes each harness's own rung.
          permissionMode: rung as PtySpawnOptions['permissionMode']
        }
    }
    const profileId =
      carried?.id ??
      options?.launchProfileId ??
      (family ? launchProfileManager.resolve(family, options?.workspaceId).id : undefined)
    const echo = isEchoLaunchProfile(profileId)
    if (carried && !echo) {
      const program = carried.command[0].includes('/')
        ? path.resolve(cwd, carried.command[0])
        : carried.command[0]
      if (!findExecutable(program, getLoginShellEnv().PATH))
        throw new Error(
          `Program "${carried.command[0]}" was not found on this server (launch profile "${carried.name}")`
        )
    }
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
    // The effort last picked goes with every chat, a restored one included:
    // the record does not keep the one a tab ran at, and the last pick is
    // what the reader would pick again.
    // A launch that names an effort (a routine, ADR 0004) gets exactly that.
    const effort = isEvents ? (options?.effort ?? rememberedChatEffort(adapter.id)) : undefined
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
      : ptyAdapter.prepare(cwd, {
          ...options,
          // The account's token, decrypted here where the spawn is already
          // asynchronous, for the synchronous plan below (and only for a
          // Claude session: accountTokenForSpawn opens the store for no other).
          oauthToken: await accountTokenForSpawn(
            options?.claudeAgentsMode ? 'claude-agents' : family === 'claude' ? 'claude' : null,
            options?.claudeProfileId
          ),
          // A Pi or OpenCode tab's stored connection, opened the same way and
          // for those two alone (PRDCT-4496).
          ...(await providerInjectionForSpawn(family, {
            connectionId: options?.connectionId,
            model: options?.model
          }))
        })
    // A live tmux session this process takes BACK (an app relaunch, a move
    // from another window) is born with the word its hooks last wrote, not
    // idle: the hook watch forwards a change only, so a tab adopted while its
    // agent works read idle until the agent's next word (PRDCT-3289). A dead
    // record relaunched fresh, and a chat, start idle as before.
    const reattached =
      !isEvents &&
      options?.tmuxMode === true &&
      !!options?.adoptTmuxName &&
      !!options?.adoptSessionId
    const record: Session = {
      id: session.id,
      cwd,
      provider: isEvents
        ? adapter.provider
        : options?.piMode
          ? 'pi'
          : options?.opencodeMode
            ? 'opencode'
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
      state: reattached ? (lastHookState(session.id) ?? 'idle') : 'idle',
      createdAt: Date.now(),
      title: session.folderName,
      groupId: options?.link?.kind === 'group-terminal' ? options.link.groupId : undefined,
      // The tab's own view when a restart carries it; else the view a new
      // chat opens in (the interaction mode's, `initialChatView`), or the
      // profile's default for a terminal. The pane's picker overwrites it on
      // the record from there on.
      viewId:
        options?.viewId ??
        (isEvents ? initialChatView(defaultViewFor(profileId)) : defaultViewFor(profileId))
    }
    // A Pi or OpenCode chat on a stored connection opens it the way the
    // terminal does (PRDCT-4496): its variables on the process alone, Pi's
    // provider on its command line, never on the record. Read from the
    // options at every spawn, so a key fixed in Settings reaches the next
    // Resume; a refusal (gone, no key) ends the spawn here, before any
    // process starts. A chat on no connection keeps the login shell's
    // environment as it was.
    const chatConnection: ProviderSpawnFields =
      isEvents &&
      options?.connectionId &&
      (adapter.id === 'opencode-chat' || adapter.id === 'pi-chat')
        ? await providerInjectionForSpawn(adapter.id === 'pi-chat' ? 'pi' : 'opencode', {
            connectionId: options.connectionId,
            model: options.model
          })
        : {}
    const chatEnvAccount = chatConnection.providerEnv
      ? { providerEnv: chatConnection.providerEnv }
      : {}
    // Pi keeps its sessions under the directory it runs in: the connection's,
    // when the chat names one, so the guard below looks there.
    const piHome = chatConnection.providerEnv?.PI_CODING_AGENT_DIR
    const piLookupEnv = piHome
      ? { ...getLoginShellEnv(), PI_CODING_AGENT_DIR: piHome }
      : getLoginShellEnv()
    // A restored chat tab that never got a message has an id but no
    // transcript (Claude) or rollout (Codex), and resuming it fails: it
    // relaunches fresh under the same id instead. An OpenCode chat's id is
    // passed as given: the ACP adapter falls back to a new session, with a
    // notice, when the agent refuses the load (lane D, PRDCT-4427).
    const resume =
      options?.resumeSessionId &&
      ((adapter.id === 'claude-chat' &&
        !findTranscript(options.resumeSessionId, cwd, options.configDir)) ||
        (adapter.id === 'codex-chat' &&
          !hasCodexRollout(options.resumeSessionId, codexRoot(getLoginShellEnv()))) ||
        // Lane D (PRDCT-4427): a Pi session exists once Pi wrote its file
        // (at the first message); until then the chat starts under its id.
        (adapter.id === 'pi-chat' && !findPiSession(options.resumeSessionId, cwd, piLookupEnv)))
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
        carried ?? launchProfileManager.resolve('codex', options?.workspaceId, profileId),
        buildSpawnEnv(getLoginShellEnv(), {
          codexHome: codexHomeForSpawn('codex', options?.codexAccountId)
        }),
        options?.initialPrompt
      )
    }
    // Lane D (PRDCT-4427): the binary and `acp` alone. A saved profile's
    // `additionalArgs` (`--auto`, a `--session`) are the TUI's words, not the
    // protocol's; the ACP agent asks its permissions over the protocol.
    if (isEvents && adapter.id === 'opencode-chat') {
      const opencodeProfile =
        carried ?? launchProfileManager.resolve('opencode', options?.workspaceId, profileId)
      opencodeChatAdapter.configure(session.id, {
        command: [opencodeProfile.command[0] ?? 'opencode', 'acp'],
        env: buildSpawnEnv(getLoginShellEnv(), chatEnvAccount),
        initialPrompt: options?.initialPrompt
      })
    }
    // Lane D (PRDCT-4427): Pi's chat runs Pi's own command line, built as the
    // terminal's is (`buildAgentArgv`), in rpc mode. The session id is
    // Clave's: resumed (`--session`) when Pi wrote its file, else started
    // under it (`--session-id`), the id the terminal resumes later. The state
    // extension is the terminal's, never the chat's.
    if (isEvents && adapter.id === 'pi-chat') {
      const piProfile =
        carried ?? launchProfileManager.resolve('pi', options?.workspaceId, profileId)
      session.piSessionId = options?.resumeSessionId ?? randomUUID()
      const argv = buildAgentArgv({
        kind: 'pi',
        profile: piProfile,
        sessionId: resume ? undefined : session.piSessionId,
        resumeSessionId: resume,
        model: options?.model,
        provider: chatConnection.piProvider ?? options?.piProvider,
        thinking: options?.piThinking
      })
      piChatAdapter.configure(session.id, {
        command: [...argv, '--mode', 'rpc'],
        env: buildSpawnEnv(getLoginShellEnv(), chatEnvAccount),
        initialPrompt: options?.initialPrompt
      })
    }
    const handle = isEvents
      ? await adapter.spawn({
          ...record,
          options: {
            resume,
            // An OpenCode chat on a connection opens its session on the model
            // its configuration names, in OpenCode's `provider/model`: that is
            // the model the adapter expects, so it switches nothing and says
            // nothing about a bare id OpenCode would not list.
            model:
              (adapter.id === 'opencode-chat'
                ? opencodeConfiguredModel(chatConnection.providerEnv)
                : undefined) ?? options?.model,
            effort,
            // The echo fixture takes its launch prompt here; Claude's,
            // Codex's, OpenCode's and Pi's come through their configure above.
            ...(echo && options?.initialPrompt ? { initialPrompt: options.initialPrompt } : {}),
            // Lane D (PRDCT-4427): the ACP agent asks its permissions over
            // the protocol; a launch that skips them answers allow itself.
            autoApprove:
              adapter.id === 'opencode-chat' && options?.dangerousMode === true ? true : undefined,
            permissionMode: options?.dangerousMode
              ? adapter.provider === 'codex'
                ? 'never'
                : adapter.provider === 'claude'
                  ? 'bypassPermissions'
                  : undefined
              : // ADR 0004: the mode a routine asks under when its permissions
                // stay on; the CLI spells the ask-every-time mode `manual`.
                adapter.provider === 'claude' && options?.permissionMode
                ? options.permissionMode === 'default'
                  ? 'manual'
                  : options.permissionMode
                : undefined,
            // Bypass kept reachable to a Claude chat resumed in another mode
            // when its launch had it (PRDCT-4191).
            allowDangerous:
              adapter.provider === 'claude' && options?.allowDangerous === true ? true : undefined,
            // What `--yolo` means to a Codex terminal: no approvals AND no
            // sandbox. The app-server takes the two separately, and without
            // this a dangerous chat ran in the config's sandbox.
            sandbox:
              options?.dangerousMode && adapter.provider === 'codex'
                ? 'danger-full-access'
                : undefined,
            // A Codex chat's rung (PRDCT-4424): the thread's sandbox and
            // approval policy, over the profile's flags (`codexRungPolicy`).
            permissionRung:
              adapter.provider === 'codex' &&
              !options?.dangerousMode &&
              isCodexRung(options?.permissionMode)
                ? options.permissionMode
                : undefined
          }
        })
      : session
    try {
      sessionManager.adopt(record, handle, adapter, { model: options?.model ?? null })
    } catch (error) {
      await adapter.kill(handle)
      throw error
    }
    if (isEvents) this.eventSessions.set(session.id, session)
    if (isEvents) session.startedAt = Date.now()
    this.spawns.set(session.id, { cwd, options })
    if (isEvents && CHAT_RECORD_ADAPTERS.has(adapter.id))
      this.writeChatRecord(adapter.id as ChatRecordAdapter, session, profileId, options, resume)
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
    adapterId: ChatRecordAdapter,
    session: PtySession,
    profileId: string | undefined,
    options: PtySpawnOptions | undefined,
    resume: string | undefined
  ): void {
    const codex = adapterId === 'codex-chat'
    // Lane D (PRDCT-4427): each family's own fields, the Claude account's for
    // a Claude chat alone (an OpenCode chat has no account of either kind).
    const claude = adapterId === 'claude-chat'
    const opencode = adapterId === 'opencode-chat'
    const pi = adapterId === 'pi-chat'
    // A restored tab rewrites the record it was restored from: the name lives
    // only there, so it must be carried over or the tab survives one restart
    // with its name and comes back as its folder at the next.
    const previous = options?.adoptSessionId ? ptyBackend.getSessionRecord(session.id) : null
    ptyBackend.writeEventSessionRecord({
      adapterId,
      transport: 'events',
      id: session.id,
      claudeSessionId: claude ? session.claudeSessionId : undefined,
      codexThreadId: codex ? resume : undefined,
      opencodeSessionId: opencode ? resume : undefined,
      // Lane D (PRDCT-4427): a Pi chat's session, Clave's own id from the
      // start, and the provider and thinking it was launched on.
      piSessionId: pi ? session.piSessionId : undefined,
      piProvider: pi ? options?.piProvider : undefined,
      piThinking: pi ? options?.piThinking : undefined,
      // The stored connection a Pi or OpenCode chat runs on (PRDCT-4496), so
      // a restored tab opens it again; its name only, never its value.
      connectionId: pi || opencode ? options?.connectionId : undefined,
      connectionLabel: pi || opencode ? options?.connectionLabel : undefined,
      cwd: session.cwd,
      folderName: session.folderName,
      displayName: previous?.displayName,
      userRenamed: previous?.userRenamed,
      claudeMode: claude,
      antigravityMode: false,
      codexMode: codex,
      piMode: pi,
      opencodeMode: opencode,
      claudeAgentsMode: false,
      // Whether bypass is available to the chat: launched skipping the
      // permissions, or resumed in another mode with bypass kept reachable.
      dangerousMode: options?.dangerousMode === true || options?.allowDangerous === true,
      model: options?.model,
      launchProfileId: profileId,
      launchProfile: options?.launchProfile,
      configDir: claude ? options?.configDir : undefined,
      claudeProfileId: claude ? options?.claudeProfileId : undefined,
      claudeProfileLabel: claude ? options?.claudeProfileLabel : undefined,
      codexAccountId: codex ? options?.codexAccountId : undefined,
      codexAccountLabel: codex ? options?.codexAccountLabel : undefined,
      workspaceId: options?.workspaceId,
      windowKey: options?.windowKey,
      // What this session is the hidden half of (a routine's run, ADR 0004):
      // the PTY record carried it, the events record did not, and a chat run
      // came back as a sidebar tab at the next boot (round 1, F2).
      link: options?.link,
      spawnedBy: lineageOf(session.id, options?.spawnedBy, previous?.spawnedBy),
      // The opener, nested or not (PRDCT-4192), the same way.
      openedBy: lineageOf(session.id, options?.openedBy, previous?.openedBy),
      // What the chat starts running on (PRDCT-4191): the launch's mode and
      // effort when the spawn names them; the provider's own word overwrites
      // them as it comes (`setSessionRuntime`, attachListeners).
      ...(options?.permissionMode !== undefined ? { permissionMode: options.permissionMode } : {}),
      ...(options?.effort !== undefined ? { effort: options.effort } : {}),
      // Which work it does (PRDCT-4123): a restart's, else the record's.
      work: sanitizeWork(options?.work) ?? sanitizeWork(previous?.work),
      // Where the conversation came from (PRDCT-4300): a restart's, else the
      // record's, so a converted tab keeps its card across an account switch.
      ...((options?.continuedFrom ?? previous?.continuedFrom)
        ? { continuedFrom: options?.continuedFrom ?? previous?.continuedFrom }
        : {})
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
        if (session && stream.event.model) {
          const changed = session.model !== stream.event.model
          session.model = stream.event.model
          // On the record too (PRDCT-4191): a Resume relaunches on it.
          ptyBackend.setSessionRuntime(id, { model: stream.event.model })
          // And to the windows (PRDCT-4256): the sidebar's store used to keep
          // the launch model for the tab's whole life, so its foot judged the
          // caps by a model the chat had long left.
          sessionModelChanged(id, stream.event.model)
          // A family's cap rejected a turn and the model changed (the policy's
          // model rung, or the person from the chip): the message the cap
          // rejected goes again on the new model, once, while the report is
          // still open and the message is still the person's last (PRDCT-4302).
          if (changed) this.resendOnModelChange(id)
        }
        // The thread the app-server opened: what a restart resumes.
        if (sessionManager.get(id)?.adapterId === 'codex-chat' && stream.event.providerSessionId) {
          this.codexThreads.set(id, stream.event.providerSessionId)
          ptyBackend.setSessionCodexThreadId(id, stream.event.providerSessionId)
        }
        // Lane D (PRDCT-4427): the OpenCode session the ACP agent opened.
        if (
          sessionManager.get(id)?.adapterId === 'opencode-chat' &&
          stream.event.providerSessionId
        ) {
          this.opencodeSessions.set(id, stream.event.providerSessionId)
          ptyBackend.setSessionOpencodeSessionId(id, stream.event.providerSessionId)
        }
      }
      // The mode and the effort the chat runs at, as the provider says them
      // (PRDCT-4191): kept on the record, so the tab comes back in them.
      if (stream.kind === 'event' && this.eventSessions.has(id)) {
        if (stream.event.type === 'permission_mode')
          ptyBackend.setSessionRuntime(id, { permissionMode: stream.event.mode })
        else if (stream.event.type === 'effort')
          ptyBackend.setSessionRuntime(id, { effort: stream.event.effort })
      }
      if (stream.kind === 'event' && stream.event.type === 'provider_event') {
        const report = limitReportOf(stream.event.provider, stream.event.payload)
        if (report) {
          const last = claudeAdapter.lastUserMessage(id)
          if (last) this.rejected.set(id, last)
          // The message the cap rejected is owed on whichever way on the
          // window takes: the account rung's restart carries it, a model
          // change resends it.
          if (last) this.openReports.set(id, last)
          this.reported.add(id)
          for (const listener of this.limitListeners) listener(id, report)
        } else if (
          this.reported.has(id) &&
          limitLiftedBy(stream.event.provider, stream.event.payload)
        ) {
          this.reported.delete(id)
          for (const listener of this.clearedListeners) listener(id)
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

  /** The message a cap rejected goes again on the model the provider just
   *  confirmed (PRDCT-4302), once, while that report is still open on the
   *  session and the message is still the person's last: the CLI's own advice
   *  was to switch model, and the question was never answered. The account
   *  rung's restart carries it instead (`initialInput`) and closes the
   *  report; a hand switch with no open report never resends. */
  private resendOnModelChange(id: string): void {
    const owed = this.openReports.get(id)
    if (!owed) return
    this.openReports.delete(id)
    if (claudeAdapter.lastUserMessage(id) !== owed) return
    if (!sessionManager.get(id)) return
    sessionManager.write(id, owed)
    this.rejected.delete(id)
  }

  start(id: string, cols: number, rows: number): void {
    if (!sessionManager.get(id)) return
    // The size the pane gave is what a screen read renders at (wave 4).
    noteSize(id, cols, rows)
    sessionManager.resize(id, cols, rows)
  }
  resize(id: string, cols: number, rows: number): void {
    if (!sessionManager.get(id)) return
    noteSize(id, cols, rows)
    sessionManager.resize(id, cols, rows)
  }
  write(id: string, data: string): void {
    terminalJournal()?.write(id, data)
    if (sessionManager.get(id)?.transport === 'pty')
      sessionManager.write(id, new TextEncoder().encode(data))
  }
  async kill(id: string, killTmuxSession = true): Promise<void> {
    if (!sessionManager.get(id)) {
      // A stopped tab, placed by a restart and never resumed (PRDCT-4236),
      // has no process here: only its record. A close for good takes the
      // record too, or the next launch brings the closed tab back. Found by
      // its id, since a record may be keyed by its tmux name.
      if (killTmuxSession) {
        const record = ptyBackend.listAdoptableSessions().find((r) => r.id === id)
        if (record) ptyBackend.discardSessionRecord(record.tmuxName ?? record.id)
      }
      return
    }
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
      this.opencodeSessions.delete(id)
      this.rejected.delete(id)
      this.openReports.delete(id)
      if (!this.carriedReports.delete(id)) this.reported.delete(id)
      // Copy offers are surfaced in the tab's own header: once the tab is
      // gone they are unreachable, so their values leave memory with it.
      dismissSessionOffers(id)
    }
    sessionManager.forget(id)
  }

  /** The launch a helper run for this session runs as (PRDCT-4331, the
   *  permission explainer): the session's workspace, profile and account.
   *  Empty for a session this process did not spawn. */
  launchContextOf(id: string): {
    workspaceId?: string
    launchProfileId?: string
    claudeProfileId?: string
    configDir?: string
  } {
    const options = this.spawns.get(id)?.options
    if (!options) return {}
    return {
      workspaceId: options.workspaceId,
      launchProfileId: options.launchProfile?.id ?? options.launchProfileId,
      claudeProfileId: options.claudeProfileId,
      configDir: options.configDir
    }
  }

  /** The profile a move to the terminal lands on (lane D, PRDCT-4427): left
   *  to the spawn (undefined) when the family's selected profile is a
   *  terminal; its terminal form when the selection is a chat (a saved
   *  profile's `chat:<family>:<id>` is `<id>`; the built-in chat or a
   *  plugin's adapter is the family's built-in terminal), or the move would
   *  land in a chat again. */
  terminalProfileFor(family: LauncherFamily, workspaceId?: string): string | undefined {
    let selected: string
    try {
      selected = launchProfileManager.resolve(family, workspaceId).id
    } catch {
      return `builtin-${family}`
    }
    const events = eventsProfile(selected)
    if (!events) return undefined
    return events.sourceProfileId ?? `builtin-${family}`
  }

  /** Whether the family's CLI has this conversation on disk (lane D,
   *  PRDCT-4427): what decides a terminal resumes it or starts without it.
   *  Claude's transcript, Pi's session file (written at the first message),
   *  Codex's rollout; an OpenCode session is resumed by id from OpenCode's
   *  own storage, with no file of ours to check. */
  hasConversation(
    family: LauncherFamily,
    conversationId: string,
    cwd: string,
    configDir?: string,
    connectionId?: string
  ): boolean {
    if (family === 'claude') return findTranscript(conversationId, cwd, configDir) !== null
    // A Pi tab on a stored connection runs in the connection's directory, so
    // its session file is looked for there (PRDCT-4496).
    if (family === 'pi')
      return findPiSession(conversationId, cwd, piSessionLookupEnv(connectionId)) !== null
    if (family === 'codex') return hasCodexRollout(conversationId, codexRoot(getLoginShellEnv()))
    return family === 'opencode'
  }

  /** Whether the person still has a saved profile `id` for the family (lane
   *  D, PRDCT-4427, verifier round 2): a transport switch names a saved
   *  profile, or its chat form, only while it exists. A read of the store,
   *  never a resolve, which throws on a chat form that is gone. */
  profileExists(family: LauncherFamily, id: string): boolean {
    return launchProfileManager
      .getPreferences()
      .customProfiles.some((profile) => profile.id === id && profile.family === family)
  }

  /** The conversation a session would resume: Claude's session id, a Codex
   *  chat's thread, or the rollout a Codex terminal wrote (found by its cwd
   *  and start). Null when the session has nothing to resume. */
  conversationIdOf(id: string): string | null {
    const session = this.getSession(id)
    if (!session) return null
    if (session.claudeSessionId) return session.claudeSessionId
    // Lane D (PRDCT-4427): a Pi chat's or a Pi terminal's session, the same
    // id either way.
    if (session.piSessionId) return session.piSessionId
    const chatThread = this.codexThreads.get(id)
    if (chatThread) return chatThread
    // Lane D (PRDCT-4427): an OpenCode chat's session.
    const opencodeSession = this.opencodeSessions.get(id)
    if (opencodeSession) return opencodeSession
    const spawn = this.spawns.get(id)
    // Lane D (PRDCT-4427, verifier round 1 Major 1): an OpenCode terminal's
    // session, the one it was started on (`--session <id>`), else the one its
    // record kept; the chat's map entry went with the chat's kill.
    if (spawn?.options?.opencodeMode)
      return (
        spawn.options.resumeSessionId ?? ptyBackend.getSessionRecord(id)?.opencodeSessionId ?? null
      )
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
  ): { cwd: string; options: PtySpawnOptions; resumed: boolean; keepView: boolean } | null {
    const spawn = this.spawns.get(id)
    if (!spawn) return null
    // A restart closes the report: the resend, when one is owed, rides it.
    this.openReports.delete(id)
    // The window's report stays open across it until a turn is served.
    if (this.reported.has(id)) this.carriedReports.add(id)
    const conversationId = this.conversationIdOf(id)
    const previous = spawn.options ?? {}
    // `onlyIfStopped` is the lifecycle's precondition, never a spawn option;
    // the provider fields are the switch's (below), never spread as strings.
    const {
      resendRejected,
      onlyIfStopped: _onlyIfStopped,
      adapterId,
      model,
      resume,
      firstMessage,
      continuedFrom: continued,
      viewId,
      ...requested
    } = overrides
    void _onlyIfStopped
    const account = accountOverrides(requested)
    const record = ptyBackend.getSessionRecord(id)
    // A move to another provider (PRDCT-4300): the same tab, the other
    // adapter, the conversation converted there or carried as a message.
    const switching = adapterId !== undefined && adapterId !== record?.adapterId
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
      // The parent, else the record's: the kill takes the record before the
      // spawn could read it, and a spawn made without one (an older restore)
      // would lose the child its parent (#259, V1-F1).
      spawnedBy: previous.spawnedBy ?? ptyBackend.getSessionRecord(id)?.spawnedBy,
      openedBy: previous.openedBy ?? ptyBackend.getSessionRecord(id)?.openedBy,
      // Which work it does (PRDCT-4123): the record's, read now, for the same
      // reason. Never the spawn's own options: a restart carried one into
      // them, and a change of work since (a handover accepted, a lane left)
      // wrote the record alone, so a second restart would bring the old back.
      work: ptyBackend.getSessionRecord(id)?.work,
      // The mode, the model and the effort the chat was RUNNING on
      // (PRDCT-4191), from the record the provider's words were written to,
      // for the same reason: the spawn's options are the launch's.
      ...restartRuntime(ptyBackend.getSessionRecord(id), previous),
      // Where the conversation came from, kept across every later restart
      // (an account switch of a converted tab): the record's, read before
      // the kill takes it.
      ...(record?.continuedFrom ? { continuedFrom: record.continuedFrom } : {}),
      ...account
    }
    // The same harness on its other transport (lane D, PRDCT-4427): chat to
    // terminal or back, the conversation resumed the way its CLI resumes it.
    // The chat view the tab was read in does not follow it into a terminal.
    const from = record?.adapterId ?? sessionManager.get(id)?.adapterId
    const family = familyOfOptions(previous)
    if (switching && isTransportSwitch(from, adapterId, family)) {
      const moved = transportSwitchOptions(
        options,
        transportTarget(
          { adapterId, viewId, model },
          resume ?? conversationId ?? undefined,
          family,
          (conversation) =>
            !!family &&
            this.hasConversation(
              family,
              conversation,
              spawn.cwd,
              options.configDir,
              options.connectionId
            )
        ),
        { profileExists: (owner, profileId) => this.profileExists(owner, profileId) }
      )
      return {
        cwd: spawn.cwd,
        // The terminal the chat's saved profile names (transportSwitchOptions),
        // else the family's selected one in its terminal form.
        options:
          adapterId === 'pty' && family && moved.launchProfileId === undefined
            ? { ...moved, launchProfileId: this.terminalProfileFor(family, moved.workspaceId) }
            : moved,
        // What the plan resumes: a terminal started fresh or under the id
        // resumes nothing (verifier round 2, the Note).
        resumed: moved.resumeSessionId !== undefined,
        keepView: false
      }
    }
    if (switching) {
      return {
        cwd: spawn.cwd,
        options: providerSwitchOptions(options, {
          adapterId,
          model,
          resume,
          firstMessage,
          continuedFrom: continued
        }),
        resumed: resume !== undefined,
        keepView: true
      }
    }
    return { cwd: spawn.cwd, options, resumed: conversationId !== null, keepView: true }
  }

  /** `kill`, resolved once a tmux-backed process is really gone. */
  async killAndWait(id: string): Promise<void> {
    const tmuxName = ptyBackend.tmuxNameOf(id)
    await this.kill(id, true)
    if (tmuxName) await ptyBackend.waitForTmuxSessionGone(tmuxName)
  }
  /** Every session detached or stopped, the way the quit and the last
   *  window's close want it. The one-shot title jobs go with the sessions
   *  (PRDCT-3375): a `claude -p` still running would otherwise outlive the
   *  app's quit and the standalone server's stop, both of which end here.
   *  `quit: true` also shuts the title door (no job starts from then on);
   *  the last window's close on macOS is not a quit, and the tabs reopened
   *  from the Dock must still be named (round 2 of the lane's verifier). */
  async killAll({ quit = false }: { quit?: boolean } = {}): Promise<void> {
    if (quit) titleGenerator.shutdown()
    else titleGenerator.cancelAll()
    exchangeDigest.cancelAll(quit)
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
  /** Which work the session does, on its record (PRDCT-4123); false when it
   *  keeps no record. The host's `changeWork` is the only caller. */
  setSessionWork(id: string, work: WorkAssignment | null): boolean {
    return ptyBackend.setSessionWork(id, work)
  }
  /** Every record's work assignment, read without side effects (PRDCT-4123). */
  listWorkAssignments(): ReturnType<typeof ptyBackend.listWorkAssignments> {
    return ptyBackend.listWorkAssignments()
  }
  /** The persisted record of a live session, as it is now. */
  getSessionRecord = ptyBackend.getSessionRecord.bind(ptyBackend)
  /** The launch a session this process spawned runs on (PRDCT-4327): what a
   *  host's digests read when the session keeps no record of it. Null for a
   *  session it did not spawn. */
  spawnLaunchOf(id: string): {
    workspaceId?: string
    launchProfileId?: string
    claudeProfileId?: string
    configDir?: string
  } | null {
    const options = this.spawns.get(id)?.options
    if (!options) return null
    return {
      workspaceId: options.workspaceId,
      launchProfileId: options.launchProfileId,
      claudeProfileId: options.claudeProfileId,
      configDir: options.configDir
    }
  }
  setSessionViewRecord = ptyBackend.setSessionViewRecord.bind(ptyBackend)
  setSessionWorkspace = ptyBackend.setSessionWorkspace.bind(ptyBackend)
  setSessionClaudeSessionId = ptyBackend.setSessionClaudeSessionId.bind(ptyBackend)
  listAdoptableSessions = ptyBackend.listAdoptableSessions.bind(ptyBackend)
  discardSessionRecord = ptyBackend.discardSessionRecord.bind(ptyBackend)
}
export const ptyManager = new PtyManager()
