import { lazySettingsPorts, type SettingsPorts } from '../ports/registry'
import { readJson, writeJson } from '../ports/storage'
import { helperById, listHelpers, setHelperConfigSource, type HelperConfig } from './registry'
// Every declared helper (`catalog.ts`): a helper added there shows here.
import './catalog'
import { claudeAccountsManager } from '../claude-accounts'
import type {
  HelperAccount,
  HelperPreference as HelperPreferenceView,
  HelperPreferencePatch
} from '../../shared/helper-preferences'

/**
 * The helpers' preference of a machine (PRDCT-4330): per helper, whether it
 * runs, on which model and on which account. ONE preference per machine,
 * with one owner: the process that holds the machine's settings (the
 * separate server child in the packaged app, main when the server runs
 * in-process, the standalone server on a saved server). The owner keeps it
 * here, one JSON document under its own settings ports
 * (`helper-preferences.json`), read at every call.
 *
 * The owner is also the only process that runs helpers: with a server
 * behind the window (the separate child, or a daemon the app attaches to),
 * main runs none, and every helper of this Mac runs on that server, with its
 * preference and its accounts. Main installs this store only when it IS the
 * server (in-process, `settings/shell-source.ts`).
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

/** The order a person reads them in; a helper declared later follows, by label. */
const READING_ORDER = [
  'tab-title',
  'exchange-digest',
  'work-digest',
  'commit-message',
  'push-summary'
]
function byReadingOrder(
  a: { id: string; label: string },
  b: { id: string; label: string }
): number {
  const rank = (id: string): number => {
    const at = READING_ORDER.indexOf(id)
    return at === -1 ? READING_ORDER.length : at
  }
  return rank(a.id) - rank(b.id) || a.label.localeCompare(b.label)
}

export interface HelperPreferencesOptions {
  /** Whether a Claude account still exists on this machine: a helper whose
   *  account was removed runs on the tab's own instead of failing each call. */
  accountExists?: (id: string) => boolean
}

export class HelperPreferences {
  private readonly accountExists: (id: string) => boolean

  constructor(
    private readonly ports: SettingsPorts = lazySettingsPorts,
    options: HelperPreferencesOptions = {}
  ) {
    this.accountExists = options.accountExists ?? (() => true)
  }

  /** A stored account that is gone counts as none: the tab's own. */
  private live(entry: StoredEntry): StoredEntry {
    if (typeof entry.claudeProfileId !== 'string' || this.accountExists(entry.claudeProfileId))
      return entry
    const rest = { ...entry }
    delete rest.claudeProfileId
    return rest
  }

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
    const stored = this.load().helpers[id]
    if (!stored) return undefined
    const entry = this.live(stored)
    const config: Partial<HelperConfig> = {}
    if (entry.enabled !== undefined) config.enabled = entry.enabled
    if (entry.model) config.model = entry.model
    if ('claudeProfileId' in entry) config.claudeProfileId = entry.claudeProfileId
    return config
  }

  /** Every declared helper, in reading order, with its preference. */
  list(): HelperPreferenceView[] {
    const { helpers } = this.load()
    return listHelpers()
      .map((definition): HelperPreferenceView => {
        const stored = helpers[definition.id] ?? {}
        const entry = this.live(stored)
        return {
          id: definition.id,
          label: definition.label,
          enabled: entry.enabled ?? true,
          model: entry.model || definition.model,
          defaultModel: definition.model,
          account: accountOf(entry),
          ...(entry !== stored && { accountRemoved: true })
        }
      })
      .sort(byReadingOrder)
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

/** This process's store, on its own settings ports; a removed Claude
 *  account is looked up in this machine's accounts (loaded on first use). */
export const helperPreferences = new HelperPreferences(lazySettingsPorts, {
  accountExists: (id) => claudeAccountsManager.get(id)?.id === id
})

/** The entry's one call: the runner reads this machine's preference at each
 *  call from now on. The owner makes it at boot: the standalone server, and
 *  main only when the server runs inside it. */
export function installHelperPreferences(
  preferences: Pick<HelperPreferences, 'configFor'> = helperPreferences
): void {
  setHelperConfigSource((id) => preferences.configFor(id))
}
