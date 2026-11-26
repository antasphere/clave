import { lazySettingsPorts, type SettingsPorts } from '../ports/registry'
import { readJson, writeJson } from '../ports/storage'
import {
  decisionById,
  listDecisions,
  setDecisionConfigSource,
  type DecisionConfig
} from './registry'
// Every declared decision (`catalog.ts`): a decision added there shows here.
import './catalog'
import type { DecisionPreference, DecisionPreferencePatch } from '../../shared/decision-preferences'

/**
 * The decisions' preference of a machine (PRDCT-5179), the mirror of the
 * helpers' (`../helpers/preferences.ts`) without a model or an account: per
 * decision, whether it runs. ONE preference per machine, with one owner: the
 * process that holds the machine's settings (the separate server child in the
 * packaged app, main when the server runs in-process, the standalone server
 * on a saved server). The owner keeps it here, one JSON document under its
 * own settings ports (`decision-preferences.json`), read at every call.
 *
 * The owner is also the only process that runs decisions, the one that holds
 * the Jev key: with a server behind the window (the separate child, or a
 * daemon the app attaches to), main runs none, and every decision of this
 * Mac runs on that server, with its preference and its key. Main installs
 * this store only when it IS the server, and otherwise refuses every decision
 * (`refuseDecisionsHere`), as it does the helpers.
 *
 * Only what the person changed is stored: a decision with no entry is on.
 */

export const DECISION_PREFERENCES_FILE = 'decision-preferences.json'

/** The sentence a process that runs no decision answers with. */
export const DECISIONS_RUN_ON_SERVER = "Decisions run on Clave's server."

export type { DecisionPreference, DecisionPreferencePatch } from '../../shared/decision-preferences'

interface StoredEntry {
  enabled?: boolean
}

interface StoredDocument {
  version: 1
  decisions: Record<string, StoredEntry>
}

/** A stored entry read back as far as it is well formed: a hand-edited or
 *  half-written file costs the bad field, never the decision. */
function readEntry(raw: unknown): StoredEntry {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const r = raw as Record<string, unknown>
  return typeof r.enabled === 'boolean' ? { enabled: r.enabled } : {}
}

export class DecisionPreferences {
  constructor(private readonly ports: SettingsPorts = lazySettingsPorts) {}

  private load(): StoredDocument {
    const raw = readJson(this.ports.storage, DECISION_PREFERENCES_FILE)
    const decisions: Record<string, StoredEntry> = {}
    const stored =
      raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as { decisions?: unknown }).decisions
        : undefined
    if (stored && typeof stored === 'object' && !Array.isArray(stored))
      for (const [id, entry] of Object.entries(stored as Record<string, unknown>))
        decisions[id] = readEntry(entry)
    return { version: 1, decisions }
  }

  /** What the runner asks before each request (`decisionConfig`): the
   *  stored fields alone, the registry fills the rest. */
  configFor(id: string): Partial<DecisionConfig> | undefined {
    const stored = this.load().decisions[id]
    if (!stored || stored.enabled === undefined) return undefined
    return { enabled: stored.enabled }
  }

  /** Every declared decision, by label, with its switch. */
  list(): DecisionPreference[] {
    const { decisions } = this.load()
    return listDecisions().map(
      (definition): DecisionPreference => ({
        id: definition.id,
        label: definition.label,
        description: definition.description,
        enabled: decisions[definition.id]?.enabled ?? true
      })
    )
  }

  /** Change one decision's switch and answer the whole list. A decision
   *  nobody declared, or a switch that is not on or off, is refused with a
   *  plain `Error` (the settings handlers' refusal). */
  set(id: string, patch: DecisionPreferencePatch): DecisionPreference[] {
    if (!decisionById(id)) throw new Error(`There is no decision "${id}" on this machine.`)
    const document = this.load()
    const entry: StoredEntry = { ...(document.decisions[id] ?? {}) }
    if (patch.enabled !== undefined) {
      if (typeof patch.enabled !== 'boolean') throw new Error('The switch is on or off.')
      if (patch.enabled) delete entry.enabled
      else entry.enabled = false
    }
    if (Object.keys(entry).length === 0) delete document.decisions[id]
    else document.decisions[id] = entry
    writeJson(this.ports.storage, DECISION_PREFERENCES_FILE, document)
    return this.list()
  }
}

/** This process's store, on its own settings ports. */
export const decisionPreferences = new DecisionPreferences()

/** The owner's one call: the runner reads this machine's preference at each
 *  request from now on. The standalone server makes it at boot, and main
 *  only when the server runs inside it. */
export function installDecisionPreferences(
  preferences: Pick<DecisionPreferences, 'configFor'> = decisionPreferences
): void {
  setDecisionConfigSource((id) => preferences.configFor(id))
}

/** THE choke point of a process that is not the owner (main with a server
 *  of its own behind the window): every decision refused, whoever asks and
 *  by whatever road, so nothing is ever sent from here on defaults or with
 *  a key this process does not own. */
export function refuseDecisionsHere(sentence: string = DECISIONS_RUN_ON_SERVER): void {
  setDecisionConfigSource(() => ({ refused: sentence }))
}
