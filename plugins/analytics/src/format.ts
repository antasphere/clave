/**
 * The figures as the pages and the action previews write them. Shared by the plugin's
 * main and the page script, so a preview row and the page it opens never disagree.
 */

function grouped(n: number, decimals: number): string {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  })
}

/** `$12.34`; whole dollars from $1,000 up, thousands separated. */
export function formatUsd(usd: number): string {
  const value = Math.max(0, usd)
  return `$${value >= 1000 ? grouped(Math.round(value), 0) : grouped(value, 2)}`
}

/** `48 min`, `1 h 05`. */
export function formatMinutes(minutes: number): string {
  const total = Math.max(0, Math.round(minutes))
  if (total < 60) return `${total} min`
  const h = Math.floor(total / 60)
  const m = total % 60
  return `${grouped(h, 0)} h ${m < 10 ? `0${m}` : m}`
}

/** `840`, `312 k`, `98.6 M`, `1.51 B`. */
export function formatTokens(tokens: number): string {
  const n = Math.max(0, tokens)
  if (n < 1000) return String(Math.round(n))
  if (n < 999_500) return `${Math.round(n / 1000)} k`
  if (n < 999_950_000) return `${(n / 1e6).toFixed(1)} M`
  return `${(n / 1e9).toFixed(2)} B`
}

/** A table column in millions: `98.6 M`. */
export function formatMillions(tokens: number): string {
  return `${grouped(Math.max(0, tokens) / 1e6, 1)} M`
}

/** A table column in thousands: `312 k`. */
export function formatThousands(tokens: number): string {
  return `${grouped(Math.round(Math.max(0, tokens) / 1000), 0)} k`
}

export function formatCount(n: number): string {
  return grouped(Math.max(0, Math.round(n)), 0)
}
