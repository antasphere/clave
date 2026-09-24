import { useEffect, useState } from 'react'
import { DocumentIcon, XMarkIcon } from '@heroicons/react/24/outline'
import {
  attachmentIssue,
  type Attachment,
  type AttachmentPreview
} from '../../../src/shared/attachments'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle
} from '../../../src/renderer/src/components/ui/dialog'

/* The files on a message, as chips: in the composer while they can still be
   removed or downgraded to a reference, and again on the sent turn as the
   record of what went. A chip opens a preview; an image chip carries a
   thumbnail so a screenshot reads as the screenshot, not as a file name. */

const sizeLabel = (size: number): string =>
  size < 1024 ? `${size} B` : `${Math.ceil(size / 1024)} KiB`

function AttachmentChip({
  file,
  imagesSupported,
  onRemove,
  onReference
}: {
  file: Attachment
  imagesSupported: boolean
  onRemove?: () => void
  onReference?: () => void
}): React.JSX.Element {
  const [preview, setPreview] = useState<AttachmentPreview>()
  const [error, setError] = useState<string>()
  const [open, setOpen] = useState(false)
  const { id, path, name, mimeType, size, delivery } = file
  // Only a chip that can still change asks the question; a sent one is history.
  const issue = onRemove ? attachmentIssue(file, imagesSupported) : undefined
  useEffect(() => {
    // Images fetch their thumbnail at once; anything else waits for the dialog.
    if (!open && !mimeType.startsWith('image/')) return
    let current = true
    void window.electronAPI.sessionsFiles
      .preview({ id, path, name, mimeType, size, delivery })
      .then(
        (result) => {
          if (!current) return
          setPreview(result)
          setError(undefined)
        },
        (failure) => {
          if (current) setError(String(failure))
        }
      )
    return () => {
      current = false
    }
  }, [id, path, name, mimeType, size, delivery, open])
  return (
    <li className="chat-attachment" data-issue={issue ? 'true' : undefined}>
      <button
        type="button"
        className="chat-attachment-open"
        title={path}
        aria-label={`Preview ${name}`}
        onClick={() => setOpen(true)}
      >
        {preview?.image ? (
          <img className="chat-attachment-thumb" src={preview.image} alt="" />
        ) : (
          <DocumentIcon className="chat-attachment-glyph" />
        )}
        <span className="chat-attachment-text">
          <span className="chat-attachment-name">{name}</span>
          <span className="chat-attachment-hint">
            {delivery === 'image' ? 'Image' : 'File reference'} · {sizeLabel(size)}
          </span>
        </span>
      </button>
      {onRemove && (
        <button
          type="button"
          className="chat-turn-copy"
          aria-label={`Remove ${name}`}
          title="Remove"
          onClick={onRemove}
        >
          <XMarkIcon />
        </button>
      )}
      {issue && (
        <div className="chat-attachment-issue" role="status">
          <span>{issue}</span>
          <button type="button" className="chat-prompt-btn" onClick={onReference}>
            Send as file reference
          </button>
        </div>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="chat-attachment-dialog">
          <div className="chat-attachment-dialog-head">
            <DialogTitle>{name}</DialogTitle>
            <DialogClose className="chat-turn-copy" aria-label="Close preview">
              <XMarkIcon />
            </DialogClose>
          </div>
          <DialogDescription className="chat-attachment-dialog-path">{path}</DialogDescription>
          <div className="chat-attachment-dialog-body">
            {error ? (
              <p role="alert">{error}</p>
            ) : preview ? (
              <>
                {preview.image && <img src={preview.image} alt={name} />}
                {preview.text !== undefined && <pre>{preview.text}</pre>}
                {preview.notice && <p>{preview.notice}</p>}
              </>
            ) : (
              <p role="status">Loading preview…</p>
            )}
          </div>
          <div className="chat-prompt-actions">
            <span className="chat-prompt-spacer" />
            {onReference && delivery === 'image' && (
              <button
                type="button"
                className="chat-prompt-btn"
                onClick={() => {
                  onReference()
                  setOpen(false)
                }}
              >
                Send as file reference
              </button>
            )}
            <button
              type="button"
              className="chat-prompt-btn"
              onClick={() =>
                void window.electronAPI.sessionsFiles
                  .open(file)
                  .catch((failure) => setError(String(failure)))
              }
            >
              Open file
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </li>
  )
}

/** The chips of one message. With `onChange` they are the composer's, and
 *  each can be removed or sent as a reference instead; without it they are
 *  the transcript's record. */
export function Attachments({
  files,
  imagesSupported = false,
  onChange
}: {
  files: Attachment[]
  imagesSupported?: boolean
  onChange?: (files: Attachment[]) => void
}): React.JSX.Element | null {
  if (!files.length) return null
  return (
    <ul className="chat-attachments" aria-label={onChange ? 'Attached files' : 'Files sent'}>
      {files.map((file) => (
        <AttachmentChip
          key={file.id}
          file={file}
          imagesSupported={imagesSupported}
          onRemove={onChange ? () => onChange(files.filter((f) => f.id !== file.id)) : undefined}
          onReference={
            onChange
              ? () =>
                  onChange(
                    files.map((f) => (f.id === file.id ? { ...f, delivery: 'reference' } : f))
                  )
              : undefined
          }
        />
      ))}
    </ul>
  )
}
