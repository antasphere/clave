import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs'
import { basename, extname, join, resolve, isAbsolute } from 'path'
import { randomUUID } from 'crypto'
import {
  linkedOpenSchema,
  linkedUpdateSchema,
  type LinkedDocument,
  type DefaultSignature,
  type LinkedDocumentRead,
  type LinkedOpen,
  type LinkedUpdate
} from '../../shared/linked-documents'
import { digest, validateEmailHtml, importSignature } from './email'

/** Fields a build before PRDCT-3438 persisted for the composer's built-in send, removed since. */
const LEGACY_DELIVERY_FIELDS = ['delivery', 'deliveries', 'preparedPackages'] as const

/** Synchronous disk critical sections serialize IPC/MCP edits; the async signature imports use revision checks. */
export class LinkedDocumentStore {
  constructor(
    private root: string,
    private changed: () => void = () => {}
  ) {
    mkdirSync(root, { recursive: true, mode: 0o700 })
  }
  private file = (id: string): string => {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid document id')
    return join(this.root, id + '.json')
  }
  private write(file: string, value: unknown): void {
    const temp = file + '.' + randomUUID() + '.tmp'
    writeFileSync(temp, JSON.stringify(value), { mode: 0o600 })
    renameSync(temp, file)
  }
  private index(): Record<string, string> {
    const p = join(this.root, 'index.json')
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {}
  }
  list(): LinkedDocument[] {
    return Object.values(this.index()).map((id) => this.get(id))
  }
  get(id: string, sessionId?: string): LinkedDocument {
    const doc = JSON.parse(readFileSync(this.file(id), 'utf8')) as LinkedDocument &
      Partial<Record<(typeof LEGACY_DELIVERY_FIELDS)[number], unknown>>
    // A document written before the built-in send was removed still loads; its
    // delivery fields are dropped here so neither the composer nor an agent sees
    // them, and the next save writes the document without them.
    for (const field of LEGACY_DELIVERY_FIELDS) delete doc[field]
    if (sessionId && doc.sessionId !== sessionId)
      throw new Error('Document belongs to another session')
    return doc
  }
  current(sessionId: string): LinkedDocument {
    const id = this.index()[sessionId]
    if (!id) throw new Error('No linked document in this session')
    return this.get(id, sessionId)
  }
  private save(doc: LinkedDocument): LinkedDocument {
    this.write(this.file(doc.id), doc)
    this.changed()
    return doc
  }
  private check(doc: LinkedDocument, revision: number): void {
    if (doc.revision !== revision)
      throw new Error(
        `Revision conflict: expected ${revision}, current ${doc.revision}. Read the current document before editing.`
      )
  }
  private resolveFile(p: string): string {
    if (!isAbsolute(p)) throw new Error('Use an absolute local file path')
    const abs = resolve(p)
    if (!statSync(abs).isFile()) throw new Error('Expected a regular file')
    return abs
  }
  private readText(p: string): string {
    const abs = this.resolveFile(p)
    if (statSync(abs).size > 2000000) throw new Error('Document exceeds 2 MB')
    return readFileSync(abs, 'utf8')
  }
  private attachments(doc: LinkedDocument, paths: string[]): void {
    if (doc.attachments.length + paths.length > 30) throw new Error('At most 30 attachments')
    const staged = paths.map((p) => {
      const abs = this.resolveFile(p)
      if (statSync(abs).size > 18000000) throw new Error('Attachment exceeds 18 MB')
      const bytes = readFileSync(abs)
      return { bytes, name: basename(abs) }
    })
    if (
      doc.attachments.reduce((n, a) => n + a.size, 0) +
        staged.reduce((n, a) => n + a.bytes.length, 0) >
      18000000
    )
      throw new Error('Attachments exceed 18 MB total')
    for (const item of staged) {
      const id = randomUUID()
      const dir = join(this.root, doc.id, id)
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      writeFileSync(join(dir, item.name), item.bytes, { mode: 0o600 })
      doc.attachments.push({
        id,
        name: item.name,
        size: item.bytes.length,
        sha256: digest(item.bytes)
      })
    }
  }
  private signature(doc: LinkedDocument, html?: string, textPath?: string): void {
    if (!doc.email) throw new Error('Only emails have signatures')
    if (html) {
      validateEmailHtml(html)
      doc.email.signatureHtml = html
      doc.email.signatureText = textPath ? this.readText(textPath) : ''
    }
  }
  getDefaultSignature(): DefaultSignature | null {
    const file = join(this.root, 'preferences.json')
    return existsSync(file)
      ? (JSON.parse(readFileSync(file, 'utf8')).defaultSignature ?? null)
      : null
  }
  async setDefaultSignature(path: string): Promise<DefaultSignature> {
    const abs = this.resolveFile(path)
    await importSignature(abs)
    const twin = abs.replace(/\.html?$/i, '.txt')
    const value = { path: abs, ...(twin !== abs && existsSync(twin) ? { textPath: twin } : {}) }
    if (value.textPath) this.readText(value.textPath)
    this.write(join(this.root, 'preferences.json'), { defaultSignature: value })
    this.changed()
    return value
  }
  private async defaultSignature(): Promise<{ html: string; text: string }> {
    const pointer = this.getDefaultSignature()
    if (!pointer)
      throw new Error('No default signature set. Choose an HTML file or select No signature.')
    try {
      const html = await importSignature(this.resolveFile(pointer.path))
      return { html, text: pointer.textPath ? this.readText(pointer.textPath) : '' }
    } catch (error) {
      throw new Error(
        `Default signature could not be loaded. Change the default file or select No signature. ${String(error)}`
      )
    }
  }
  async open(sessionId: string, raw: LinkedOpen): Promise<LinkedDocument> {
    if (!sessionId) throw new Error('Calling session is required')
    const input = linkedOpenSchema.parse(raw)
    const signature = input.signaturePath
      ? await importSignature(this.resolveFile(input.signaturePath))
      : undefined
    const filePath = input.path ? this.resolveFile(input.path) : undefined
    const ext = filePath ? extname(filePath).toLowerCase() : ''
    if (filePath && !['.md', '.markdown', '.html', '.htm'].includes(ext))
      throw new Error('Linked files support Markdown and HTML')
    const prior = this.index()[sessionId]
    if (prior && filePath && this.get(prior).path === filePath)
      return this.update(prior, this.get(prior).revision, { hidden: false })
    const content = filePath ? this.readText(filePath) : ''
    const doc: LinkedDocument = {
      id: randomUUID(),
      sessionId,
      kind: filePath ? (ext === '.md' || ext === '.markdown' ? 'markdown' : 'html') : 'email',
      title: input.title || (filePath ? basename(filePath) : 'Email'),
      revision: 1,
      path: filePath,
      content,
      sourceHash: filePath ? digest(content) : undefined,
      email: input.email,
      attachments: [],
      hidden: false,
      split: 0.5,
      scroll: 0
    }
    if (doc.email) {
      doc.signatureMode = input.signaturePath || doc.email.signatureHtml ? 'custom' : 'none'
      const useDefault =
        input.signatureMode === 'default' ||
        (input.signatureMode !== 'none' &&
          !input.signaturePath &&
          !input.email?.signatureHtml &&
          !!this.getDefaultSignature())
      if (useDefault) {
        doc.signatureMode = 'default'
        try {
          const staged = await this.defaultSignature()
          doc.email.signatureHtml = staged.html
          doc.email.signatureText = staged.text
        } catch (error) {
          doc.signatureError = String(error)
        }
      } else if (input.signatureMode === 'none') {
        doc.signatureMode = 'none'
        doc.email.signatureHtml = ''
        doc.email.signatureText = ''
      }
      validateEmailHtml(doc.email.bodyHtml)
      validateEmailHtml(doc.email.signatureHtml)
      if (input.signaturePath) this.signature(doc, signature, input.signatureTextPath)
      if (doc.signatureMode === 'custom')
        doc.customSignature = { html: doc.email.signatureHtml, text: doc.email.signatureText }
      this.attachments(doc, input.attachments ?? [])
    } else if (input.attachments?.length || input.signaturePath || input.signatureMode)
      throw new Error('Attachments and signatures require an email')
    this.write(this.file(doc.id), doc)
    const index = this.index()
    index[sessionId] = doc.id
    this.write(join(this.root, 'index.json'), index)
    this.changed()
    return doc
  }
  async update(
    id: string,
    revision: number,
    raw: LinkedUpdate,
    sessionId?: string
  ): Promise<LinkedDocument> {
    const input = linkedUpdateSchema.parse(raw)
    this.check(this.get(id, sessionId), revision)
    const signature = input.signaturePath
      ? await importSignature(this.resolveFile(input.signaturePath))
      : undefined
    const defaultSignature =
      input.signatureMode === 'default' ? await this.defaultSignature() : undefined
    const doc = this.get(id, sessionId)
    this.check(doc, revision)
    const changesContent =
      input.content !== undefined ||
      input.email !== undefined ||
      input.addAttachments !== undefined ||
      input.removeAttachments !== undefined ||
      input.signaturePath !== undefined ||
      input.signatureMode !== undefined ||
      input.reloadExternal
    if (doc.kind === 'email') {
      if (input.content !== undefined || input.reloadExternal) throw new Error('Use email fields')
      if (input.email) {
        validateEmailHtml(input.email.bodyHtml)
        validateEmailHtml(input.email.signatureHtml)
        if (
          input.email.signatureHtml !== doc.email!.signatureHtml ||
          input.email.signatureText !== doc.email!.signatureText
        ) {
          doc.signatureMode = input.email.signatureHtml ? 'custom' : 'none'
          if (input.email.signatureHtml)
            doc.customSignature = {
              html: input.email.signatureHtml,
              text: input.email.signatureText
            }
          delete doc.signatureError
        }
        doc.email = input.email
      }
      if (input.removeAttachments)
        doc.attachments = doc.attachments.filter((a) => !input.removeAttachments!.includes(a.id))
      if (input.signaturePath) {
        this.signature(doc, signature, input.signatureTextPath)
        doc.signatureMode = 'custom'
        doc.customSignature = { html: doc.email!.signatureHtml, text: doc.email!.signatureText }
        delete doc.signatureError
      }
      if (input.signatureMode) {
        if (
          !doc.customSignature &&
          (doc.signatureMode === 'custom' || (!doc.signatureMode && doc.email!.signatureHtml))
        )
          doc.customSignature = { html: doc.email!.signatureHtml, text: doc.email!.signatureText }
        if (input.signatureMode === 'custom' && !doc.customSignature)
          throw new Error('No custom signature saved for this email')
        const staged = input.signatureMode === 'custom' ? doc.customSignature : defaultSignature
        doc.email!.signatureHtml = staged?.html ?? ''
        doc.email!.signatureText = staged?.text ?? ''
        doc.signatureMode = input.signatureMode
        delete doc.signatureError
      }
      if (input.addAttachments) this.attachments(doc, input.addAttachments)
    } else {
      if (
        input.email ||
        input.addAttachments ||
        input.removeAttachments ||
        input.signaturePath ||
        input.signatureMode
      )
        throw new Error('Email fields require an email')
      if (input.reloadExternal) {
        doc.content = this.readText(doc.path!)
        doc.sourceHash = digest(doc.content)
        delete doc.conflict
      } else if (input.content !== undefined) {
        doc.content = input.content
        try {
          if (digest(this.readText(doc.path!)) !== doc.sourceHash)
            throw new Error(
              'File changed outside this editor. Your edits are retained in Clave. Copy them before loading the external version.'
            )
          // Write through the actual path (including symlinks), preserving permissions.
          writeFileSync(doc.path!, doc.content, 'utf8')
          doc.sourceHash = digest(doc.content)
          delete doc.conflict
        } catch (error) {
          doc.conflict = error instanceof Error ? error.message : String(error)
        }
      }
    }
    if (changesContent) doc.revision++
    if (input.hidden !== undefined) doc.hidden = input.hidden
    if (input.split !== undefined) doc.split = input.split
    if (input.scroll !== undefined) doc.scroll = input.scroll
    return this.save(doc)
  }
  attachmentPath(id: string, attachmentId: string): string {
    const doc = this.get(id)
    if (!doc.attachments.some((a) => a.id === attachmentId)) throw new Error('Unknown attachment')
    return join(
      this.root,
      id,
      attachmentId,
      doc.attachments.find((a) => a.id === attachmentId)!.name
    )
  }
  /**
   * The document as an agent reads it: every attachment carries the absolute
   * path of the copy Clave retains, so the agent can attach it through its own
   * channel. Derived here from the store's root, never written to disk.
   */
  forAgent(doc: LinkedDocument): LinkedDocumentRead {
    return {
      ...doc,
      attachments: doc.attachments.map((a) => ({
        ...a,
        path: join(this.root, doc.id, a.id, a.name)
      }))
    }
  }
}
