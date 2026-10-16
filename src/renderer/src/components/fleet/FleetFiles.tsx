import { useEffect, useState } from 'react'
import { FolderIcon, DocumentIcon, ArrowUpIcon } from '@heroicons/react/24/outline'
import { resourceKey } from '@clave/contract/fleet'
import { useSessionStore } from '../../store/session-store'
import type { DirEntry } from '../../../../preload/index.d'

/** Remote directory navigation uses only the owning Files API. */
export function FleetFiles({
  serverId,
  cwd
}: {
  serverId: string
  cwd: string
}): React.JSX.Element {
  const [path, setPath] = useState(cwd)
  const [entries, setEntries] = useState<DirEntry[]>([])
  const [notice, setNotice] = useState('')
  const [name, setName] = useState('')
  const [epoch, setEpoch] = useState(0)
  const root = resourceKey('file', serverId, '/')
  useEffect(() => {
    let current = true
    void window.electronAPI.readDir(root, path).then(
      (value) => {
        if (current) {
          setEntries(value)
          setNotice('')
        }
      },
      () => {
        if (current) setNotice('Could not read this folder on the server.')
      }
    )
    return () => {
      current = false
    }
  }, [root, path, epoch])
  const fullPath = (name: string): string => `${path.replace(/\/$/, '')}/${name}`
  const create = async (directory: boolean): Promise<void> => {
    if (
      !name.trim() ||
      name.includes('/') ||
      name.includes('\\') ||
      name === '.' ||
      name === '..'
    ) {
      setNotice('Enter one file or folder name.')
      return
    }
    try {
      await (directory
        ? window.electronAPI.createDirectory(root, fullPath(name))
        : window.electronAPI.createFile(root, fullPath(name)))
      setName('')
      setEpoch((v) => v + 1)
    } catch {
      setNotice('Could not create that entry on this server.')
    }
  }
  const upload = async (): Promise<void> => {
    const files = await window.electronAPI.sessionsFiles.pick()
    try {
      for (const file of files)
        await window.electronAPI.fleetUpload(root, fullPath(file.split('/').pop()!), file)
      setEpoch((v) => v + 1)
    } catch {
      setNotice('Upload failed. Existing files are never overwritten.')
    }
  }
  return (
    <section className="flex flex-col min-h-0 flex-1" data-fleet-files={serverId}>
      <div className="flex gap-2 items-center p-2">
        <button
          className="panel-icon-btn"
          aria-label="Parent server folder"
          onClick={() => setPath(path.slice(0, path.lastIndexOf('/')) || '/')}
        >
          <ArrowUpIcon className="w-4 h-4" />
        </button>
        <span className="text-xs truncate flex-1" title={path}>
          {path}
        </span>
        <button className="btn-secondary" onClick={() => setEpoch((v) => v + 1)}>
          Refresh
        </button>
        <button className="btn-secondary" onClick={() => void upload()}>
          Upload
        </button>
      </div>
      <div className="flex gap-2 p-2">
        <input
          className="input-compact min-w-0 flex-1"
          aria-label="New server entry name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button className="btn-secondary" onClick={() => void create(false)}>
          File
        </button>
        <button className="btn-secondary" onClick={() => void create(true)}>
          Folder
        </button>
      </div>
      {notice && (
        <p role="alert" className="text-xs text-text-secondary px-2">
          {notice}
        </p>
      )}
      <div className="overflow-auto min-h-0 flex-1 p-1">
        {entries.map((entry) => (
          <div key={entry.path} className="flex items-center gap-1">
            <button
              className="menu-item flex-1 min-w-0"
              draggable
              onDragStart={(event) => {
                const file = resourceKey('file', serverId, entry.path)
                event.dataTransfer.setData('application/x-clave-files', JSON.stringify([file]))
                event.dataTransfer.setData('text/plain', entry.path)
                event.dataTransfer.effectAllowed = 'copy'
              }}
              onClick={() => {
                if (entry.type === 'directory') {
                  setPath(entry.path)
                  return
                }
                const filePath = resourceKey('file', serverId, entry.path)
                useSessionStore.getState().addFileTab({ id: filePath, filePath, name: entry.name })
              }}
            >
              {entry.type === 'directory' ? (
                <FolderIcon className="w-4 h-4" />
              ) : (
                <DocumentIcon className="w-4 h-4" />
              )}
              <span className="truncate">{entry.name}</span>
            </button>
            {entry.type === 'file' && (
              <button
                className="btn-secondary"
                aria-label={`Download ${entry.name}`}
                onClick={() =>
                  void window.electronAPI
                    .fleetDownload(root, entry.path)
                    .catch(() => setNotice('Download failed.'))
                }
              >
                Download
              </button>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}
