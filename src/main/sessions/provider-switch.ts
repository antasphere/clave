/**
 * A tab changes provider (PRDCT-4300): the conversation moves from the agent
 * it ran on to another, Claude to Codex first. The pure rules live here, so
 * the tests pin them without a process: which road the move takes, and how
 * the restart's spawn is rebuilt for the other adapter. The roads themselves
 * (the conversion through `@clave/session-bridge`, the handoff file, the
 * adapters' model lists) run in `ipc-handlers/provider-switch-handlers.ts`,
 * on this Mac, where the transcripts and the account homes are.
 *
 * Two roads, decided before anything is written and said in the popover:
 *
 * - **convert**: the source transcript is read into the bridge's
 *   representation and laid down as a thread in the target's own storage,
 *   read back through the target's real CLI, and the tab restarts under the
 *   same id on the target adapter resuming that thread. Only where a writer
 *   exists and the installed CLI is the version the writer was proven on:
 *   Claude to Codex 0.167 today.
 * - **handoff**: the tab restarts fresh on the target adapter and its first
 *   message carries the conversation as Markdown, the files the agent
 *   touched and where the full tape was written. Every other direction, and
 *   the fallback when the conversion is refused or the read-back fails.
 *
 * A third road never reconstructs anything (PRDCT-4427): the **transport
 * switch**. The tab goes from its chat to its terminal and back on the same
 * harness, the same conversation resumed the way its CLI resumes it (Claude's
 * `--resume <id>`, Codex's `resume <id>`, the chat adapter's own resume);
 * only the transport changes. Nothing is converted, nothing handed off.
 */
import {
  readClaude,
  writeCodex,
  loadThread,
  SUPPORTED,
  versionSupported
} from '@clave/session-bridge'
import type { ContinuedFrom, ProviderOverride } from '@clave/contract/sessions'
import type { PtySpawnOptions } from './adapters/pty-backend'
import { chatProfileSource, type LauncherFamily } from '../../shared/agent-launch'
import { HARNESS_BY_ID } from '../../shared/harness'
import { CHAT_PROFILE_IDS } from '../../shared/open-session-modes'

/** The built-in chat adapters and the launch profile each is reached by; a
 *  plugin's adapter is its own profile id. */
const BUILT_IN_PROFILES: Record<string, string> = {
  'claude-chat': 'claude-chat',
  'codex-chat': 'codex-chat',
  // Lane D (PRDCT-4427): OpenCode's chat over the Agent Client Protocol.
  'opencode-chat': 'opencode-chat',
  // Lane D (PRDCT-4427): Pi's chat over its own rpc mode.
  'pi-chat': 'pi-chat',
  echo: 'dev-echo-adapter'
}
/** The launch profile a restart onto `adapterId` names. */
export function launchProfileFor(adapterId: string): string {
  return BUILT_IN_PROFILES[adapterId] ?? adapterId
}

/** How the person reads a provider: the agent's name. */
export const PROVIDER_LABELS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  // Lane D (PRDCT-4427).
  opencode: 'OpenCode',
  pi: 'Pi',
  echo: 'Echo'
}

export type SwitchRoad =
  | { road: 'convert'; codexVersion: string }
  | { road: 'handoff'; reason: string }

/** Which road a move takes, from what is known before anything is written:
 *  the adapters on each side, whether the source conversation's transcript
 *  was found, and the installed Codex (`codexVersion` null when it could not
 *  be read; `supported` the bridge's own word on it). Said in the popover
 *  before Continue, never discovered after. */
export function switchRoad(facts: {
  fromAdapterId: string
  toAdapterId: string
  transcriptFound: boolean
  codexVersion: string | null
  codexSupported: boolean
}): SwitchRoad {
  const { fromAdapterId, toAdapterId } = facts
  if (fromAdapterId === toAdapterId)
    return { road: 'handoff', reason: 'The tab is already on this provider.' }
  if (fromAdapterId !== 'claude-chat' || toAdapterId !== 'codex-chat')
    return {
      road: 'handoff',
      reason: `No converter exists from ${PROVIDER_LABELS[providerOf(fromAdapterId)] ?? fromAdapterId} to ${PROVIDER_LABELS[providerOf(toAdapterId)] ?? toAdapterId} yet; the conversation goes as a handoff message.`
    }
  if (!facts.transcriptFound)
    return {
      road: 'handoff',
      reason: 'This conversation has no transcript on disk yet; it goes as a handoff message.'
    }
  if (facts.codexVersion === null)
    return {
      road: 'handoff',
      reason:
        'Codex could not be run to read its version; the conversation goes as a handoff message.'
    }
  if (!facts.codexSupported)
    return {
      road: 'handoff',
      reason: `Codex ${facts.codexVersion} is not a version the converter was proven on; the conversation goes as a handoff message.`
    }
  return { road: 'convert', codexVersion: facts.codexVersion }
}

/** The provider an adapter id stands for, by the built-in names; a plugin's
 *  adapter is its own provider. */
export function providerOf(adapterId: string): string {
  if (adapterId === 'claude-chat') return 'claude'
  if (adapterId === 'codex-chat') return 'codex'
  // Lane D (PRDCT-4427): `pi-chat` is the next piece's, named here already.
  if (adapterId === 'opencode-chat') return 'opencode'
  if (adapterId === 'pi-chat') return 'pi'
  return adapterId
}

/** The restart's spawn options rebuilt for another adapter: the family flags
 *  and the launch profile of the target, the other provider's account and
 *  conversation forgotten, the target's model, the thread to resume when the
 *  conversion wrote one, else the handoff as the first message of a fresh
 *  conversation. The runtime choices a restart carries from the record (the
 *  mode, the effort) are the source provider's words and are dropped; the
 *  dangerous flag is the tab's and stays. */
export function providerSwitchOptions(
  previous: PtySpawnOptions,
  target: ProviderOverride
): PtySpawnOptions {
  // The family flags from the TARGET adapter (lane D, PRDCT-4427): a plugin's
  // adapter (and the echo fixture) joins the Claude family, as at launch.
  const codex = target.adapterId === 'codex-chat'
  const claude = target.adapterId === 'claude-chat'
  const opencode = target.adapterId === 'opencode-chat'
  const pi = target.adapterId === 'pi-chat'
  // A target with no account of either kind keeps neither's.
  const unpooled = opencode || pi
  return {
    ...previous,
    claudeMode: !codex && !opencode && !pi,
    codexMode: codex,
    claudeAgentsMode: false,
    antigravityMode: false,
    piMode: pi,
    opencodeMode: opencode,
    launchProfileId: launchProfileFor(target.adapterId),
    launchProfile: undefined,
    model: target.model,
    effort: undefined,
    permissionMode: undefined,
    allowDangerous: undefined,
    resumeSessionId: target.resume,
    claudeSessionId: undefined,
    // The handoff is the fresh conversation's first message, as a launch's
    // prompt is: every chat adapter sends its launch prompt at ready. A
    // resumed thread already holds the conversation; what it gets, once, is
    // the message a cap rejected when the limit policy made the move (the
    // restart's `initialInput`, integration round 2, G7). The handoff tape
    // already ends on that message, so it is never sent twice (lane E's
    // reading, kept by lane D).
    initialPrompt: firstTurn(previous.initialInput?.text, target),
    initialInput: undefined,
    // The account the move lands on comes with the override's own account
    // fields; the other provider's are not the target's.
    ...(codex || unpooled
      ? { claudeProfileId: undefined, claudeProfileLabel: undefined, configDir: undefined }
      : {}),
    ...(claude || unpooled ? { codexAccountId: undefined, codexAccountLabel: undefined } : {}),
    ...(target.continuedFrom ? { continuedFrom: target.continuedFrom } : {})
  }
}

/** The moved tab's first turn (integration round 2, G7): the message the
 *  cap rejected, once, on a resumed thread, after the converted history; the
 *  handoff itself on a fresh conversation, whose tape already ends on that
 *  message, so it is never sent twice; nothing when there is neither. */
export function firstTurn(
  rejected: string | undefined,
  target: Pick<ProviderOverride, 'resume' | 'firstMessage'>
): string | undefined {
  if (target.resume === undefined) return target.firstMessage
  return rejected?.trim() ? rejected : undefined
}

/** The note the restarted tab's first card reads. */
export function continuedFrom(fromAdapterId: string, road: SwitchRoad['road']): ContinuedFrom {
  return { provider: providerOf(fromAdapterId), road: road === 'convert' ? 'converted' : 'handoff' }
}

/** A Claude transcript written as a Codex thread in `codexHome` and read
 *  back through the real Codex (the bridge's own verify: a read, else one
 *  resume of a thread Codex never loaded, nothing but Codex's own settings
 *  row appended). The thread id when the thread came back with its turns;
 *  the reason otherwise, and nothing to resume. Every refusal the bridge
 *  raises (a Codex outside the pin, a transcript with no message, a file
 *  already there) is a reason here, never a throw: the popover falls back to
 *  the handoff road and says why. */
export async function convertTranscriptToCodex(input: {
  transcript: string
  codexHome: string
  cwd: string
  bin: string
  model?: string
}): Promise<{ ok: true; threadId: string; path: string } | { ok: false; reason: string }> {
  try {
    const written = await writeCodex(readClaude(input.transcript), {
      codexHome: input.codexHome,
      cwd: input.cwd,
      bin: input.bin,
      ...(input.model ? { model: input.model } : {})
    })
    const thread = await loadThread(written.threadId, {
      codexHome: input.codexHome,
      bin: input.bin
    })
    if (!thread.turns.length)
      return { ok: false, reason: 'Codex read the converted thread back with no turn in it.' }
    return { ok: true, threadId: written.threadId, path: written.path }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/** The road a move of a session to `adapterId` takes, as the popover says it
 *  before Continue (`ProviderSwitchPlan` on the preload): the facts the host
 *  gathered (the session's adapter, whether its transcript was found, the
 *  installed Codex's version or null when it could not be run) against the
 *  bridge's own pin. The handler gathers; this decides. */
export function planRoad(facts: {
  fromAdapterId: string
  toAdapterId: string
  transcriptFound: boolean
  codexVersion: string | null
}): {
  from: { adapterId: string; provider: string }
  to: { adapterId: string; provider: string }
} & SwitchRoad {
  const road = switchRoad({
    ...facts,
    codexSupported:
      facts.codexVersion !== null && versionSupported(facts.codexVersion, SUPPORTED.codex)
  })
  return {
    from: { adapterId: facts.fromAdapterId, provider: providerOf(facts.fromAdapterId) },
    to: { adapterId: facts.toAdapterId, provider: providerOf(facts.toAdapterId) },
    ...road
  }
}

// ── Lane D (PRDCT-4427): the transport switch, chat to terminal and back ──

/** The harness family a spawn runs; null for a plain terminal. */
export function familyOfOptions(previous: {
  claudeMode?: boolean
  codexMode?: boolean
  piMode?: boolean
  opencodeMode?: boolean
  antigravityMode?: boolean
  claudeAgentsMode?: boolean
}): LauncherFamily | null {
  if (previous.codexMode) return 'codex'
  if (previous.piMode) return 'pi'
  if (previous.opencodeMode) return 'opencode'
  if (previous.antigravityMode) return 'antigravity'
  if (previous.claudeAgentsMode) return 'claude'
  if (previous.claudeMode === false) return null
  return 'claude'
}

/** A move between the family's terminal (`pty`) and its own chat adapter,
 *  either way: the same harness, only the transport changes. Never between
 *  two chats (a provider switch), never for a plain terminal or a family
 *  with no chat adapter. */
export function isTransportSwitch(
  fromAdapterId: string | undefined,
  toAdapterId: string,
  family: LauncherFamily | null
): boolean {
  if (!family) return false
  const chat = HARNESS_BY_ID[family].chatAdapterId
  if (!chat) return false
  return (
    (fromAdapterId === 'pty' && toAdapterId === chat) ||
    (fromAdapterId === chat && toAdapterId === 'pty')
  )
}

/** The refusal of a terminal-to-chat move with no conversation to carry:
 *  resume or refuse, never a silent fresh chat (lane D, amendment 1). */
export const NO_CONVERSATION_TO_CARRY =
  'This terminal has no conversation to carry into a chat yet.'

/** Where a transport switch takes the conversation: into a chat only when
 *  there is one to resume (resume or refuse, never a silent fresh chat,
 *  amendment 1); into a terminal resumed when the harness's CLI has the
 *  conversation on disk (`hasConversation`, the family's own guard given by
 *  the caller: Claude's transcript, Pi's session file, Codex's rollout), so
 *  the rule stays pure. When it has none: Claude and Pi start their terminal
 *  under the same id (`--session-id`, amendment 2), a Codex terminal starts
 *  fresh (its CLI takes no id of ours, and a thread with no rollout cannot be
 *  resumed), and OpenCode always resumes (its TUI finds the session by id in
 *  its own storage; no file to check). */
export function transportTarget(
  target: { adapterId: string; viewId?: string; model?: string },
  conversationId: string | undefined,
  family: LauncherFamily | null,
  hasConversation: (conversationId: string) => boolean
): { adapterId: string; resume?: string; sessionId?: string; viewId?: string; model?: string } {
  if (target.adapterId !== 'pty') {
    if (!conversationId) throw new Error(NO_CONVERSATION_TO_CARRY)
    return { ...target, resume: conversationId }
  }
  if (!conversationId) return target
  if (family === 'opencode' || hasConversation(conversationId))
    return { ...target, resume: conversationId }
  if (family === 'claude' || family === 'pi') return { ...target, sessionId: conversationId }
  return target
}

/** The saved profile a launch profile id names for the family, the one whose
 *  chat form `chat:<family>:<id>` exists: never the family's built-in
 *  terminal, never a chat id already (lane D, PRDCT-4427, verifier round 1
 *  Minor 3). */
function savedProfileOf(id: string | undefined, family: LauncherFamily): string | undefined {
  if (!id || id === `builtin-${family}` || chatProfileSource(id)) return undefined
  if (Object.values(CHAT_PROFILE_IDS).includes(id)) return undefined
  return chatProfileSource(`chat:${family}:${id}`) ? id : undefined
}

/** The restart's spawn rebuilt for the other transport of the same harness.
 *  To the terminal: the saved profile the chat ran the chat form of
 *  (`chat:<family>:<id>` → `<id>`), else left to the caller (the family's
 *  selected terminal profile), the conversation resumed when it exists
 *  (`resume`), else started under its id (`sessionId`: Claude's and Pi's
 *  `--session-id`), the chat's mode kept only when the CLI's flag takes it.
 *  To the chat: the chat form of the saved profile the terminal ran, else the
 *  family's chat profile, the conversation resumed, the view the tab opens
 *  in. The account, the dangerous flag, the tab's lineage and work stay
 *  either way. A saved profile is named either way only while it still
 *  exists (`profileExists`, the caller's word from the profile store): a
 *  profile deleted since the tab started falls back to the family's own
 *  (verifier round 2, the Major). */
export function transportSwitchOptions(
  previous: PtySpawnOptions,
  target: {
    adapterId: string
    resume?: string
    sessionId?: string
    viewId?: string
    model?: string
  },
  deps: { profileExists: (family: LauncherFamily, id: string) => boolean }
): PtySpawnOptions {
  const family = familyOfOptions(previous)
  const harness = family ? HARNESS_BY_ID[family] : null
  if (!family || !harness?.chatAdapterId)
    throw new Error('A transport switch needs a harness with a chat adapter.')
  if (target.adapterId === 'pty') {
    const rung =
      previous.permissionMode !== undefined &&
      harness.permissionRungs.some((entry) => entry.id === previous.permissionMode)
    const source = chatProfileSource(previous.launchProfileId)
    const saved =
      source?.family === family && deps.profileExists(family, source.id) ? source.id : undefined
    const startUnder = target.resume ? undefined : target.sessionId
    return {
      ...previous,
      launchProfileId: saved,
      launchProfile: undefined,
      resumeSessionId: target.resume,
      claudeSessionId: family === 'claude' ? startUnder : undefined,
      piSessionId: family === 'pi' ? startUnder : undefined,
      viewId: undefined,
      initialPrompt: undefined,
      initialInput: undefined,
      effort: undefined,
      model: target.model ?? previous.model,
      permissionMode: rung ? previous.permissionMode : undefined
    }
  }
  if (target.adapterId === harness.chatAdapterId) {
    const candidate = savedProfileOf(previous.launchProfileId, family)
    const saved = candidate && deps.profileExists(family, candidate) ? candidate : undefined
    return {
      ...previous,
      launchProfileId: saved ? `chat:${family}:${saved}` : CHAT_PROFILE_IDS[family],
      launchProfile: undefined,
      resumeSessionId: target.resume,
      claudeSessionId: undefined,
      piSessionId: undefined,
      viewId: target.viewId,
      model: target.model ?? previous.model,
      initialPrompt: undefined,
      initialCommand: undefined,
      autoExecute: undefined,
      initialInput: undefined,
      effort: undefined,
      permissionMode: undefined
    }
  }
  throw new Error(`"${target.adapterId}" is not a transport of the ${family} harness.`)
}
