/**
 * The Jev integration as every side reads it (PRDCT-5179): the host's store
 * (`src/main/integrations/jev.ts`), the preload's members and the Settings
 * page. The wire's schemas are `@clave/contract/settings/integrations`,
 * written from these. Pure: no process, no network, so the renderer imports
 * it.
 *
 * Jev is TypeSafe's decision model: a typed question answered by a
 * probability and no prose. A machine holds one key for it, sealed beside its
 * ElevenLabs key, and the decisions Clave asks with it are declared in
 * `src/main/decisions/`.
 *
 * The key itself appears in none of these shapes: a machine says whether it
 * holds one, never what it is.
 */

/** The version the floors of the decisions were measured on (25 November
 *  2026). TypeSafe advises naming the version, never the alias, once
 *  thresholds are tuned against it. */
export const JEV_MODEL = 'jev-1.14.0'

/** Asked only when the service says `JEV_MODEL` no longer exists, so a
 *  retired version does not end every decision until the next release. */
export const JEV_FALLBACK_MODEL = 'jev-latest'

/** What a machine says of its Jev key: whether it holds one, when it was
 *  set, and what the last check against TypeSafe said. */
export interface JevStatus {
  configured: boolean
  setAt: number | null
  checkedAt: number | null
  /** The last check's failure, in words for the person; null when it passed. */
  lastError: string | null
}

/** How a refusal that carries TypeSafe's own reason starts: the host writes
 *  it, the Settings page knows a sentence that starts so is meant for the
 *  person (the rule of `ELEVENLABS_REFUSED_PREFIX`). */
export const JEV_REFUSED_PREFIX = 'TypeSafe refused the key: '

/** What the Integrations card says before a key is pasted: what a key makes
 *  Clave send, and to whom. A decision reads only what its own row in
 *  Settings, Helpers says; this sentence covers them all, the workspace's
 *  projects included (every request carries them). */
export const JEV_WHAT_LEAVES =
  'With a key, Clave asks Jev, TypeSafe’s decision model, the small decisions listed in Helpers. Each one sends TypeSafe parts of a tab, its first and latest messages and the folders its tools touched, with the name, the folder and the prompt of each project of the workspace.'
