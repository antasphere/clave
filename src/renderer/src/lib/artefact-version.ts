/**
 * The version an artefact's panel shows (PRDCT-4494): `live` (the working
 * folder), `latest` (the newest version, moving as versions are saved) or a
 * version's number. Slideless's own preview page takes it as `?v=`, and its
 * own bar is hidden with `?bar=0`: Clave's bar carries the choice instead.
 */

/** The preview's own page without Slideless's bar, on the version chosen in Clave's bar. */
export function withVersion(url: string, shown: string): string {
  const page = new URL(url)
  page.searchParams.set('bar', '0')
  if (shown === 'live') page.searchParams.delete('v')
  else page.searchParams.set('v', shown)
  return page.toString()
}

/** What the bar's chip says for what the panel shows. */
export const versionLabel = (shown: string): string =>
  shown === 'live' ? 'Live' : shown === 'latest' ? 'Latest' : `v${shown}`
