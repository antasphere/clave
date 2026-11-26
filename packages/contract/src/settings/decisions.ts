/**
 * Settings domain: the decisions (PRDCT-5179). Every question Clave asks Jev,
 * TypeSafe's decision model, on its own has, on the machine that runs it, a
 * switch. The list is the host's registry: a decision declared there shows
 * here with no change to the contract or the page. A decision has no model
 * and no account to pick: the Jev key of the machine runs them all.
 *
 * Mirrors `src/main/decisions/preferences.ts`, the store on the host, and the
 * plain shapes of `src/shared/decision-preferences.ts`.
 */
import { Command, Query } from '@structure-ai/cqrs'
import { Schema } from 'effect'
import { SettingsRefused } from './failures'

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export const DecisionPreferenceView = Schema.Struct({
  /** The decision's id in the host's registry, the key its switch is filed under. */
  id: Schema.String,
  label: Schema.String,
  /** One sentence for the person: what it decides, and what it reads to. */
  description: Schema.String,
  enabled: Schema.Boolean
})

/** Every decision of the host, by label. */
export const DecisionPreferencesView = Schema.Struct({
  decisions: Schema.Array(DecisionPreferenceView)
})

// ---------------------------------------------------------------------------
// Commands and queries — both answer with the whole list.
// ---------------------------------------------------------------------------

/** `decisions:list` */
export const ListDecisions = Query.define('ListDecisions', {
  payload: Schema.Struct({}),
  success: DecisionPreferencesView
})

/** `decisions:set` — a field left out stays as it is. An unknown decision is
 *  refused. */
export const SetDecisionPreference = Command.define('SetDecisionPreference', {
  payload: Schema.Struct({
    id: Schema.String,
    enabled: Schema.optional(Schema.Boolean)
  }),
  success: DecisionPreferencesView,
  failure: SettingsRefused
})
