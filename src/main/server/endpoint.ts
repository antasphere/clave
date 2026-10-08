/**
 * Where the in-process server is, once it runs: kept apart from the start
 * itself so the IPC handler that answers the preload loads nothing of the
 * server (Effect, the framework) at boot.
 */
export interface ClaveServerEndpoint {
  url: string
  token: string
  /** Where the server runs: inside this app, or attached, as its own
   *  process. The preload reads it to pick the terminal pane's road: an
   *  attached app's terminal bytes come off the push channel, an in-process
   *  app's over IPC as always (one or the other, never both). */
  mode: 'in-process' | 'attached'
}

let endpoint: ClaveServerEndpoint | null = null

export function getClaveServerEndpoint(): ClaveServerEndpoint | null {
  return endpoint
}

export function setClaveServerEndpoint(next: ClaveServerEndpoint | null): void {
  endpoint = next
}
