import type { HelperFailureReason } from '../../shared/helper-prompt'

/**
 * The helpers' registry (README.md beside this file): every one-shot model
 * call Clave makes is a helper declared here once, with its prompt, its
 * parser and its defaults, and run by the one runner (`runner.ts`). Pure and
 * free of Electron: the standalone server loads it with the title generator
 * and the exchange digest.
 */

/** The session a helper runs for, so the call runs the agent that session
 *  runs, on its account. All optional: none of it is the workspace's default
 *  Claude on the machine login. */
export interface HelperLaunchContext {
  workspaceId?: string
  launchProfileId?: string
  claudeProfileId?: string
  configDir?: string
}

export interface HelperDefinition<Input, Output> {
  /** Stable, kebab-case: the key a setting is filed under. */
  id: string
  /** What a person reads in Settings. */
  label: string
  /** The helper's own system prompt (`--system-prompt` replaces the CLI's). */
  systemPrompt: string
  /** The prompt on stdin. It must open with the helper's history marker when
   *  it has one (`session-history/index.ts`), so the one-shot's transcript is
   *  never listed as a conversation. */
  buildPrompt(input: Input): string
  /** The reply read back; null when it is not the asked shape. */
  parseReply(stdout: string, input: Input): Output | null
  model: string
  fallbackModel?: string
  timeoutMs: number
  /** Higher runs first; equal priorities run in the order asked. */
  priority: number
  /** How many of this helper may run at once. */
  concurrency?: number
  /** Helpers that share a cap: every helper naming the same pool id runs at
   *  most `concurrency` at once, together (the two digests share two). */
  pool?: { id: string; concurrency: number }
  /** Work nobody is waiting on (the digests): it counts against the runner's
   *  background cap (`MAX_RUNNING_HELPERS`). A helper that is not background
   *  (a title, a git call, a prompt a person waits on) never waits behind
   *  background work; only its own `concurrency` and `pool` hold it. */
  background?: boolean
  /** Tries before an unreadable reply or a failed run is reported: 2 is one retry. */
  attempts?: number
  /** Retry after ANY failure, a timeout, a limit or a refusal included (the
   *  git calls, as before the helpers). Without it only an unreadable reply
   *  or an unexplained failure is retried. A cancel is never retried. */
  retryAnyFailure?: boolean
}

/** What the runner asks before each call. `claudeProfileId` undefined means
 *  the caller's account (the session's); null means the machine login. */
export interface HelperConfig {
  enabled: boolean
  model: string
  fallbackModel?: string
  claudeProfileId?: string | null
  /** PRDCT-4330: this process runs no helper (a server of its own backs the
   *  window and runs them all); the sentence the refusal carries. */
  refused?: string
}

/** Where overrides come from (the Settings page, PRDCT-4330): a partial
 *  answer per helper, merged over the helper's defaults. */
export type HelperConfigSource = (id: string) => Partial<HelperConfig> | undefined

export type HelperOutcome<Output> =
  | { ok: true; value: Output; attempts: number; model: string }
  | { ok: false; reason: HelperFailureReason; detail: string }

// A definition is stored with its types erased; `defineHelper` hands the
// caller back the typed one, so the runner's signature keeps them.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHelper = HelperDefinition<any, any>
const helpers = new Map<string, AnyHelper>()
let configSource: HelperConfigSource = () => undefined

/** Declare a helper. Once per id: a second declaration of the same id is a
 *  bug (two prompts behind one setting), so it throws. */
export function defineHelper<Input, Output>(
  definition: HelperDefinition<Input, Output>
): HelperDefinition<Input, Output> {
  const known = helpers.get(definition.id)
  if (known && known !== definition) throw new Error(`Helper "${definition.id}" is declared twice`)
  helpers.set(definition.id, definition)
  return definition
}

/** Every helper declared so far, highest priority first. */
export function listHelpers(): AnyHelper[] {
  return [...helpers.values()].sort((a, b) => b.priority - a.priority)
}

export function helperById(id: string): AnyHelper | undefined {
  return helpers.get(id)
}

/** THE seam: is this helper on, on which model, on which account. Today the
 *  helper's own defaults; an installed source (`setHelperConfigSource`)
 *  overrides any field it answers. */
export function helperConfig(definition: AnyHelper): HelperConfig {
  const override = configSource(definition.id) ?? {}
  return {
    enabled: override.enabled ?? true,
    model: override.model || definition.model,
    fallbackModel: 'fallbackModel' in override ? override.fallbackModel : definition.fallbackModel,
    claudeProfileId: override.claudeProfileId,
    // PRDCT-4330: passed through, so the runner refuses before any spawn.
    ...(override.refused && { refused: override.refused })
  }
}

/** Install where the overrides come from; no argument puts the defaults back. */
export function setHelperConfigSource(source?: HelperConfigSource): void {
  configSource = source ?? (() => undefined)
}

/** Forget every declaration (test seam). */
export function resetHelpersForTests(): void {
  helpers.clear()
  configSource = () => undefined
}
