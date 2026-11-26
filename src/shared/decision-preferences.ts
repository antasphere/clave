/**
 * The decisions' preference as every side reads it (PRDCT-5179): the host's
 * store (`src/main/decisions/preferences.ts`), the preload's members and the
 * Settings page. The wire's schemas are `@clave/contract/settings/decisions`,
 * written from these. The mirror of `helper-preferences.ts`: a decision is to
 * Jev what a helper is to a one-shot model call.
 */

/** A decision as Settings shows it: what it is, and whether it runs. */
export interface DecisionPreference {
  id: string
  label: string
  /** One sentence for the person: what it decides, and what it reads to. */
  description: string
  enabled: boolean
}

/** What a write may change; a field left out stays as it is. */
export interface DecisionPreferencePatch {
  enabled?: boolean
}

/** What a machine with no Jev key says under its decisions: nothing runs
 *  and nothing is sent until a key is pasted on the Integrations page. */
export const DECISIONS_NEED_KEY =
  'No Jev key on this machine: decisions run once one is added in Integrations.'

/** What a server released before the decisions is said to need. The client
 *  says the same words (`packages/client/src/settings.ts`, which cannot
 *  import this file; its test holds the two equal). */
export const DECISIONS_NEED_UPDATE = 'This server needs an update to show its decisions.'
