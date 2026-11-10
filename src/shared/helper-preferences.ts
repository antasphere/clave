/**
 * The helpers' preference as every side reads it (PRDCT-4330): the host's
 * store (`src/main/helpers/preferences.ts`), the preload's members and the
 * Settings page. The wire's schemas are `@clave/contract/settings/helpers`,
 * written from these.
 */

/** Whose account a helper runs on: the tab's own (the default), the
 *  machine's login, or one Claude account of the machine. */
export type HelperAccount =
  | { kind: 'session' }
  | { kind: 'machine' }
  | { kind: 'account'; accountId: string }

/** A helper as Settings shows it: its defaults and the person's choice. */
export interface HelperPreference {
  id: string
  label: string
  enabled: boolean
  /** The model it runs on: the person's pick, or `defaultModel`. */
  model: string
  defaultModel: string
  account: HelperAccount
  /** The account it was given is gone from the machine: it runs on the tab's
   *  own (`account` says so) until another is picked. */
  accountRemoved?: boolean
}

/** What a write may change; a field left out stays as it is. `model: null`
 *  returns the helper to its default model. */
export interface HelperPreferencePatch {
  enabled?: boolean
  model?: string | null
  account?: HelperAccount
}

/** What a server released before the helpers' settings is said to need. The
 *  client says the same words (`packages/client/src/settings.ts`, which
 *  cannot import this file; its test holds the two equal). */
export const HELPERS_NEED_UPDATE = 'This server needs an update to show its helpers.'
