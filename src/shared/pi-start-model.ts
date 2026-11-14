/**
 * The model a Pi tab on a stored connection starts on when the open names
 * none (PRDCT-4496). Pi 1.5.2 refuses `--provider` without `--model`
 * ("--provider requires --model") and exits before it speaks, so a tab on a
 * connection always names a model. The rule, ONE for every road and both
 * forms (the spawn's `providerInjectionForSpawn`, and `clave_launch_options`
 * saying it beforehand): the person's own Pi default model when it belongs
 * to the connection's provider (`Default` then means what it means without a
 * connection), else the first model the launcher lists for that connection;
 * a connection with neither refuses in one sentence rather than starting on
 * something else.
 *
 * Pure: the person's default and the listed models are read by the caller.
 */

/** What the person's Pi keeps as its default (`settings.json`:
 *  `defaultProvider`, `defaultModel`); null when it keeps none. */
export interface PiOwnDefault {
  readonly provider?: string
  readonly model?: string
}

export type PiStartModel =
  | { readonly ok: true; readonly model: string; readonly from: 'own-default' | 'first-listed' }
  | { readonly ok: false; readonly reason: string }

export function piStartModel(input: {
  /** Pi's provider id for the connection (`kimi-coding`, `clave-ollama`). */
  readonly provider: string
  readonly ownDefault: PiOwnDefault | null
  /** The models the launcher lists for the connection, in its order. */
  readonly listed: readonly string[]
  /** The connection's label, for the refusal. */
  readonly label: string
}): PiStartModel {
  const own = input.ownDefault
  if (own?.provider === input.provider && own.model)
    return { ok: true, model: own.model, from: 'own-default' }
  const first = input.listed.find((id) => id.length > 0)
  if (first) return { ok: true, model: first, from: 'first-listed' }
  return {
    ok: false,
    reason: `No model is listed for the connection "${input.label}": name one to open Pi on it.`
  }
}

/** The person's Pi default read off the text of its `settings.json`; null
 *  when the text is not an object or names no default model. */
export function parsePiOwnDefault(text: string): PiOwnDefault | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const doc = parsed as Record<string, unknown>
  const provider =
    typeof doc.defaultProvider === 'string' && doc.defaultProvider.trim()
      ? doc.defaultProvider.trim()
      : undefined
  const model =
    typeof doc.defaultModel === 'string' && doc.defaultModel.trim()
      ? doc.defaultModel.trim()
      : undefined
  if (!model) return null
  return { ...(provider ? { provider } : {}), model }
}
