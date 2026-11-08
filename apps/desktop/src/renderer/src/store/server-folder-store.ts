import { create } from 'zustand'

/** A folder to pick on a connected Clave server's disk (#241): ⌥ on a launch
 *  in a server workspace, and adding a server workspace. One request at a
 *  time; a new one cancels the last. The host that renders the picker is
 *  `ServerFolderPickerHost`, mounted once in the shell. */
export interface ServerFolderRequest {
  serverId: string
  /** The server's name, for the picker's title. */
  serverName: string
  /** Where the picker opens; the server's root when absent. */
  startPath?: string
  resolve: (path: string | null) => void
}

export const useServerFolderStore = create<{ request: ServerFolderRequest | null }>(() => ({
  request: null
}))

/** Resolves with the folder picked on the server, or null when cancelled. */
export function pickServerFolder(
  input: Omit<ServerFolderRequest, 'resolve'>
): Promise<string | null> {
  useServerFolderStore.getState().request?.resolve(null)
  return new Promise((resolve) => useServerFolderStore.setState({ request: { ...input, resolve } }))
}

export function finishServerFolderPick(path: string | null): void {
  const { request } = useServerFolderStore.getState()
  useServerFolderStore.setState({ request: null })
  request?.resolve(path)
}
