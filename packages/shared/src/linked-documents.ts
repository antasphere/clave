import { z } from 'zod'

const header = z
  .string()
  .max(2000)
  .refine((s) => !/[\r\n\0]/.test(s), 'Header must be a single line')
export const emailSchema = z
  .object({
    from: header.default(''),
    to: header.default(''),
    cc: header.default(''),
    bcc: header.default(''),
    subject: header.default(''),
    bodyHtml: z.string().max(500000).default('<p></p>'),
    signatureHtml: z.string().max(4500000).default(''),
    signatureText: z.string().max(500000).default(''),
    replyTo: header.optional(),
    inReplyTo: header.optional(),
    references: header.optional(),
    threadId: header.optional()
  })
  .strict()
export type LinkedEmail = z.infer<typeof emailSchema>
export interface LinkedAttachment {
  id: string
  name: string
  size: number
  sha256: string
}
export interface LinkedDocument {
  id: string
  sessionId: string
  kind: 'markdown' | 'html' | 'email'
  title: string
  revision: number
  path?: string
  content: string
  sourceHash?: string
  conflict?: string
  email?: LinkedEmail
  signatureMode?: 'default' | 'custom' | 'none'
  signatureError?: string
  customSignature?: { html: string; text: string }
  attachments: LinkedAttachment[]
  hidden: boolean
  split: number
  scroll: number
}
/**
 * What an agent reads back through `clave_side_panel`: the document with each
 * attachment's absolute file path, so the agent can attach the retained copy
 * through its own channel. The panel is review-only by design (PRDCT-3438):
 * Clave holds no mail credentials, so the agent sends, never the panel. The
 * path is derived from the store's root at read time and never persisted.
 */
export interface LinkedAttachmentRead extends LinkedAttachment {
  path: string
}
export type LinkedDocumentRead = Omit<LinkedDocument, 'attachments'> & {
  attachments: LinkedAttachmentRead[]
}
export const linkedOpenSchema = z
  .object({
    path: z.string().optional(),
    title: z.string().max(200).optional(),
    email: emailSchema.optional(),
    attachments: z.array(z.string()).max(30).optional(),
    signaturePath: z.string().optional(),
    signatureMode: z.enum(['default', 'none']).optional(),
    signatureTextPath: z.string().optional()
  })
  .strict()
  .refine((v) => !(v.signatureMode && v.signaturePath), 'Choose signatureMode or signaturePath')
  .refine((v) => Boolean(v.path) !== Boolean(v.email), 'Supply exactly one of path or email')
export type LinkedOpen = z.infer<typeof linkedOpenSchema>
export const linkedUpdateSchema = z
  .object({
    content: z.string().max(2000000).optional(),
    email: emailSchema.optional(),
    hidden: z.boolean().optional(),
    split: z.number().min(0.25).max(0.75).optional(),
    scroll: z.number().min(0).optional(),
    addAttachments: z.array(z.string()).max(30).optional(),
    removeAttachments: z.array(z.string()).optional(),
    signaturePath: z.string().optional(),
    signatureMode: z.enum(['default', 'none', 'custom']).optional(),
    signatureTextPath: z.string().optional(),
    reloadExternal: z.boolean().optional()
  })
  .strict()
  .refine((v) => !(v.signatureMode && v.signaturePath), 'Choose signatureMode or signaturePath')
export type LinkedUpdate = z.infer<typeof linkedUpdateSchema>
export interface DefaultSignature {
  path: string
  textPath?: string
}
export interface LinkedDocumentsAPI {
  getDefaultSignature: () => Promise<DefaultSignature | null>
  setDefaultSignature: (path: string) => Promise<DefaultSignature>

  list: () => Promise<LinkedDocument[]>
  open: (sessionId: string, input: LinkedOpen) => Promise<LinkedDocument>
  update: (id: string, revision: number, input: LinkedUpdate) => Promise<LinkedDocument>
  openAttachment: (id: string, attachmentId: string) => Promise<void>
  chooseFiles: (signature?: boolean) => Promise<string[]>
  onChanged: (callback: () => void) => () => void
}
