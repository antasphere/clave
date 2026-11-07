/**
 * What page a group shows, and which declaration decides it.
 *
 * A group can name its page two ways in a `.clave` file. A terminal declaring
 * `groupView: true` says "the page I serve is what this group is about" — the
 * dynamic form, and the one that carries a start action, since the view knows
 * which terminal to run when the probe says the server is down. A group-level
 * `view` names a page that needs no process at all: an http(s) URL, or an .html
 * file on disk (a frozen snapshot, a generated report), resolved against the
 * file's root dir at read time so what arrives here is already absolute.
 *
 * The rules live here, apart from the store, because this is the one place a
 * declaration is interpreted and both failure modes must stay testable:
 *
 *  - A `groupView` without a `serverUrl` is INERT, never a broken frame. Clave
 *    scans a terminal's output for a localhost URL only while its pane is
 *    visible, and a group view exists precisely so nobody looks at the terminal
 *    — there is no URL to detect, so it must be declared.
 *  - A malformed `view` is INERT too. A `.clave` file is hand-written and
 *    unvalidated, and a group whose main pane is a permanently failing probe is
 *    worse than a group that simply kept its sessions.
 */
export interface GroupViewCandidate {
  id?: string
  groupView?: boolean
  serverUrl?: string
}

export interface ResolvedGroupView {
  url: string
  title?: string
  terminalId?: string | null
}

const isHttpUrl = (s: string): boolean => /^https?:\/\//i.test(s)
/** Absolute by the time it reaches us — the read path resolves it against the file's dir. */
const isHtmlFile = (s: string): boolean => s.startsWith('/') && /\.html?$/i.test(s)

/** The first terminal that both declares the view and says where it is served. */
export function pickGroupViewTerminal<T extends GroupViewCandidate>(terminals: T[]): T | undefined {
  return terminals.find((t) => t.groupView === true && !!t.serverUrl && isHttpUrl(t.serverUrl))
}

/**
 * The view a launching group takes from its `.clave` declarations, or undefined
 * when it declares none. A terminal's `groupView` wins over a group-level `view`:
 * a served page is the live one, and it comes with the start action.
 */
export function resolveDeclaredGroupView<T extends GroupViewCandidate>(
  terminals: T[],
  view: string | null | undefined,
  title?: string
): ResolvedGroupView | undefined {
  const terminal = pickGroupViewTerminal(terminals)
  if (terminal) return { url: terminal.serverUrl as string, title, terminalId: terminal.id ?? null }
  if (view && (isHttpUrl(view) || isHtmlFile(view))) return { url: view, title, terminalId: null }
  return undefined
}
