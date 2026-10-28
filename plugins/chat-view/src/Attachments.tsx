import { useEffect, useState } from 'react'
import { parseResourceKey } from '@clave/contract/fleet'
import { XMarkIcon } from '@heroicons/react/24/outline'
import {
  attachmentIssue,
  isFileAttachment,
  type Attachment,
  type AttachmentPreview,
  type FileAttachment,
  type SessionAttachment
} from '../../../src/shared/attachments'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle
} from '../../../src/renderer/src/components/ui/dialog'

/* The attachments on a message, as chips: in the composer while they can
   still be removed or downgraded to a reference, and again on the sent turn
   as the record of what went. A file chip opens a preview; an image chip
   carries a thumbnail so a screenshot reads as the screenshot, not as a file
   name. A session chip is another tab of the app: it names the tab and its
   agent, and has nothing to preview. Every chip shows its label, the name
   the message text refers to it by. */

const sizeLabel = (size: number): string =>
  size < 1024 ? `${size} B` : `${Math.ceil(size / 1024)} KiB`

/* The glyphs, in the hand of the drop card's drawing (DropDrawing.tsx): a
   page with its corner folded for a file, a row out of its column for a
   session. Ink at low opacity, the front box filled with paper. */
function PageGlyph(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 28" className="chat-attachment-glyph chat-drawing" aria-hidden="true">
      <path
        className="bx bx--front"
        d="M4,1 H14 L21,8 V25 a2,2 0 0 1 -2,2 H4 a2,2 0 0 1 -2,-2 V3 a2,2 0 0 1 2,-2 Z"
      />
      <path className="ln ln--thin" d="M14,1 V8 H21" />
      <line className="ln ln--thin" x1="6" y1="14" x2="17" y2="14" />
      <line className="ln ln--thin" x1="6" y1="19" x2="14" y2="19" />
    </svg>
  )
}
function SessionGlyph(): React.JSX.Element {
  return (
    <svg viewBox="0 0 28 28" className="chat-attachment-glyph chat-drawing" aria-hidden="true">
      <rect className="bx" x="2" y="3" width="18" height="6" rx="2" />
      <rect className="ln ln--soft" x="2" y="11" width="18" height="6" rx="2" />
      <rect className="bx" x="2" y="19" width="18" height="6" rx="2" />
      <rect className="bx bx--front" x="8" y="10" width="18" height="7" rx="2" />
      <circle className="dot" cx="12" cy="13.5" r="1.4" />
      <line className="ln ln--thin" x1="15" y1="13.5" x2="22" y2="13.5" />
    </svg>
  )
}
/** The label as a tag, the way the text carries it as a marker. */
function Tag({ label }: { label?: string }): React.JSX.Element | null {
  return label ? <span className="chat-attachment-tag">{label}</span> : null
}

function RemoveButton({
  name,
  onRemove
}: {
  name: string
  onRemove: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="chat-turn-copy"
      aria-label={`Remove ${name}`}
      title="Remove"
      onClick={onRemove}
    >
      <XMarkIcon />
    </button>
  )
}

function FileChip({
  file,
  imagesSupported,
  onRemove,
  onReference
}: {
  file: FileAttachment
  imagesSupported: boolean
  onRemove?: () => void
  onReference?: () => void
}): React.JSX.Element {
  const [preview, setPreview] = useState<AttachmentPreview>()
  const [error, setError] = useState<string>()
  const [open, setOpen] = useState(false)
  const { id, path, name, mimeType, size, delivery, label } = file
  const displayPath = parseResourceKey('file', path).id
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
  const kind = delivery === 'image' ? 'Image' : 'File reference'
  return (
    <li className="chat-attachment" data-issue={issue ? 'true' : undefined}>
      <button
        type="button"
        className="chat-attachment-open"
        title={displayPath}
        aria-label={`Preview ${name}`}
        onClick={() => setOpen(true)}
      >
        {preview?.image ? (
          <img className="chat-attachment-thumb" src={preview.image} alt="" />
        ) : (
          <PageGlyph />
        )}
        <span className="chat-attachment-text">
          <span className="chat-attachment-name">{name}</span>
          <span className="chat-attachment-hint">
            <Tag label={label} />
            {kind} · {sizeLabel(size)}
          </span>
        </span>
      </button>
      {onRemove && <RemoveButton name={name} onRemove={onRemove} />}
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
          <DialogDescription className="chat-attachment-dialog-path">
            {displayPath}
          </DialogDescription>
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

function SessionChip({
  file,
  onRemove
}: {
  file: SessionAttachment
  onRemove?: () => void
}): React.JSX.Element {
  const { name, agent, cwd, label } = file
  return (
    <li className="chat-attachment" data-session={file.sessionId}>
      <span className="chat-attachment-open" title={cwd || undefined}>
        <SessionGlyph />
        <span className="chat-attachment-text">
          <span className="chat-attachment-name">{name}</span>
          <span className="chat-attachment-hint">
            <Tag label={label} />
            Session · {agent}
          </span>
        </span>
      </span>
      {onRemove && <RemoveButton name={name} onRemove={onRemove} />}
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
  const remove = (file: Attachment): (() => void) | undefined =>
    onChange ? () => onChange(files.filter((f) => f.id !== file.id)) : undefined
  return (
    <ul className="chat-attachments" aria-label={onChange ? 'Attached files' : 'Files sent'}>
      {files.map((file) =>
        isFileAttachment(file) ? (
          <FileChip
            key={file.id}
            file={file}
            imagesSupported={imagesSupported}
            onRemove={remove(file)}
            onReference={
              onChange
                ? () =>
                    onChange(
                      files.map((f) =>
                        f.id === file.id && isFileAttachment(f)
                          ? { ...f, delivery: 'reference' }
                          : f
                      )
                    )
                : undefined
            }
          />
        ) : (
          <SessionChip key={file.id} file={file} onRemove={remove(file)} />
        )
      )}
    </ul>
  )
}
