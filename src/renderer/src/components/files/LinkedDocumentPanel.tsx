import { registerLinkedFlusher } from '../../store/linked-document-store'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  ChevronDownIcon,
  DocumentTextIcon,
  EnvelopeIcon,
  PaperClipIcon,
  XMarkIcon
} from '@heroicons/react/24/outline'
import type { LinkedDocument, LinkedEmail, LinkedUpdate } from '../../../../shared/linked-documents'
import { MarkdownPageEditor } from './MarkdownPageEditor'
import { HtmlPreviewFrame } from './HtmlPreviewFrame'
import { ViewModeToggle } from './ViewModeToggle'
import { IconButton } from '@clave/ui/components'
import { CodeEditor } from './CodeEditor'
import { FileIcon } from './file-icons'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@clave/ui/components'

const FIELD_LABELS = {
  from: 'From',
  to: 'To',
  cc: 'Cc',
  bcc: 'Bcc',
  subject: 'Subject'
} as const

/** Sandboxed rich HTML editing keeps imported email layout/styles outside app chrome. */
function EmailBody({
  html,
  onChange
}: {
  html: string
  onChange: (html: string) => void
}): React.JSX.Element {
  const ref = useRef<HTMLIFrameElement>(null)
  const observer = useRef<ResizeObserver | null>(null)
  const callback = useRef(onChange)
  // The sheet grows with the message: a fixed-height body makes you scroll
  // inside a box that is itself inside the panel's scroll.
  const [height, setHeight] = useState(180)
  useLayoutEffect(() => {
    callback.current = onChange
  }, [onChange])
  useEffect(() => () => observer.current?.disconnect(), [])
  const [initial] = useState(html)
  useEffect(() => {
    const body = ref.current?.contentDocument?.body
    if (body && body.innerHTML !== html && ref.current?.contentDocument?.activeElement !== body)
      body.innerHTML = html
  }, [html])
  return (
    <iframe
      ref={ref}
      title="Email body"
      className="linked-email-body"
      style={{ height }}
      sandbox="allow-same-origin"
      srcDoc={
        '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'"><style>html,body{margin:0}body{font:14px system-ui;line-height:1.65;padding:20px 22px;outline:none;overflow-wrap:anywhere}img{max-width:100%}</style></head><body>' +
        initial +
        '</body></html>'
      }
      onLoad={() => {
        const body = ref.current?.contentDocument?.body
        if (!body) return
        body.setAttribute('contenteditable', 'true')
        body.setAttribute('aria-label', 'Email body')
        const measure = (): void =>
          setHeight(Math.max(180, Math.ceil(body.getBoundingClientRect().height)))
        observer.current?.disconnect()
        observer.current = new ResizeObserver(measure)
        observer.current.observe(body)
        measure()
        body.addEventListener('input', () => callback.current(body.innerHTML))
        body.addEventListener('click', (event) => {
          if ((event.target as Element).closest('a')) event.preventDefault()
        })
      }}
    />
  )
}

function SignaturePreview({ html }: { html: string }): React.JSX.Element {
  const observer = useRef<ResizeObserver | null>(null)
  const [height, setHeight] = useState(96)
  useEffect(() => () => observer.current?.disconnect(), [])
  return (
    <iframe
      title="Signature preview"
      className="linked-signature-preview"
      sandbox="allow-same-origin"
      style={{ height }}
      srcDoc={
        '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'">' +
        html
      }
      onLoad={(event) => {
        observer.current?.disconnect()
        const body = event.currentTarget.contentDocument?.body
        if (!body) return
        const measure = (): void => setHeight(Math.ceil(body.getBoundingClientRect().height) + 16)
        observer.current = new ResizeObserver(measure)
        observer.current.observe(body)
        measure()
      }}
    />
  )
}

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
  const [showCopies, setShowCopies] = useState(!!(incoming.email?.cc || incoming.email?.bcc))
  const [defaultPath, setDefaultPath] = useState('')
  const [signatureError, setSignatureError] = useState('')
  useEffect(() => {
    const refresh = (): void => {
      void window.electronAPI.linkedDocuments
        .getDefaultSignature()
        .then((value) => setDefaultPath(value?.path ?? ''))
    }
    refresh()
    return window.electronAPI.linkedDocuments.onChanged(refresh)
  }, [])
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
  function changeEmail(field: keyof LinkedEmail, value: string): void {
    update({}, { [field]: value })
  }
  async function choose(signature = false): Promise<void> {
    try {
      const files = await window.electronAPI.linkedDocuments.chooseFiles(signature)
      if (files.length) update(signature ? { signaturePath: files[0] } : { addAttachments: files })
    } catch (e) {
      setError(String(e))
    }
  }
  async function chooseDefault(): Promise<void> {
    try {
      const files = await window.electronAPI.linkedDocuments.chooseFiles(true)
      if (!files.length) return
      const value = await window.electronAPI.linkedDocuments.setDefaultSignature(files[0])
      setDefaultPath(value.path)
      setSignatureError('')
      // The preference affects future drafts. Applying it here remains an explicit revisioned edit.
      update({ signatureMode: 'default' })
    } catch (e) {
      setSignatureError(String(e))
    }
  }
  const delivery = doc.delivery
  const deliveryLine = delivery
    ? `${delivery.status === 'sent' ? 'Sent' : delivery.status === 'failed' ? 'Sending failed' : 'Delivery uncertain'} · revision ${delivery.revision}${delivery.revision !== doc.revision ? ' · current edits are unsent' : ''}${delivery.detail ? '. ' + delivery.detail : ''}`
    : 'Ask your agent to send this email'
  const saveState = status.startsWith('Saving')
    ? 'saving'
    : status.startsWith('Saved')
      ? 'saved'
      : 'error'
  const hasCustomSignature = !!(
    doc.customSignature ||
    doc.signatureMode === 'custom' ||
    (!doc.signatureMode && doc.email?.signatureHtml)
  )
  const signatureChoice = doc.signatureMode ?? (doc.email?.signatureHtml ? 'custom' : 'none')
  return (
    <section
      className="linked-document-panel floating-card"
      data-testid="linked-document-panel"
      data-document-id={doc.id}
    >
      <header className="linked-document-header linked-document-titlebar">
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
          <div className="linked-email-composer">
            <div className="linked-email-fields">
              {(['from', 'to', 'cc', 'bcc', 'subject'] as const)
                .filter(
                  (field) => !['cc', 'bcc'].includes(field) || showCopies || !!doc.email![field]
                )
                .map((field) => (
                  <div
                    key={field}
                    className={
                      field === 'subject'
                        ? 'linked-email-field linked-email-field--subject'
                        : 'linked-email-field'
                    }
                  >
                    <span>{FIELD_LABELS[field]}</span>
                    <input
                      aria-label={FIELD_LABELS[field]}
                      value={doc.email![field]}
                      onChange={(e) => changeEmail(field, e.target.value)}
                    />
                    {/* The disclosure belongs on the row it adds lines to, the
                        way every mail client places it. */}
                    {field === 'to' && (
                      <button
                        className="panel-tab"
                        aria-label="Cc / Bcc"
                        aria-expanded={showCopies}
                        onClick={() => setShowCopies((v) => !v)}
                        title="Show or hide optional copy recipients"
                      >
                        Cc
                      </button>
                    )}
                  </div>
                ))}
            </div>
            <div className="linked-email-sheet">
              <EmailBody
                key={epoch}
                html={doc.email.bodyHtml}
                onChange={(html) => changeEmail('bodyHtml', html)}
              />
            </div>
            <Collapsible defaultOpen>
              <div className="linked-email-section">
                <CollapsibleTrigger
                  className="panel-icon-btn linked-email-section-toggle"
                  aria-label="Toggle signature section"
                >
                  <ChevronDownIcon className="w-3.5 h-3.5" />
                </CollapsibleTrigger>
                <span>Signature</span>
                {/* Deliberately a native select, not the app's dropdown menu: an
                    agent can revise this document at any moment, and a portalled
                    menu closes itself on the re-render that follows — under the
                    user's hand. The class gives it the panel chip's box. */}
                <select
                  className="linked-email-select"
                  aria-label="Signature choice"
                  title="Choose a signature for this email only"
                  value={signatureChoice}
                  onChange={(event) =>
                    update({ signatureMode: event.target.value as 'default' | 'none' | 'custom' })
                  }
                >
                  <option value="default">Use default</option>
                  <option value="none">No signature</option>
                  {hasCustomSignature && <option value="custom">Custom signature</option>}
                </select>
                <button
                  className="panel-tab"
                  title={`Use this file here and as the default for new emails${defaultPath ? ': ' + defaultPath : ''}`}
                  onClick={() => void chooseDefault()}
                >
                  {defaultPath ? 'Change default' : 'Set default'}
                </button>
                <button
                  className="panel-tab"
                  title="Import a signature for this email only"
                  onClick={() => void choose(true)}
                >
                  Import
                </button>
              </div>
              {/* Outside the collapsible content on purpose: a signature that
                  blocks preparation has to stay visible with the section shut. */}
              {(signatureError || doc.signatureError) && (
                <div className="linked-document-notice" role="alert">
                  {signatureError || doc.signatureError}
                </div>
              )}
              <CollapsibleContent>
                {doc.email.signatureHtml ? (
                  <div className="linked-email-signature">
                    <SignaturePreview html={doc.email.signatureHtml} />
                  </div>
                ) : (
                  <p className="text-xs text-text-tertiary px-4 pb-3">No signature selected</p>
                )}
              </CollapsibleContent>
            </Collapsible>
            <Collapsible defaultOpen>
              <div className="linked-email-section">
                <CollapsibleTrigger
                  className="panel-icon-btn linked-email-section-toggle"
                  aria-label="Toggle attachments section"
                >
                  <ChevronDownIcon className="w-3.5 h-3.5" />
                </CollapsibleTrigger>
                <span>
                  Attachments{doc.attachments.length ? ` · ${doc.attachments.length}` : ''}
                </span>
                <button className="panel-tab" onClick={() => void choose()}>
                  <PaperClipIcon className="w-4 h-4" />
                  Add files
                </button>
              </div>
              <CollapsibleContent>
                {doc.attachments.length ? (
                  <div className="linked-email-attachments">
                    {doc.attachments.map((a) => (
                      <span className="linked-email-attachment" key={a.id}>
                        <FileIcon name={a.name} className="flex-shrink-0 text-text-tertiary" />
                        <button
                          className="truncate min-w-0"
                          title={a.name}
                          onClick={() => {
                            void window.electronAPI.linkedDocuments
                              .openAttachment(doc.id, a.id)
                              .catch((e) => setError(String(e)))
                          }}
                        >
                          {a.name}
                        </button>
                        <span>{Math.ceil(a.size / 1024)} KB</span>
                        <button
                          className="linked-email-attachment-remove"
                          aria-label={`Remove ${a.name}`}
                          onClick={() => update({ removeAttachments: [a.id] })}
                        >
                          <XMarkIcon className="w-3 h-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-text-tertiary px-4 pb-3">No attachments</p>
                )}
              </CollapsibleContent>
            </Collapsible>
            {/* Save state and delivery state answer the same question, so they
                share the foot; the notice surface goes back to meaning trouble. */}
            <div className="linked-email-foot">
              <span className="linked-email-foot-dot" data-state={saveState} />
              <span role="status" className="truncate" title={status}>
                {status} · revision {doc.revision}
              </span>
              <span className="flex-1" />
              <span className="truncate" title={deliveryLine}>
                {deliveryLine}
              </span>
            </div>
          </div>
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
