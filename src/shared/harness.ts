/**
 * The harness table: the coding-agent CLIs Clave launches, as the person
 * meets them (PRDCT-4423, PRDCT-4424, PRDCT-4425). Three words and nothing
 * behind them: a HARNESS is a tool on this Mac, a CONNECTION is who pays for
 * what it runs (the account pools of ADR 0002, `claude` and `codex` today), a
 * MODEL is never configured, only offered when a connection serves it and the
 * harness can run it.
 *
 * A harness id is a `LauncherFamily` (`agent-launch.ts`): the launch profiles,
 * the spawn and the `.clave` modes keep that name. This table adds what the
 * launcher and the settings need to know about each: which connection pools it
 * runs on, whether it has a chat adapter, its own permission ladder and the
 * flag that sets it, and how it is installed.
 */
import type { LauncherFamily } from './agent-launch'
import type { ConnectionPoolId } from './connection'
// ── Lane B (harness wave): provider connections ──
import type { ProviderWireFormat } from '@clave/contract/settings/provider-catalogue'
// Lane C of the harness wave (PRDCT-4496): the pools a stored key serves
import { PROVIDER_COMPANY_IDS } from '@clave/contract/settings/provider-catalogue'

export type HarnessId = LauncherFamily

/** One rung of a harness's own permission ladder, by the CLI's own name. */
export interface PermissionRung {
  /** The value the CLI's flag takes (`acceptEdits`, `workspace-write`, …). */
  id: string
  label: string
  /** What the harness does on this rung, in one sentence. */
  hint: string
}

export interface Harness {
  id: HarnessId
  /** The name a person reads: Claude Code, Codex, Antigravity, Pi, OpenCode. */
  name: string
  /** The binary on the PATH (`claude`, `codex`, `agy`, `pi`, `opencode`). */
  command: string
  /** The pools this harness's connections come from (`connection.ts`, ADR
   *  0002), in the order the launcher lists them; empty for a harness Clave
   *  holds no connection for yet (Antigravity, Pi, OpenCode: their accounts
   *  live inside the CLI). A provider pool of PRDCT-4426 is added to the rows
   *  of the harnesses that speak its wire format. */
  connectionPools: readonly ConnectionPoolId[]
  /** A vendor-only harness runs its vendor's models alone: the launcher shows
   *  the models its connected accounts serve and nothing else. An open one
   *  (Pi) runs any provider its own config names. */
  vendorOnly: boolean
  /** The chat adapter that drives this harness in Clave's chat views, or null
   *  for a harness that runs in a terminal only. */
  chatAdapterId: 'claude-chat' | 'codex-chat' | null
  /** Whether the CLI takes a model on its command line (`--model`, `-m`). */
  takesModel: boolean
  /** The harness's own permission ladder, empty for a harness that never asks
   *  (Pi runs every tool with the process's own rights). */
  permissionRungs: readonly PermissionRung[]
  /** The rung the CLI starts on when nothing is passed, by its id; null when
   *  the CLI decides per folder (Codex) or has no ladder. Shown as the
   *  setting's "Default" and never passed as a flag. */
  defaultRung: string | null
  /** The rung Cmd+Y and `dangerous: true` force: the skip-approvals flag the
   *  spawn already knows (`DANGEROUS_MODE_FAMILIES`). Null when the CLI has
   *  none. */
  bypassRung: string | null
  /** How Clave installs the CLI when it is missing, or null when the person
   *  installs it themselves. A shell line, run by `onboarding.ts`'s installer. */
  install: string | null
  /** Where the person reads about the harness. */
  docsUrl: string
  // ── Lane B (harness wave): provider connections ──
  /** The wire formats this harness speaks (PRDCT-4426): a stored provider
   *  connection serves it when one of its endpoints speaks one of them. Empty
   *  for a vendor-only harness. */
  wireFormats: readonly ProviderWireFormat[]
}

export const HARNESSES: readonly Harness[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    command: 'claude',
    connectionPools: ['claude'],
    vendorOnly: true,
    chatAdapterId: 'claude-chat',
    takesModel: true,
    permissionRungs: [
      {
        id: 'default',
        label: 'Ask',
        hint: 'Reads on its own, asks before every edit and command.'
      },
      {
        id: 'acceptEdits',
        label: 'Accept edits',
        hint: 'Edits files on its own, asks before commands.'
      },
      {
        id: 'plan',
        label: 'Plan',
        hint: 'Reads and plans, changes nothing until you approve the plan.'
      },
      {
        id: 'auto',
        label: 'Auto',
        hint: 'Does everything, with background safety checks on what it runs.'
      },
      {
        id: 'bypassPermissions',
        label: 'Skip permissions',
        hint: 'Never asks. Only for a folder you can afford to lose.'
      }
    ],
    defaultRung: null,
    bypassRung: 'bypassPermissions',
    install: 'curl -fsSL https://claude.ai/install.sh | bash',
    docsUrl: 'https://code.claude.com/docs',
    // ── Lane B (harness wave): provider connections ──
    wireFormats: []
  },
  {
    id: 'codex',
    name: 'Codex',
    command: 'codex',
    connectionPools: ['codex'],
    vendorOnly: true,
    chatAdapterId: 'codex-chat',
    takesModel: true,
    permissionRungs: [
      {
        id: 'read-only',
        label: 'Read only',
        hint: 'Reads the folder, asks before any change or command.'
      },
      {
        id: 'workspace-write',
        label: 'Workspace',
        hint: 'Edits inside the folder, asks before anything outside it.'
      },
      {
        id: 'danger-full-access',
        label: 'Full access',
        hint: 'Never asks, no sandbox. Only for a folder you can afford to lose.'
      }
    ],
    defaultRung: null,
    bypassRung: 'danger-full-access',
    install: null,
    docsUrl: 'https://learn.chatgpt.com/docs/cli',
    // ── Lane B (harness wave): provider connections ──
    wireFormats: []
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    command: 'agy',
    connectionPools: [],
    vendorOnly: true,
    chatAdapterId: null,
    takesModel: false,
    permissionRungs: [
      {
        id: 'default',
        label: 'Ask',
        hint: 'Shows every edit for review, asks before every command.'
      },
      {
        id: 'accept-edits',
        label: 'Accept edits',
        hint: 'Edits files on its own, asks before commands.'
      },
      {
        id: 'plan',
        label: 'Plan',
        hint: 'Plans first, changes nothing until you approve the plan.'
      },
      { id: 'auto', label: 'Auto', hint: 'Does everything inside its sandbox.' }
    ],
    defaultRung: 'default',
    bypassRung: null,
    install: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    docsUrl: 'https://antigravity.google/docs/cli',
    // ── Lane B (harness wave): provider connections ──
    wireFormats: []
  },
  {
    id: 'pi',
    name: 'Pi',
    command: 'pi',
    // The pools a stored key serves: one per company of the catalogue (PRDCT-4496).
    connectionPools: [...PROVIDER_COMPANY_IDS],
    vendorOnly: false,
    chatAdapterId: null,
    takesModel: true,
    permissionRungs: [],
    defaultRung: null,
    bypassRung: null,
    install: 'npm install -g @earendil-works/pi-coding-agent',
    docsUrl: 'https://pi.dev/docs',
    // ── Lane B (harness wave): provider connections ──
    wireFormats: ['anthropic-messages', 'openai-chat', 'openai-responses']
  },
  {
    // OpenCode 2's TUI has no model flag (`opencode run` has, the TUI not):
    // the model it starts on reaches it through `OPENCODE_CONFIG_CONTENT`,
    // set per tab, with `--standalone` so the TUI reads the tab's own
    // environment rather than the shared service's (PRDCT-4496). Its
    // permissions are config rules, not a CLI ladder; its one flag, `--auto`,
    // is what `dangerousMode` passes.
    id: 'opencode',
    name: 'OpenCode',
    command: 'opencode',
    // The pools a stored key serves: one per company of the catalogue (PRDCT-4496).
    connectionPools: [...PROVIDER_COMPANY_IDS],
    vendorOnly: false,
    chatAdapterId: null,
    takesModel: true,
    permissionRungs: [],
    defaultRung: null,
    bypassRung: null,
    install: 'curl -fsSL https://opencode.ai/v2/install | bash',
    docsUrl: 'https://opencode.ai/docs',
    // ── Lane B (harness wave): provider connections ──
    wireFormats: ['anthropic-messages', 'openai-chat', 'openai-responses']
  }
]

export const HARNESS_BY_ID: Readonly<Record<HarnessId, Harness>> = Object.fromEntries(
  HARNESSES.map((harness) => [harness.id, harness])
) as Record<HarnessId, Harness>

/** A person's settings for one harness (Settings → Harnesses). Both absent
 *  means the harness's own defaults: no flag is passed. */
export interface HarnessSettings {
  /** The model a click in the launcher runs; absent = the CLI's own default. */
  preferredModel?: string
  /** The rung a launch starts on (`permissionRungs[].id`); absent = the CLI's
   *  own. Cmd+Y still forces `bypassRung` for one launch. */
  permissionDefault?: string
}

export type HarnessSettingsById = Partial<Record<HarnessId, HarnessSettings>>

/**
 * The interaction mode (PRDCT-4425): how a new conversation opens. The three
 * chat values are the chat-view plugin's views; `terminal` is the real PTY on
 * the harness's interactive CLI. One setting, written by Settings → General
 * and by the onboarding's chat-style step; a tab can still switch among the
 * chat views from its header.
 */
export type InteractionMode = 'chat' | 'enclave' | 'folio' | 'terminal'

export const INTERACTION_MODES: readonly {
  id: InteractionMode
  title: string
  tagline: string
  /** The chat-view plugin's view id, or null for the terminal. */
  viewId: string | null
}[] = [
  {
    id: 'chat',
    title: 'Chat',
    tagline:
      'A conversation, like a messaging app: your messages on one side, the answers flowing in.',
    viewId: 'clave.chat-view/chat'
  },
  {
    id: 'enclave',
    title: 'Enclave',
    tagline: 'Dense and calm, every step the assistant takes laid out in one column.',
    viewId: 'clave.chat-view/terminal'
  },
  {
    id: 'folio',
    title: 'Folio',
    tagline:
      'Each question gets a page of its own, written like a document. It can read the answer aloud.',
    viewId: 'clave.chat-view/lab'
  },
  {
    id: 'terminal',
    title: 'Terminal',
    tagline: "The agent's own screen, as it runs in a terminal window.",
    viewId: null
  }
]

export const DEFAULT_INTERACTION_MODE: InteractionMode = 'chat'

const MODE_IDS = new Set<InteractionMode>(INTERACTION_MODES.map((mode) => mode.id))

export function isInteractionMode(value: unknown): value is InteractionMode {
  return typeof value === 'string' && MODE_IDS.has(value as InteractionMode)
}

/** The chat-view id a mode opens in, or null for the terminal. */
export function viewOfInteractionMode(mode: InteractionMode): string | null {
  return INTERACTION_MODES.find((entry) => entry.id === mode)?.viewId ?? null
}

/** The mode a chat-view id stands for; undefined for a view of another plugin. */
export function interactionModeOfView(
  viewId: string | null | undefined
): InteractionMode | undefined {
  if (!viewId) return undefined
  return INTERACTION_MODES.find((entry) => entry.viewId === viewId)?.id
}

/** The launch settings the renderer reads and writes as one record, over the
 *  `launch-settings:*` IPC (`src/main/launch-settings.ts`). */
export interface LaunchSettings {
  interactionMode: InteractionMode
  harnesses: HarnessSettingsById
}

/** A partial write of the launch settings: a harness field set to null is
 *  cleared (back to the CLI's own), a field absent is left as it was. */
export interface LaunchSettingsPatch {
  interactionMode?: InteractionMode
  harnesses?: Partial<Record<HarnessId, Partial<Record<keyof HarnessSettings, string | null>>>>
}

const HARNESS_IDS = new Set<HarnessId>(HARNESSES.map((harness) => harness.id))
/** A model id as a CLI takes it, the `[1m]` context suffix included. */
const SHORT = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,199}$/

/** A harness settings table off the wire or the file: unknown harnesses and
 *  malformed values dropped, never thrown. */
export function sanitizeHarnessSettings(raw: unknown): HarnessSettingsById {
  if (!raw || typeof raw !== 'object') return {}
  const out: HarnessSettingsById = {}
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!HARNESS_IDS.has(id as HarnessId) || !value || typeof value !== 'object') continue
    const entry = value as Record<string, unknown>
    const harness = HARNESS_BY_ID[id as HarnessId]
    const settings: HarnessSettings = {}
    if (typeof entry.preferredModel === 'string' && SHORT.test(entry.preferredModel))
      settings.preferredModel = entry.preferredModel
    if (
      typeof entry.permissionDefault === 'string' &&
      harness.permissionRungs.some((rung) => rung.id === entry.permissionDefault)
    )
      settings.permissionDefault = entry.permissionDefault
    if (Object.keys(settings).length > 0) out[id as HarnessId] = settings
  }
  return out
}
