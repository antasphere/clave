import { lazySettingsPorts, type SettingsPorts } from '../ports/registry'
import { readJson, writeJson } from '../ports/storage'
import { helperById, listHelpers, setHelperConfigSource, type HelperConfig } from './registry'
// The built-in declarations, pure (no runner, no PTY): imported so the list
// below knows every helper whichever entry loads this file first.
import './title'
import './digests'
import './git'
import type {
  HelperAccount,
  HelperPreference as HelperPreferenceView,
  HelperPreferencePatch
} from '../../shared/helper-preferences'

/**
 * The helpers' preference on the machine that runs them (PRDCT-4330): per
 * helper, whether it runs, on which model and on which account. One JSON
 * document under the settings ports (`helper-preferences.json`, Electron's
 * data folder or the standalone server's), read at every call and never
 * cached: main and a separate server child share the folder, and either may
 * write it (the IPC route, the server route), so a cache in one would go
 * stale under the other.
 *
 * Only what the person changed is stored: a helper with no entry runs on its
 * own defaults, so a model a helper's declaration moves to reaches everyone
 * who never picked one.
 */

export const HELPER_PREFERENCES_FILE = 'helper-preferences.json'

export type {
  HelperAccount,
  HelperPreference as HelperPreferenceView,
  HelperPreferencePatch
} from '../../shared/helper-preferences'

/** One helper's stored entry: `claudeProfileId` absent is the tab's own,
 *  null the machine login, a string that account. */
interface StoredEntry {
  enabled?: boolean
  model?: string
  claudeProfileId?: string | null
}

interface StoredDocument {
  version: 1
  helpers: Record<string, StoredEntry>
}

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,127}$/

/** A stored entry read back as far as it is well formed: a hand-edited or
 *  half-written file costs the bad field, never the helper. */
function readEntry(raw: unknown): StoredEntry {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const r = raw as Record<string, unknown>
  const entry: StoredEntry = {}
  if (typeof r.enabled === 'boolean') entry.enabled = r.enabled
  if (typeof r.model === 'string' && MODEL.test(r.model)) entry.model = r.model
  if (r.claudeProfileId === null || typeof r.claudeProfileId === 'string')
    entry.claudeProfileId = r.claudeProfileId
  return entry
}

function accountOf(entry: StoredEntry): HelperAccount {
  if (!('claudeProfileId' in entry) || entry.claudeProfileId === undefined)
    return { kind: 'session' }
  if (entry.claudeProfileId === null) return { kind: 'machine' }
  return { kind: 'account', accountId: entry.claudeProfileId }
}

export class HelperPreferences {
  constructor(private readonly ports: SettingsPorts = lazySettingsPorts) {}

  private load(): StoredDocument {
    const raw = readJson(this.ports.storage, HELPER_PREFERENCES_FILE)
    const helpers: Record<string, StoredEntry> = {}
    const stored =
      raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as { helpers?: unknown }).helpers
        : undefined
    if (stored && typeof stored === 'object' && !Array.isArray(stored))
      for (const [id, entry] of Object.entries(stored as Record<string, unknown>))
        helpers[id] = readEntry(entry)
    return { version: 1, helpers }
  }

  /** What the runner asks before each call (`helperConfig`): the stored
   *  fields alone, the registry fills the rest from the helper's defaults. */
  configFor(id: string): Partial<HelperConfig> | undefined {
    const entry = this.load().helpers[id]
    if (!entry) return undefined
    const config: Partial<HelperConfig> = {}
    if (entry.enabled !== undefined) config.enabled = entry.enabled
    if (entry.model) config.model = entry.model
    if ('claudeProfileId' in entry) config.claudeProfileId = entry.claudeProfileId
    return config
  }

  /** Every declared helper, highest priority first, with its preference. */
  list(): HelperPreferenceView[] {
    const { helpers } = this.load()
    return listHelpers().map((definition) => {
      const entry = helpers[definition.id] ?? {}
      return {
        id: definition.id,
        label: definition.label,
        enabled: entry.enabled ?? true,
        model: entry.model || definition.model,
        defaultModel: definition.model,
        account: accountOf(entry)
      }
    })
  }

  /** Change one helper's preference and answer the whole list. A helper
   *  nobody declared, or a model that is not a model id, is refused with a
   *  plain `Error` (the settings handlers' refusal). */
  set(id: string, patch: HelperPreferencePatch): HelperPreferenceView[] {
    const definition = helperById(id)
    if (!definition) throw new Error(`There is no helper "${id}" on this machine.`)
    const document = this.load()
    const entry: StoredEntry = { ...(document.helpers[id] ?? {}) }
    if (patch.enabled !== undefined) {
      if (typeof patch.enabled !== 'boolean') throw new Error('The switch is on or off.')
      if (patch.enabled) delete entry.enabled
      else entry.enabled = false
    }
    if (patch.model !== undefined) {
      if (patch.model === null || patch.model === definition.model) delete entry.model
      else if (typeof patch.model === 'string' && MODEL.test(patch.model)) entry.model = patch.model
      else throw new Error('That is not a model name.')
    }
    if (patch.account !== undefined) {
      const account = patch.account
      if (account.kind === 'session') delete entry.claudeProfileId
      else if (account.kind === 'machine') entry.claudeProfileId = null
      else if (
        account.kind === 'account' &&
        typeof account.accountId === 'string' &&
        account.accountId
      )
        entry.claudeProfileId = account.accountId
      else throw new Error('That is not an account.')
    }
    if (Object.keys(entry).length === 0) delete document.helpers[id]
    else document.helpers[id] = entry
    writeJson(this.ports.storage, HELPER_PREFERENCES_FILE, document)
    return this.list()
  }
}

export const helperPreferences = new HelperPreferences()

/** The entry's one call: the runner reads this machine's preference at each
 *  call from now on. Main and the standalone server each make it at boot. */
export function installHelperPreferences(preferences: HelperPreferences = helperPreferences): void {
  setHelperConfigSource((id) => preferences.configFor(id))
}
