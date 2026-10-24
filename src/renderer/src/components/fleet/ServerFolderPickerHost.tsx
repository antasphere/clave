import { useMemo } from 'react'
import { resourceKey } from '@clave/contract/fleet'
import { RemoteDirectoryPicker, type DirectorySource } from '../ui/RemoteDirectoryPicker'
import { finishServerFolderPick, useServerFolderStore } from '../../store/server-folder-store'

/** The folder picker over a connected server's disk (#241), read through the
 *  fleet's file routing: the same picker the SSH Locations use, on the
 *  server's `files.list`. */
export function ServerFolderPickerHost(): React.JSX.Element | null {
  const request = useServerFolderStore((s) => s.request)
  const serverId = request?.serverId
  const startPath = request?.startPath
  const source = useMemo<DirectorySource | null>(() => {
    if (!serverId) return null
    const root = resourceKey('file', serverId, '/')
    return {
      id: `server:${serverId}:${startPath ?? '/'}`,
      home: async () => startPath || '/',
      list: async (path) =>
        (await window.electronAPI.readDir(root, path)).filter((e) => e.type === 'directory')
    }
  }, [serverId, startPath])
  if (!request || !source) return null
  return (
    <RemoteDirectoryPicker
      source={source}
      locationName={request.serverName}
      onSelect={(path) => finishServerFolderPick(path)}
      onCancel={() => finishServerFolderPick(null)}
    />
  )
}
