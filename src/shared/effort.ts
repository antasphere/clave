/**
 * Reasoning effort: how hard a model thinks before it answers, in the
 * provider's own word ("low" … "max" for Claude, up to "ultra" for Codex).
 * Each provider says which levels each of its models takes, so nothing here
 * lists them: this file only names them and checks their shape.
 */

/** A level as a provider spells it: a short lowercase word. Anything else
 *  (a flag, shell syntax, a path) never reaches a command line or a request. */
export function isValidEffort(effort: string): boolean {
  return /^[a-z][a-z0-9_-]{0,31}$/.test(effort)
}

const LABELS: Record<string, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra'
}

/** How a level reads in the composer: "xhigh" → "Extra high"; a level this
 *  list does not know yet reads as its own word, capitalised. */
export function effortLabel(effort: string): string {
  return LABELS[effort] ?? effort.charAt(0).toUpperCase() + effort.slice(1).replace(/[_-]/g, ' ')
}
