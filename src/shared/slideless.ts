/**
 * The Slideless command line as Clave manages it (PRDCT-4262): what the
 * renderer is told, and what it asks. Main owns the install and the dev
 * servers; the renderer shows the state and the artefacts.
 */
export interface SlidelessState {
  /** missing: not installed (or too old); installing: a download runs; ready: a CLI runs artefacts; error: the last install failed. */
  phase: 'missing' | 'installing' | 'ready' | 'error'
  version: string | null
  error: string | null
  /** The CLI comes from CLAVE_SLIDELESS_CLI, not from Clave's own install. */
  override?: boolean
}

export interface SlidelessServed {
  /** The local preview's address, `http://127.0.0.1:<port>/`. */
  url: string
}

export interface SlidelessSnapshot {
  version: number
  created: boolean
}

export interface SlidelessAPI {
  getState: () => Promise<SlidelessState>
  /** Install, or update to, the registry's latest release. */
  install: () => Promise<SlidelessState>
  /** Serve an artefact (a folder, or one .html file) and answer its address; shared by every caller of the same target. */
  serve: (target: string) => Promise<SlidelessServed>
  /** Let go of a target served for this caller; the server stops with its last holder. */
  release: (target: string) => Promise<void>
  /** Save a local version of a served target (nothing changed: no new version). */
  snapshot: (target: string) => Promise<SlidelessSnapshot>
  onState: (callback: (state: SlidelessState) => void) => () => void
}
