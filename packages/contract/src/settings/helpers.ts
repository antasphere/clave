/**
 * Settings domain: the helpers (PRDCT-4330). Every one-shot model call Clave
 * makes on its own (tab titles, exchange digests, work-card titles, commit
 * messages, push summaries, and any helper declared later) has, on the
 * machine that runs it, a switch, a model and an account. The list is the
 * host's registry: a helper declared there shows here with no change to the
 * contract or the page.
 *
 * Mirrors `src/main/helpers/preferences.ts`, the store on the host.
 */
import { Command, Query } from '@structure-ai/cqrs'
import { Schema } from 'effect'
import { SettingsRefused } from './failures'

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/** Whose account a helper runs on: the tab's own (the default), the
 *  machine's login, or one Claude account of that machine. */
export const HelperAccountView = Schema.Union(
  Schema.Struct({ kind: Schema.Literal('session') }),
  Schema.Struct({ kind: Schema.Literal('machine') }),
  Schema.Struct({ kind: Schema.Literal('account'), accountId: Schema.String })
)

export const HelperPreferenceView = Schema.Struct({
  /** The helper's id in the host's registry, the key its setting is filed under. */
  id: Schema.String,
  label: Schema.String,
  enabled: Schema.Boolean,
  /** The model it runs on: the person's pick, or `defaultModel`. */
  model: Schema.String,
  defaultModel: Schema.String,
  account: HelperAccountView,
  /** The account it was given is gone from the machine: it runs on the tab's own. */
  accountRemoved: Schema.optional(Schema.Boolean)
})

/** Every helper of the host, highest priority first. */
export const HelperPreferencesView = Schema.Struct({
  helpers: Schema.Array(HelperPreferenceView)
})

// ---------------------------------------------------------------------------
// Commands and queries — both answer with the whole list.
// ---------------------------------------------------------------------------

/** `helpers:list` */
export const ListHelperPreferences = Query.define('ListHelperPreferences', {
  payload: Schema.Struct({}),
  success: HelperPreferencesView
})

/** `helpers:set` — a field left out stays as it is; `model: null` returns the
 *  helper to its default. An unknown helper or a malformed model is refused. */
export const SetHelperPreference = Command.define('SetHelperPreference', {
  payload: Schema.Struct({
    helperId: Schema.String,
    enabled: Schema.optional(Schema.Boolean),
    model: Schema.optional(Schema.NullOr(Schema.String)),
    account: Schema.optional(HelperAccountView)
  }),
  success: HelperPreferencesView,
  failure: SettingsRefused
})
