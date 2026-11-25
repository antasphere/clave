import type { SettingsPorts } from '../ports/registry'
import { readJson, writeJson } from '../ports/storage'

/**
 * The one way `integrations.json` is read and written (PRDCT-5179). Two
 * stores keep an entry in it, ElevenLabs under `elevenLabs` and Jev under
 * `jev`, and each reads only its own. A store that wrote back the document it
 * had read would erase the other's entry, and one that wrote while the other
 * was between its read and its write would lose that write: so a write
 * re-reads the raw file, replaces its own key and nothing else, and every
 * write of this process waits for the one before it.
 */

export const INTEGRATIONS_FILE = 'integrations.json'

/** The raw document as it is on disk: an object, or an empty one when the
 *  file is missing, half-written or not an object. */
function readRecord(ports: SettingsPorts): Record<string, unknown> {
  const raw = readJson(ports.storage, INTEGRATIONS_FILE)
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? { ...(raw as Record<string, unknown>) }
    : {}
}

/** The raw value under `key`, or undefined: each store reads its own entry
 *  as far as it is well formed. */
export function readIntegrationEntry(ports: SettingsPorts, key: string): unknown {
  const record = readRecord(ports)
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined
}

/** Write one store's entry (deleted when `entry` is undefined): the file is
 *  read again first, every other key kept exactly as read, `version: 1`. */
export function writeIntegrationEntry(
  ports: SettingsPorts,
  key: string,
  entry: unknown | undefined
): void {
  const record = readRecord(ports)
  if (entry === undefined) delete record[key]
  else record[key] = entry
  // `version` first, as the file has always been written, and always 1.
  delete record.version
  writeJson(ports.storage, INTEGRATIONS_FILE, { version: 1, ...record })
}

/** Every write of every store of this process, one after the other. */
let writes: Promise<unknown> = Promise.resolve()

/** Run a write after every write before it, whatever became of them: a
 *  store's read and write never interleave with another's. Never call it
 *  from inside a write it runs: the inner one would wait for the outer. */
export function serialIntegrations<T>(write: () => T | Promise<T>): Promise<T> {
  const run = writes.then(write, write)
  writes = run.catch(() => undefined)
  return run
}
