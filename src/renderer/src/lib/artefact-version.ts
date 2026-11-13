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

/** The same page for a browser, where Clave's bar is not: Slideless's own bar shown. */
export function inBrowser(url: string, shown: string): string {
  const page = new URL(url)
  page.searchParams.delete('bar')
  if (shown === 'live') page.searchParams.delete('v')
  else page.searchParams.set('v', shown)
  return page.toString()
}

/** A version chosen in the bar, for the open of the artefact it was chosen on. */
export interface VersionChoice {
  openedAt: string
  shown: string
}

/** What the panel shows: the choice made for this open, else the live folder. A new open by
 *  the agent (another folder, or the same one again) starts on the live folder (verifier
 *  round 4, finding 3: a number kept per session pointed at another artefact's versions). */
export const shownFor = (choice: VersionChoice | undefined, openedAt: string): string =>
  choice && choice.openedAt === openedAt ? choice.shown : 'live'

/** What the bar's chip says for what the panel shows. */
export const versionLabel = (shown: string): string =>
  shown === 'live' ? 'Live' : shown === 'latest' ? 'Latest' : `v${shown}`
