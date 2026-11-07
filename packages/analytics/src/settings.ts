/**
 * The plugin's settings a person edits on its settings page: the activity gap today. They
 * live in `settings.json` in the data folder (the store reads and writes the file); the
 * price table has its own file beside it, `prices.json`, the override of the shipped table.
 */

export interface Settings {
  /** Consecutive messages less than this many minutes apart form one activity block. */
  gapMinutes: number
}

export const GAP_MIN = 1
export const GAP_MAX = 1440
export const DEFAULT_SETTINGS: Settings = { gapMinutes: 15 }

/** A gap as the page or the file gives it: a whole number of minutes within the bounds. */
export function parseGap(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof n === 'number' && Number.isInteger(n) && n >= GAP_MIN && n <= GAP_MAX ? n : null
}

/** The settings a file holds; anything off takes its default. */
export function parseSettings(raw: unknown): Settings {
  const obj =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  return { gapMinutes: parseGap(obj['gapMinutes']) ?? DEFAULT_SETTINGS.gapMinutes }
}
