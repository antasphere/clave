import { useEffect, useRef, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { AnimatePresence } from 'framer-motion'
import { ModalScrim, ModalPositioner } from './dialog'
import { FolderIcon } from '@heroicons/react/24/outline'

interface ExportClaveDialogProps {
  isOpen: boolean
  defaultFileName: string
  onExport: (folder: string, fileName: string, keepSynced: boolean) => void | Promise<void>
  onCancel: () => void
}

export function ExportClaveDialog({
  isOpen,
  defaultFileName,
  onExport,
  onCancel
}: ExportClaveDialogProps) {
  const [folder, setFolder] = useState<string | null>(null)
  const [fileName, setFileName] = useState(defaultFileName)
  const [keepSynced, setKeepSynced] = useState(false)
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isOpen) {
      setFileName(defaultFileName)
      setKeepSynced(false)
      setError(undefined)
      // Load downloads path as default
      window.electronAPI?.getDownloadsPath().then((p) => {
        setFolder((prev) => prev ?? p)
      })
      setTimeout(() => inputRef.current?.focus(), 50)
    } else {
      setFolder(null)
    }
  }, [isOpen, defaultFileName])

  const handleExport = async (): Promise<void> => {
    const name = fileName.trim()
    if (!name || !folder || busy) return
    const finalName = name.endsWith('.clave') ? name : `${name}.clave`
    setBusy(true)
    setError(undefined)
    try {
      await onExport(folder, finalName, keepSynced)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  const handlePickFolder = async () => {
    const selected = await window.electronAPI.openFolderDialog()
    if (selected) setFolder(selected)
  }

  const folderName = folder ? folder.split('/').pop() || folder : null

  return (
    <DialogPrimitive.Root open={isOpen} onOpenChange={(open) => { if (!open) onCancel() }}>
      <AnimatePresence>
        {isOpen && (
          <DialogPrimitive.Portal forceMount>
            <DialogPrimitive.Overlay asChild>
              <ModalScrim />
            </DialogPrimitive.Overlay>
            <DialogPrimitive.Content
              asChild
              onOpenAutoFocus={(e) => e.preventDefault()}
              onCloseAutoFocus={(e) => e.preventDefault()}
            >
              <ModalPositioner className="w-[320px]">
                <div className="modal-card">
                  <div className="px-4 pt-4 pb-3">
                    <DialogPrimitive.Title className="text-[13px] font-semibold text-text-primary">
                      Export as .clave
                    </DialogPrimitive.Title>
                    <DialogPrimitive.Description className="mt-1 text-xs text-text-secondary">
                      Save this group definition to a file.
                    </DialogPrimitive.Description>
                    {error && <p role="alert" className="mt-2 text-xs text-text-secondary">{error}</p>}

                    {/* Folder picker */}
                    <button
                      type="button"
                      onClick={handlePickFolder}
                      className="mt-3 w-full h-8 px-3 rounded-lg bg-surface-100 border border-border-subtle flex items-center gap-2 text-xs hover:bg-surface-200 transition-colors group"
                      title={folder ?? 'Select folder'}
                    >
                      <FolderIcon className="w-3.5 h-3.5 flex-shrink-0 text-text-tertiary" />
                      <span className="flex-1 min-w-0 truncate text-left text-text-primary">
                        {folderName ?? 'Loading...'}
                      </span>
                      <span className="text-[10px] text-text-tertiary group-hover:text-text-secondary flex-shrink-0">
                        Change
                      </span>
                    </button>

                    {/* Filename input */}
                    <input
                      ref={inputRef}
                      type="text"
                      value={fileName}
                      onChange={(e) => setFileName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          handleExport()
                        }
                      }}
                      placeholder="filename.clave"
                      className="mt-2 input-compact"
                    />

                    {/* Keep synced toggle */}
                    <button
                      type="button"
                      onClick={() => setKeepSynced(!keepSynced)}
                      className="mt-3 w-full flex items-center gap-2.5 text-left"
                    >
                      <div className={`
                        w-8 h-[18px] rounded-full transition-colors flex-shrink-0 relative
                        ${keepSynced ? 'bg-accent' : 'bg-surface-200'}
                      `}>
                        <div className={`
                          absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow-sm transition-transform
                          ${keepSynced ? 'translate-x-[16px]' : 'translate-x-[2px]'}
                        `} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <span className="text-xs text-text-primary">Keep synced</span>
                        <p className="text-[10px] text-text-tertiary leading-tight mt-0.5">
                          Changes to the group will auto-update the file
                        </p>
                      </div>
                    </button>
                  </div>

                  <div className="border-t border-border-subtle flex">
                    <button
                      type="button"
                      onClick={onCancel}
                      className="btn-dialog text-text-secondary hover:text-text-primary border-r border-border-subtle"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleExport}
                      disabled={busy}
                      className="btn-dialog text-accent hover:brightness-110 outline-none"
                    >
                      Export
                    </button>
                  </div>
                </div>
              </ModalPositioner>
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        )}
      </AnimatePresence>
    </DialogPrimitive.Root>
  )
}
