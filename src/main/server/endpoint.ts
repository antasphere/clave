/**
 * Where the in-process server is, once it runs: kept apart from the start
 * itself so the IPC handler that answers the preload loads nothing of the
 * server (Effect, the framework) at boot.
 */
export interface ClaveServerEndpoint {
  url: string
  token: string
}

let endpoint: ClaveServerEndpoint | null = null

export function getClaveServerEndpoint(): ClaveServerEndpoint | null {
  return endpoint
}

export function setClaveServerEndpoint(next: ClaveServerEndpoint | null): void {
  endpoint = next
}
