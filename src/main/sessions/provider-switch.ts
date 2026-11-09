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

/** The built-in chat adapters and the launch profile each is reached by; a
 *  plugin's adapter is its own profile id. */
const BUILT_IN_PROFILES: Record<string, string> = {
  'claude-chat': 'claude-chat',
  'codex-chat': 'codex-chat',
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
  const codex = target.adapterId === 'codex-chat'
  const claude = target.adapterId === 'claude-chat'
  return {
    ...previous,
    claudeMode: !codex,
    codexMode: codex,
    claudeAgentsMode: false,
    antigravityMode: false,
    piMode: false,
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
    // resumed thread already holds the conversation and gets none.
    initialPrompt: target.resume === undefined ? target.firstMessage : undefined,
    initialInput: undefined,
    // The account the move lands on comes with the override's own account
    // fields; the other provider's are not the target's.
    ...(codex
      ? { claudeProfileId: undefined, claudeProfileLabel: undefined, configDir: undefined }
      : {}),
    ...(claude ? { codexAccountId: undefined, codexAccountLabel: undefined } : {}),
    ...(target.continuedFrom ? { continuedFrom: target.continuedFrom } : {})
  }
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
