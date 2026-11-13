import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { LinkedDocumentStore } from './store'
import { emailSchema } from '../../shared/linked-documents'
import { importSignature, validateEmailHtml } from './email'
import { SIDE_PANEL_HTML_REFUSAL } from '../mcp/artefact-tool'
const dirs: string[] = []
function fixture(): { root: string; store: LinkedDocumentStore } {
  const root = mkdtempSync(join(tmpdir(), 'clave-linked-'))
  dirs.push(root)
  return { root, store: new LinkedDocumentStore(join(root, 'store')) }
}
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
const email = (): ReturnType<typeof emailSchema.parse> =>
  emailSchema.parse({
    from: 'sender@example.test',
    to: 'reader@example.test',
    subject: 'Synthetic subject',
    bodyHtml: '<p>Hello <strong>reader</strong>.</p>',
    signatureHtml: '<table cellpadding="0"><tr><td>Example team</td></tr></table>'
  })
describe('linked documents boundaries', () => {
  it('stages a generic HTTP response only when its bytes identify a supported raster image', async () => {
    const { root } = fixture()
    const path = join(root, 'signature.html')
    writeFileSync(path, '<img src="https://synthetic.example.test/avatar" alt="Synthetic" />')
    // Synthetic JPEG signature and body; no personal image or remote URL is retained.
    const bytes = Buffer.concat([
      Buffer.from('ffd8ffe000104a46494600010100000100010000', 'hex'),
      Buffer.alloc(54_407),
      Buffer.from('ffd9', 'hex')
    ])
    const html = await importSignature(
      path,
      async () => new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } })
    )
    expect(html).toContain(`data:image/jpeg;base64,${bytes.toString('base64')}`)
    for (const type of ['application/octet-stream', 'image/jpeg']) {
      await expect(
        importSignature(
          path,
          async () =>
            new Response('<svg>not a raster image</svg>', { headers: { 'content-type': type } })
        )
      ).rejects.toThrow('must contain')
    }
  })

  it('retains external conflict edits on disk, rejects stale agent revisions, reloads explicitly', async () => {
    const { root, store } = fixture(),
      path = join(root, 'a.md')
    writeFileSync(path, '# Original')
    const doc = await store.open('one', { path })
    writeFileSync(path, '# Agent change')
    const edited = await store.update(doc.id, 1, { content: '# User change' })
    expect(edited.conflict).toContain('outside')
    expect(readFileSync(path, 'utf8')).toBe('# Agent change')
    expect(new LinkedDocumentStore(join(root, 'store')).current('one').content).toBe(
      '# User change'
    )
    await expect(store.update(doc.id, 1, { content: 'stale' }, 'one')).rejects.toThrow(
      'Revision conflict'
    )
    const reloaded = await store.update(doc.id, 2, { reloadExternal: true })
    expect(reloaded.content).toBe('# Agent change')
    expect(reloaded.conflict).toBeUndefined()
  })
  it('copies attachment bytes, preserves names, and names the retained copy by its absolute path for the agent', async () => {
    const { root, store } = fixture(),
      path = join(root, 'original.pdf')
    const bytes = Buffer.from([0, 1, 255, 40])
    writeFileSync(path, bytes)
    const doc = await store.open('one', { email: email(), attachments: [path] })
    rmSync(path)
    const read = store.forAgent(store.current('one'))
    expect(read.attachments).toHaveLength(1)
    expect(read.attachments[0].path).toBe(store.attachmentPath(doc.id, doc.attachments[0].id))
    expect(read.attachments[0].path).toMatch(/^\/.*\/original\.pdf$/)
    expect(readFileSync(read.attachments[0].path)).toEqual(bytes)
    expect(read.attachments[0]).toMatchObject({
      name: 'original.pdf',
      size: 4,
      sha256: doc.attachments[0].sha256
    })
    // The path is derived at read time, never written with the document.
    const persisted = JSON.parse(readFileSync(join(root, 'store', doc.id + '.json'), 'utf8'))
    expect(persisted.attachments[0]).not.toHaveProperty('path')
    const updated = store.forAgent(
      await store.update(doc.id, 1, { email: { ...email(), subject: 'Reviewed' } }, 'one')
    )
    expect(updated.attachments[0].path).toBe(read.attachments[0].path)
  })
  it("refuses another session's edit of the linked email", async () => {
    const { store } = fixture()
    const doc = await store.open('one', { email: email() })
    await expect(
      store.update(doc.id, 1, { email: { ...email(), subject: 'Other' } }, 'two')
    ).rejects.toThrow('another session')
    expect(store.get(doc.id).email?.subject).toBe('Synthetic subject')
  })
  it('loads a document written with the removed delivery fields and drops them', async () => {
    const { root, store } = fixture()
    const doc = await store.open('one', { email: email() })
    const file = join(root, 'store', doc.id + '.json')
    writeFileSync(
      file,
      JSON.stringify({
        ...JSON.parse(readFileSync(file, 'utf8')),
        delivery: { revision: 1, packageId: 'p', status: 'sent', messageId: 'm' },
        deliveries: { '1': { revision: 1, packageId: 'p', status: 'sent' } },
        preparedPackages: { p: 'seal' }
      })
    )
    const restarted = new LinkedDocumentStore(join(root, 'store'))
    const loaded = restarted.current('one')
    expect(loaded.email).toEqual(email())
    expect(loaded.revision).toBe(1)
    for (const field of ['delivery', 'deliveries', 'preparedPackages']) {
      expect(loaded).not.toHaveProperty(field)
      expect(restarted.forAgent(loaded)).not.toHaveProperty(field)
    }
    const saved = await restarted.update(doc.id, 1, {
      email: { ...email(), subject: 'After upgrade' }
    })
    expect(saved.revision).toBe(2)
    expect(JSON.parse(readFileSync(file, 'utf8'))).not.toHaveProperty('delivery')
  })

  it('stages local and HTTPS signature images and keeps them after the source is removed', async () => {
    const { root, store } = fixture()
    const image = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6pZsAAAAASUVORK5CYII=',
      'base64'
    )
    writeFileSync(join(root, 'logo.png'), image)
    const path = join(root, 'signature.html')
    writeFileSync(
      path,
      '<table cellpadding="0" cellspacing="0" role="presentation"><tr><td align="left"><img src="logo.png" width="62" height="62" alt="Logo" /></td><td><a href="https://example.test">Synthetic team</a></td></tr></table>'
    )
    const doc = await store.open('one', { email: email(), signaturePath: path })
    rmSync(join(root, 'logo.png'))
    expect(doc.email?.signatureHtml).toContain('data:image/png;base64,')
    expect(doc.email?.signatureHtml).toContain(image.toString('base64').slice(0, 60))
    expect(doc.email?.signatureHtml).not.toContain('logo.png')
    expect(
      new LinkedDocumentStore(join(root, 'store')).forAgent(store.get(doc.id)).email?.signatureHtml
    ).toBe(doc.email?.signatureHtml)
    writeFileSync(path, '<img src="https://example.test/logo.png" alt="Remote" />')
    let fetched = 0
    const staged = await importSignature(path, async () => {
      fetched++
      return new Response(image, { headers: { 'content-type': 'image/png' } })
    })
    expect(fetched).toBe(1)
    expect(staged).toContain('data:image/png;base64,')
    expect(staged).not.toContain('https://example.test/logo.png')
  })
  it('rejects active or unresolved signature content instead of silently dropping it', () => {
    for (const html of [
      '<script>alert(1)</script>',
      '<img src="https://x.test/a.png">',
      '<div onclick="x()">x</div>',
      '<div style="background:url(https://x.test)">x</div>'
    ])
      expect(() => validateEmailHtml(html)).toThrow('Unsupported')
  })
})

describe('default signature snapshots', () => {
  it('persists a file pointer, stages new drafts, and keeps existing snapshots after file/preference changes', async () => {
    const { root, store } = fixture()
    const path = join(root, 'signature.html')
    writeFileSync(path, '<p>First signature</p>')
    writeFileSync(join(root, 'signature.txt'), 'Text twin')
    await store.setDefaultSignature(path)
    const reopened = new LinkedDocumentStore(join(root, 'store'))
    expect(reopened.getDefaultSignature()).toEqual({ path, textPath: join(root, 'signature.txt') })
    const first = await reopened.open('first', { email: { ...email(), signatureHtml: '' } })
    expect(first.signatureMode).toBe('default')
    expect(first.email!.signatureHtml).toContain('First signature')
    expect(first.email!.signatureText).toBe('Text twin')
    writeFileSync(path, '<p>Second signature</p>')
    const second = await reopened.open('second', { email: { ...email(), signatureHtml: '' } })
    expect(second.email!.signatureHtml).toContain('Second signature')
    expect(reopened.get(first.id).email!.signatureHtml).toContain('First signature')
    const other = join(root, 'other.html')
    writeFileSync(other, '<p>Other signature</p>')
    await reopened.setDefaultSignature(other)
    expect(reopened.get(second.id).email!.signatureHtml).toContain('Second signature')
    const applied = await reopened.update(first.id, first.revision, { signatureMode: 'default' })
    expect(applied.email).toEqual({
      ...first.email,
      signatureHtml: '<p>Other signature</p>',
      signatureText: ''
    })
    expect(applied.revision).toBe(first.revision + 1)
    await expect(
      reopened.update(first.id, first.revision, { signatureMode: 'none' })
    ).rejects.toThrow('Revision conflict')
    const none = await reopened.open('none', { email: email(), signatureMode: 'none' })
    expect(none.email!.signatureHtml).toBe('')
    const custom = await reopened.open('custom', { email: email() })
    expect(custom.signatureMode).toBe('custom')
    expect(custom.email!.signatureHtml).toBe(email().signatureHtml)
    const without = await reopened.update(custom.id, custom.revision, { signatureMode: 'none' })
    const restored = await reopened.update(custom.id, without.revision, { signatureMode: 'custom' })
    expect(restored.email!.signatureHtml).toBe(custom.email!.signatureHtml)
  })
  it('keeps a missing default visible, to the user and to the agent, until explicitly recovered', async () => {
    const { root, store } = fixture()
    const path = join(root, 'signature.html')
    writeFileSync(path, '<p>Default</p>')
    await store.setDefaultSignature(path)
    rmSync(path)
    const draft = await store.open('missing', { email: { ...email(), signatureHtml: '' } })
    expect(draft.signatureError).toContain('Default signature could not be loaded')
    expect(store.forAgent(store.current('missing')).signatureError).toBe(draft.signatureError)
    await expect(
      store.update(draft.id, draft.revision, { signatureMode: 'default' })
    ).rejects.toThrow('Default signature')
    expect(store.get(draft.id).revision).toBe(draft.revision)
    const recovered = await store.update(draft.id, draft.revision, { signatureMode: 'none' })
    expect(recovered.signatureError).toBeUndefined()
    expect(recovered.email!.bodyHtml).toBe(draft.email!.bodyHtml)
    writeFileSync(path, '<script>unsafe</script>')
    await expect(store.setDefaultSignature(path)).rejects.toThrow()
    expect(store.getDefaultSignature()!.path).toBe(path)
  })
})

it('rejects contradictory signature choices without mutating draft or preference', async () => {
  const { root, store } = fixture()
  const path = join(root, 'signature.html')
  writeFileSync(path, '<p>Signature</p>')
  await expect(
    store.open('one', { email: email(), signaturePath: path, signatureMode: 'none' })
  ).rejects.toThrow('Choose signatureMode or signaturePath')
  const draft = await store.open('one', { email: email() })
  await expect(
    store.update(draft.id, draft.revision, { signaturePath: path, signatureMode: 'none' })
  ).rejects.toThrow('Choose signatureMode or signaturePath')
  expect(store.get(draft.id)).toEqual(draft)
  expect(store.getDefaultSignature()).toBeNull()
})

describe('the side panel follows its file (PRDCT-4261)', () => {
  it('reloads on the watcher only when the file differs from what the panel holds', async () => {
    const { root, store } = fixture()
    const path = join(root, 'page.md')
    writeFileSync(path, '# one')
    const doc = await store.open('s1', { path })
    // Nothing changed: no new revision, nothing re-read.
    const same = await store.update(doc.id, doc.revision, { reloadExternal: true, ifChanged: true })
    expect(same.revision).toBe(doc.revision)
    // The panel's own save writes the file: the watcher that follows is a no-op.
    const saved = await store.update(doc.id, doc.revision, { content: '# mine' })
    const after = await store.update(saved.id, saved.revision, {
      reloadExternal: true,
      ifChanged: true
    })
    expect(after.revision).toBe(saved.revision)
    expect(after.content).toBe('# mine')
    // An agent rewrites it: the watcher reloads it.
    writeFileSync(path, '# agent')
    const reloaded = await store.update(after.id, after.revision, {
      reloadExternal: true,
      ifChanged: true
    })
    expect(reloaded.revision).toBe(after.revision + 1)
    expect(reloaded.content).toBe('# agent')
  })

  it('never reloads over a conflict the person has to resolve', async () => {
    const { root, store } = fixture()
    const path = join(root, 'page.md')
    writeFileSync(path, '# one')
    const doc = await store.open('s1', { path })
    writeFileSync(path, '# outside')
    const conflicted = await store.update(doc.id, doc.revision, { content: '# my edit' })
    expect(conflicted.conflict).toBeTruthy()
    writeFileSync(path, '# outside again')
    const kept = await store.update(conflicted.id, conflicted.revision, {
      reloadExternal: true,
      ifChanged: true
    })
    expect(kept.content).toBe('# my edit')
    expect(kept.conflict).toBeTruthy()
  })

  it('opening the same file again shows what is on disk now', async () => {
    const { root, store } = fixture()
    const path = join(root, 'page.md')
    writeFileSync(path, '# one')
    const first = await store.open('s1', { path })
    await store.update(first.id, first.revision, { hidden: true })
    writeFileSync(path, '# two')
    const again = await store.open('s1', { path })
    expect(again.id).toBe(first.id)
    expect(again.hidden).toBe(false)
    expect(again.content).toBe('# two')
    expect(again.revision).toBe(first.revision + 1)
    // Unchanged on disk: the same revision, only shown again.
    const third = await store.open('s1', { path })
    expect(third.revision).toBe(again.revision)
  })

  it('never opens an HTML page or a folder: that is the session’s artefact (PRDCT-4474)', async () => {
    const { root, store } = fixture()
    const folder = join(root, 'brief')
    mkdirSync(folder)
    writeFileSync(join(folder, 'index.html'), '<h1>brief</h1>')
    writeFileSync(join(root, 'page.HTM'), '<h1>page</h1>')
    for (const path of [folder, join(folder, 'index.html'), join(root, 'page.HTM')])
      await expect(store.open('s1', { path })).rejects.toThrow(SIDE_PANEL_HTML_REFUSAL)
    expect(store.list()).toEqual([])
  })

  it('still opens Markdown and email', async () => {
    const { root, store } = fixture()
    writeFileSync(join(root, 'notes.markdown'), '# notes')
    expect((await store.open('s1', { path: join(root, 'notes.markdown') })).kind).toBe('markdown')
    expect((await store.open('s2', { email: email() })).kind).toBe('email')
    expect(
      store
        .list()
        .map((d) => d.kind)
        .sort()
    ).toEqual(['email', 'markdown'])
  })

  it('drops a stored HTML document at load, and leaves its page on disk alone', async () => {
    const { root, store } = fixture()
    writeFileSync(join(root, 'notes.md'), '# kept')
    const kept = await store.open('s1', { path: join(root, 'notes.md') })
    const page = join(root, 'old.html')
    writeFileSync(page, '<h1>old</h1>')
    // A record an earlier build wrote for an HTML page, beside the Markdown one.
    const id = '00000000-0000-4000-8000-000000000001'
    const record = { ...kept, id, sessionId: 's2', kind: 'html', path: page, root: root }
    writeFileSync(join(root, 'store', id + '.json'), JSON.stringify(record))
    const index = JSON.parse(readFileSync(join(root, 'store', 'index.json'), 'utf8'))
    writeFileSync(join(root, 'store', 'index.json'), JSON.stringify({ ...index, s2: id }))
    const reopened = new LinkedDocumentStore(join(root, 'store'))
    expect(reopened.list().map((d) => d.id)).toEqual([kept.id])
    expect(existsSync(join(root, 'store', id + '.json'))).toBe(false)
    expect(JSON.parse(readFileSync(join(root, 'store', 'index.json'), 'utf8'))).toEqual({
      s1: kept.id
    })
    expect(readFileSync(page, 'utf8')).toBe('<h1>old</h1>')
  })
})

describe('round 1 of the review (PRDCT-4261, PRDCT-4262)', () => {
  it('a file gone on the watcher’s call is not an error: the panel keeps what it holds, and follows it back', async () => {
    const { root, store } = fixture()
    const path = join(root, 'notes.md')
    writeFileSync(path, '# one')
    const doc = await store.open('s1', { path })
    rmSync(path)
    const kept = await store.update(doc.id, doc.revision, { reloadExternal: true, ifChanged: true })
    expect(kept.revision).toBe(doc.revision)
    expect(kept.content).toBe('# one')
    expect(kept.conflict).toBeUndefined()
    writeFileSync(path, '# back')
    const back = await store.update(kept.id, kept.revision, {
      reloadExternal: true,
      ifChanged: true
    })
    expect(back.content).toBe('# back')
  })

  it('opening the same file again never reloads over a conflict', async () => {
    const { root, store } = fixture()
    const path = join(root, 'page.md')
    writeFileSync(path, '# one')
    const doc = await store.open('s1', { path })
    writeFileSync(path, '# outside')
    const conflicted = await store.update(doc.id, doc.revision, { content: '# my edit' })
    expect(conflicted.conflict).toBeTruthy()
    const again = await store.open('s1', { path })
    expect(again.content).toBe('# my edit')
    expect(again.conflict).toBeTruthy()
  })
})

describe('round 2 of the review: a save typed before a reload landed', () => {
  it('is kept as a conflict, never written over the file the panel reloaded', async () => {
    const { root, store } = fixture()
    const path = join(root, 'notes.md')
    writeFileSync(path, '# one')
    const doc = await store.open('s1', { path })
    writeFileSync(path, '# the agent rewrote it')
    const reloaded = await store.update(doc.id, doc.revision, {
      reloadExternal: true,
      ifChanged: true
    })
    const saved = await store.update(reloaded.id, reloaded.revision, {
      content: '# one, and my key',
      stale: true
    })
    expect(readFileSync(path, 'utf8')).toBe('# the agent rewrote it')
    expect(saved.content).toBe('# one, and my key')
    expect(saved.conflict).toMatch(/changed on disk while you typed/)
  })
})

describe('round 3 of the review: a conflict ends only when the file is loaded', () => {
  it('keeps the agent’s file through every keystroke after a stale save, until the person loads it', async () => {
    const { root, store } = fixture()
    const path = join(root, 'notes.md')
    writeFileSync(path, 'first words')
    const doc = await store.open('s1', { path })
    writeFileSync(path, 'the agent rewrote it')
    const reloaded = await store.update(doc.id, doc.revision, {
      reloadExternal: true,
      ifChanged: true
    })
    const stale = await store.update(reloaded.id, reloaded.revision, {
      content: 'Wfirst words',
      stale: true
    })
    expect(stale.conflict).toBeTruthy()
    const next = await store.update(stale.id, stale.revision, { content: 'WXfirst words' })
    expect(readFileSync(path, 'utf8')).toBe('the agent rewrote it')
    expect(next.conflict).toBeTruthy()
    expect(next.content).toBe('WXfirst words')
    const loaded = await store.update(next.id, next.revision, { reloadExternal: true })
    expect(loaded.conflict).toBeUndefined()
    expect(loaded.content).toBe('the agent rewrote it')
    const after = await store.update(loaded.id, loaded.revision, {
      content: 'the agent rewrote it!'
    })
    expect(readFileSync(path, 'utf8')).toBe('the agent rewrote it!')
    expect(after.conflict).toBeUndefined()
  })
})

describe('round 4 of the review: a conflict from a passing write error still heals', () => {
  it('writes again once the cause is gone, while a stale conflict keeps blocking', async () => {
    const { root, store } = fixture()
    const path = join(root, 'notes.md')
    writeFileSync(path, 'one')
    const doc = await store.open('s1', { path })
    // An outside writer changes the file, then puts it back: the conflict
    // its change raised heals on the next keystroke, as it always did.
    writeFileSync(path, 'someone else')
    const conflicted = await store.update(doc.id, doc.revision, { content: 'one!' })
    expect(conflicted.conflict).toBeTruthy()
    writeFileSync(path, 'one')
    const healed = await store.update(conflicted.id, conflicted.revision, { content: 'one!!' })
    expect(healed.conflict).toBeUndefined()
    expect(readFileSync(path, 'utf8')).toBe('one!!')
  })
})
