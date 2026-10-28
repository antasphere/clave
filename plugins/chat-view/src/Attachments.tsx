import { useEffect, useState } from 'react'
import { parseResourceKey } from '@clave/contract/fleet'
import { attachmentFamily, FAMILY_NAMES, type AttachmentFamily } from '@clave/contract/attachments'
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
   as the record of what went. A chip names its record and says what it is
   (its family, from its media type: a video, a sheet, a folder) with the one
   figure that matters (its size, a folder's item count); it opens a preview,
   an image chip carries a thumbnail so a screenshot reads as the screenshot,
   and a folder previews as its listing. A session chip is another tab of the
   app: it names the tab and its agent, and has nothing to preview. Every
   chip shows its label, the name the message text refers to it by. */

const sizeLabel = (size: number): string =>
  size < 1024
    ? `${size} B`
    : size < 1024 * 1024
      ? `${Math.ceil(size / 1024)} KiB`
      : `${(size / (1024 * 1024)).toFixed(1)} MiB`

/* The glyphs, one per family, in the hand of the drop card's drawing
   (DropDrawing.tsx): ink at low opacity, the box in front filled with paper,
   the dot as the one solid mark. Each is the thing at its plainest: a page
   with its corner folded, a frame with a horizon, a strip with its play
   mark, a few bars of sound, a grid, a slide, a box with its zipper, a
   folder with its tab, a row out of its column for a session. */
const PAGE = (
  <>
    <path
      className="bx bx--front"
      d="M6,2 H16 L23,9 V24 a2,2 0 0 1 -2,2 H6 a2,2 0 0 1 -2,-2 V4 a2,2 0 0 1 2,-2 Z"
    />
    <path className="ln ln--thin" d="M16,2 V9 H23" />
  </>
)
const FRAME = <rect className="bx bx--front" x="3" y="5" width="22" height="18" rx="2" />
const GLYPHS: Record<AttachmentFamily, React.JSX.Element> = {
  file: PAGE,
  text: (
    <>
      {PAGE}
      <line className="ln ln--thin" x1="8" y1="14" x2="19" y2="14" />
      <line className="ln ln--thin" x1="8" y1="18" x2="17" y2="18" />
      <line className="ln ln--thin" x1="8" y1="22" x2="14" y2="22" />
    </>
  ),
  document: (
    <>
      {PAGE}
      <line className="ln" x1="8" y1="13" x2="18" y2="13" />
      <line className="ln ln--thin" x1="8" y1="17.5" x2="19" y2="17.5" />
      <line className="ln ln--thin" x1="8" y1="21.5" x2="15" y2="21.5" />
    </>
  ),
  pdf: (
    <>
      {PAGE}
      <rect className="bx" x="8" y="15" width="11" height="6" rx="1" />
      <line className="ln ln--thin" x1="10" y1="18" x2="17" y2="18" />
    </>
  ),
  code: (
    <>
      {PAGE}
      <path className="ln ln--thin" d="M11.5,14 L8.5,17.5 L11.5,21" />
      <path className="ln ln--thin" d="M16.5,14 L19.5,17.5 L16.5,21" />
    </>
  ),
  image: (
    <>
      {FRAME}
      <path className="ln ln--thin" d="M5,21 L11,13 L15,18 L18,15 L23,21" />
      <circle className="dot" cx="19" cy="10" r="1.6" />
    </>
  ),
  video: (
    <>
      {FRAME}
      <line className="ln ln--thin" x1="3" y1="9" x2="25" y2="9" />
      <line className="ln ln--thin" x1="3" y1="19" x2="25" y2="19" />
      <path className="bx" d="M11.5,11 L18,14 L11.5,17 Z" />
    </>
  ),
  audio: (
    <>
      <line className="ln" x1="6" y1="11" x2="6" y2="17" />
      <line className="ln" x1="10" y1="8" x2="10" y2="20" />
      <line className="ln" x1="14" y1="5" x2="14" y2="23" />
      <line className="ln" x1="18" y1="9" x2="18" y2="19" />
      <line className="ln" x1="22" y1="12" x2="22" y2="16" />
    </>
  ),
  sheet: (
    <>
      {FRAME}
      <path className="ln ln--thin" d="M3,11 H25 M3,17 H25 M10,5 V23 M17,5 V23" />
    </>
  ),
  slides: (
    <>
      <rect className="bx bx--front" x="3" y="6" width="22" height="16" rx="2" />
      <line className="ln" x1="7" y1="11" x2="16" y2="11" />
      <rect className="bx" x="7" y="14" width="7" height="4.5" rx="1" />
      <line className="ln ln--thin" x1="16.5" y1="15" x2="21" y2="15" />
      <line className="ln ln--thin" x1="16.5" y1="18" x2="20" y2="18" />
    </>
  ),
  archive: (
    <>
      <rect className="bx bx--front" x="5" y="3" width="18" height="22" rx="2" />
      <line className="ln ln--soft" x1="14" y1="3" x2="14" y2="16" />
      <rect className="bx" x="11.5" y="16" width="5" height="5" rx="1" />
    </>
  ),
  folder: (
    <>
      <path
        className="bx bx--front"
        d="M4,8 a2,2 0 0 1 2,-2 h6 l3,3 h7 a2,2 0 0 1 2,2 v11 a2,2 0 0 1 -2,2 H6 a2,2 0 0 1 -2,-2 Z"
      />
      <line className="ln ln--thin" x1="4" y1="12.5" x2="24" y2="12.5" />
    </>
  )
}
function Glyph({ family }: { family: AttachmentFamily }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 28 28"
      className="chat-attachment-glyph chat-drawing"
      data-family={family}
      aria-hidden="true"
    >
      {GLYPHS[family]}
    </svg>
  )
}
function SessionGlyph(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 28 28"
      className="chat-attachment-glyph chat-drawing"
      data-family="session"
      aria-hidden="true"
    >
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

/** What a chip says under the name: the family, then the one figure. An
 *  image that goes as a path says so, since its label is a File's. */
function describe(file: FileAttachment): string {
  const family = attachmentFamily(file.mimeType)
  if (file.delivery === 'folder') {
    const count = file.entries ?? 0
    return `Folder · ${count} ${count === 1 ? 'item' : 'items'}`
  }
  const word =
    family === 'image' && file.delivery !== 'image' ? 'Image, as a path' : FAMILY_NAMES[family]
  return `${word} · ${sizeLabel(file.size)}`
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
  const { id, path, name, mimeType, size, delivery, label, entries } = file
  const family = attachmentFamily(mimeType)
  const displayPath = parseResourceKey('file', path).id
  // Only a chip that can still change asks the question; a sent one is history.
  const issue = onRemove ? attachmentIssue(file, imagesSupported) : undefined
  useEffect(() => {
    // Images fetch their thumbnail at once; anything else waits for the dialog.
    if (!open && !mimeType.startsWith('image/')) return
    let current = true
    void window.electronAPI.sessionsFiles
      .preview({
        id,
        path,
        name,
        mimeType,
        size,
        delivery,
        ...(entries === undefined ? {} : { entries })
      })
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
  }, [id, path, name, mimeType, size, delivery, entries, open])
  return (
    <li className="chat-attachment" data-family={family} data-issue={issue ? 'true' : undefined}>
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
          <Glyph family={family} />
        )}
        <span className="chat-attachment-text">
          <span className="chat-attachment-name">{name}</span>
          <span className="chat-attachment-hint">
            <Tag label={label} />
            {describe(file)}
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
              {delivery === 'folder' ? 'Open folder' : 'Open file'}
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
    <li className="chat-attachment" data-family="session" data-session={file.sessionId}>
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
