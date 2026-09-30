import { registerLinkedFlusher } from '../../store/linked-document-store'
import { useEffect, useRef, useState } from 'react'
import { DocumentTextIcon, EnvelopeIcon, XMarkIcon } from '@heroicons/react/24/outline'
import type { LinkedDocument, LinkedEmail, LinkedUpdate } from '../../../../shared/linked-documents'
import { MarkdownPageEditor } from './MarkdownPageEditor'
import { HtmlPreviewFrame } from './HtmlPreviewFrame'
import { ViewModeToggle } from './ViewModeToggle'
import { IconButton } from '@clave/ui/components'
import { CodeEditor } from './CodeEditor'
import { LinkedEmailComposer } from './LinkedEmailComposer'

/**
 * The card a session's linked document lives in, inset in the session's frame
 * (see TerminalGrid). ONE shell for every kind — the header, the conflict
 * notice, the scroll area and the revisioned save queue are here; the body is
 * picked by kind: the email composer, the Markdown page editor, or the HTML
 * preview, the last two with a Source view.
 */
export function LinkedDocumentPanel({
  document: incoming
}: {
  document: LinkedDocument
}): React.JSX.Element {
  const [doc, setDoc] = useState(incoming)
  const current = useRef(incoming)
  const [status, setStatus] = useState('Saved')
  const [error, setError] = useState('')
  const [source, setSource] = useState(incoming.kind === 'html')
  const [signatureError, setSignatureError] = useState('')
  const [epoch, setEpoch] = useState(0)
  const pending = useRef(0)
  const queue = useRef(Promise.resolve())
  const scroll = useRef<HTMLDivElement>(null)
  const blocked = useRef(false)
  useEffect(
    () =>
      registerLinkedFlusher(
        incoming.sessionId,
        async (allowConflict) => {
          let last: Promise<void>
          do {
            last = queue.current
            await last
          } while (last !== queue.current)
          if (blocked.current || (!allowConflict && current.current.conflict))
            throw new Error(
              'Editor has unsaved/conflicting edits. Resolve them before handing off.'
            )
        },
        () => blocked.current
      ),
    [incoming.sessionId]
  )
  useEffect(() => {
    const close = (event: BeforeUnloadEvent): void => {
      if (pending.current || blocked.current) {
        event.preventDefault()
        event.returnValue = false
      }
    }
    window.addEventListener('beforeunload', close)
    return () => window.removeEventListener('beforeunload', close)
  }, [])
  useEffect(() => {
    if (pending.current || blocked.current || incoming.revision < current.current.revision) return
    if (incoming.revision !== current.current.revision) setEpoch((e) => e + 1)
    current.current = incoming
    setDoc(incoming)
  }, [incoming])
  useEffect(() => {
    if (scroll.current) scroll.current.scrollTop = incoming.scroll
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function update(input: LinkedUpdate, emailPatch?: Partial<LinkedEmail>): void {
    if (blocked.current) return
    pending.current++
    setStatus('Saving…')
    setError('')
    setSignatureError('')
    // Keep the visible buffer local while serializing every edit through the main revision boundary.
    if (input.content !== undefined) setDoc((d) => ({ ...d, content: input.content! }))
    if (input.email) setDoc((d) => ({ ...d, email: input.email }))
    if (emailPatch) setDoc((d) => ({ ...d, email: { ...d.email!, ...emailPatch } }))
    queue.current = queue.current.then(async () => {
      if (blocked.current) {
        pending.current--
        return
      }
      try {
        const saved = await window.electronAPI.linkedDocuments.update(
          current.current.id,
          current.current.revision,
          emailPatch ? { ...input, email: { ...current.current.email!, ...emailPatch } } : input
        )
        current.current = saved
        if (pending.current === 1) setDoc(saved)
        if (input.reloadExternal) setEpoch((e) => e + 1)
        setStatus(saved.conflict ? 'Conflict · edits retained' : 'Saved')
      } catch (e) {
        // Never overwrite the local buffer following an agent revision conflict.
        if (
          (input.signaturePath || input.signatureMode) &&
          !String(e).includes('Revision conflict')
        ) {
          setSignatureError(String(e))
          setStatus('Saved')
          return
        }
        blocked.current = true
        setError(String(e))
        setStatus('Not saved · copy your edits before reloading')
      } finally {
        pending.current--
      }
    })
  }
  return (
    <section
      className="linked-document-panel"
      data-testid="linked-document-panel"
      data-document-id={doc.id}
    >
      <header className="linked-document-header">
        <div className="flex items-center gap-2 flex-1 min-w-0" title={doc.path ?? doc.title}>
          {doc.email ? (
            <EnvelopeIcon className="w-4 h-4 flex-shrink-0 text-text-tertiary" />
          ) : (
            <DocumentTextIcon className="w-4 h-4 flex-shrink-0 text-text-tertiary" />
          )}
          <span className="truncate min-w-0 text-sm font-medium">{doc.title}</span>
        </div>
        {/* An email carries its save state in the composer's foot, beside the
            delivery state it belongs with; every other kind keeps it here. */}
        {doc.kind !== 'email' && (
          <span role="status" className="text-xs text-text-tertiary" title={status}>
            {status}
          </span>
        )}
        {doc.kind !== 'email' && (
          <ViewModeToggle
            mode={source ? 'source' : doc.kind === 'html' ? 'rendered' : 'page'}
            modes={doc.kind === 'html' ? ['rendered', 'source'] : ['page', 'source']}
            onChange={(mode) => setSource(mode === 'source')}
          />
        )}
        <IconButton
          className="panel-icon-btn"
          tooltip="Hide linked document"
          aria-label="Hide linked document"
          onClick={() => update({ hidden: true })}
        >
          <XMarkIcon className="w-4 h-4" />
        </IconButton>
      </header>
      {(error || doc.conflict) && (
        <div className="linked-document-notice" role="alert">
          {error || doc.conflict}
          <button
            className="panel-tab"
            onClick={() => {
              void navigator.clipboard.writeText(doc.email ? doc.email.bodyHtml : doc.content)
            }}
          >
            Copy my edits
          </button>
          <button
            className="panel-tab"
            onClick={async () => {
              if (pending.current) return
              if (doc.conflict) update({ reloadExternal: true })
              else {
                const latest = (await window.electronAPI.linkedDocuments.list()).find(
                  (d) => d.id === doc.id
                )
                if (latest) {
                  blocked.current = false
                  current.current = latest
                  setDoc(latest)
                  setEpoch((e) => e + 1)
                  setError('')
                  setStatus('Saved')
                }
              }
            }}
          >
            Load saved version
          </button>
        </div>
      )}
      <div
        ref={scroll}
        className="linked-document-content"
        onScroll={() => {
          const top = scroll.current?.scrollTop ?? 0
          if (!pending.current && !blocked.current) update({ scroll: top })
        }}
      >
        {doc.email ? (
          <LinkedEmailComposer
            doc={doc as LinkedDocument & { email: LinkedEmail }}
            epoch={epoch}
            status={status}
            update={update}
            onError={setError}
            signatureError={signatureError}
            onSignatureError={setSignatureError}
          />
        ) : source ? (
          <CodeEditor
            filename={doc.path!}
            value={doc.content}
            onChange={(content) => update({ content })}
          />
        ) : doc.kind === 'markdown' ? (
          <MarkdownPageEditor
            key={epoch}
            content={doc.content}
            onChange={(content) => update({ content })}
            onSave={() => {}}
          />
        ) : doc.conflict ? (
          <div className="linked-document-notice">
            Resolve the external file conflict before previewing. Your edits remain available in
            Source.
          </div>
        ) : (
          <HtmlPreviewFrame filePath={doc.path!} reloadKey={doc.revision} />
        )}
      </div>
    </section>
  )
}
