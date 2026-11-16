/**
 * `clave_open_artefact` (PRDCT-4472): the one tool an agent opens an HTML
 * page, document or deck with, on both MCP servers. The server the session
 * runs on owns the artefact (`src/main/artefacts/service.ts`); the tool is a
 * thin arm over its `OpenArtefact` command. What both servers share lives
 * here, with no Electron, so the rules are tested without one: the input,
 * the two descriptions, the answer, and the side panel's refusal of what is
 * now this tool's.
 */
import { existsSync, statSync } from 'node:fs'
import { z } from 'zod'

export const OPEN_ARTEFACT_TOOL = 'clave_open_artefact'

export const openArtefactSchema = { path: z.string().min(1).max(4096) }

/** The standalone server's description: its sessions are shown on every Mac attached to it. */
export const OPEN_ARTEFACT_DESCRIPTION_SERVER =
  'THE tool for "show me the page", "open the deck", "let me see the report", "open the preview": shows an HTML page, document or deck you made beside YOUR session, on every Mac attached to this server. Pass an absolute path of this server: a FOLDER holding a self-contained index.html (inline style and script, its assets beside it), or one .html file. It is shown through Slideless, which this server runs: the page reloads on every edit you make to its files and a version is saved when each of your turns ends, so open it ONCE and keep editing; never open it again to refresh.'

/** The desktop's description: the same, on this Mac. */
export const OPEN_ARTEFACT_DESCRIPTION_DESKTOP =
  'THE tool for "show me the page", "open the deck", "let me see the report", "open the preview": shows an HTML page, document or deck you made beside YOUR session. Pass an absolute path of this Mac: a FOLDER holding a self-contained index.html (inline style and script, its assets beside it), or one .html file. It is shown through Slideless, which this Mac runs: the page reloads on every edit you make to its files and a version is saved when each of your turns ends, so open it ONCE and keep editing; never open it again to refresh.'

/** What the tool answers once the artefact is open. */
export const openedAnswer = (artefact: {
  readonly title: string
  readonly page: string
}): { opened: true; title: string; page: string } => ({
  opened: true,
  title: artefact.title,
  page: artefact.page
})

export const SIDE_PANEL_HTML_REFUSAL =
  'An HTML page or a folder opens with clave_open_artefact, not in the side panel.'

/**
 * The side panel is Markdown and email only: a path ending in `.html` or
 * `.htm` (any case), or an existing folder, is refused with the sentence
 * that names the tool for it. Null when the path may open in the panel.
 */
export function sidePanelRefusal(path: string | undefined): string | null {
  if (typeof path !== 'string' || path === '') return null
  if (/\.html?$/i.test(path)) return SIDE_PANEL_HTML_REFUSAL
  try {
    if (existsSync(path) && statSync(path).isDirectory()) return SIDE_PANEL_HTML_REFUSAL
  } catch {
    // Unreadable: the panel's own checks say why.
  }
  return null
}
