import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, readdirSync } from 'node:fs'
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  userDataDir,
  mcpEndpoint,
  mcpHttpClient,
  spawnAgentTabIn,
  toolPayload,
  toolErrored,
  callMcp,
  fixturePath
} from './harness.mjs'
const DIR = userDataDir('linked-documents')
const ROOT = fixturePath('linked-documents-root')
const WS = {
  id: 'aaaa0000-0000-4000-8000-000000000021',
  name: 'Linked documents',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn) {
  for (let i = 0; i < 80; i++) {
    const v = await fn()
    if (v) return v
    await sleep(100)
  }
  throw Error('Condition timed out')
}
export async function run(t) {
  mkdirSync(ROOT, { recursive: true })
  writeFileSync(`${ROOT}/draft.md`, '# Linked draft\n\nOriginal words.\n')
  writeFileSync(`${ROOT}/page.html`, '<h1>HTML original</h1>')
  writeFileSync(`${ROOT}/page.css`, 'h1 { color: rgb(19, 73, 121) }')
  writeFileSync(`${ROOT}/attachment.txt`, 'SYNTHETIC ATTACHMENT BYTES')
  writeFileSync(
    `${ROOT}/signature.html`,
    '<table cellpadding="0" role="presentation"><tr><td><img width="62" height="62" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6pZsAAAAASUVORK5CYII=" alt="Synthetic logo" /></td><td>Example team</td></tr></table>'
  )
  seedWorkspaces(DIR, { workspaces: [WS], activeWorkspaceId: WS.id, fresh: true })
  seedTrustedRoots(DIR, [ROOT])
  let { app, win } = await launchApp(DIR)
  try {
    async function chooseTheme(name) {
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].webContents.send(
          'menu:open-settings-section',
          'appearance'
        )
      )
      await win.getByRole('button', { name, exact: true }).click()
      await win.getByRole('button', { name: 'Back to sessions' }).click()
      await win.waitForTimeout(200)
    }
    if (process.env.CLAVE_LINKED_CAPTURE) await chooseTheme('Dark')
    writeFileSync(`${ROOT}/fake-agent.sh`, '#!/bin/sh\nexec sleep 3600\n')
    chmodSync(`${ROOT}/fake-agent.sh`, 0o755)
    await win.evaluate(
      async ({ root, ws }) => {
        await window.electronAPI.launchProfileUpsert({
          id: 'linked-fake-claude',
          name: 'Synthetic agent',
          family: 'claude',
          command: [root + '/fake-agent.sh'],
          additionalArgs: []
        })
        await window.electronAPI.launchProfileSetWorkspace(ws, 'claude', 'linked-fake-claude')
      },
      { root: ROOT, ws: WS.id }
    )
    const agent = await spawnAgentTabIn(app, win, DIR)
    t.check('authenticated caller session minted', !!agent?.token)
    const client = mcpHttpClient(mcpEndpoint(DIR), agent.token)
    await client.init()
    const other = await callMcp(app, 'openSession', {
      mode: 'terminal',
      cwd: ROOT,
      name: 'Other document session'
    })
    const opened = await client.call('clave_open_side_panel', { path: `${ROOT}/draft.md` })
    t.check('actual MCP opens linked Markdown', !toolErrored(opened), opened)
    const doc = toolPayload(opened)
    await win.locator('[data-testid="linked-document-panel"]').waitFor({ state: 'visible' })
    const layout = await win.evaluate(() => {
      const panel = document.querySelector('[data-testid="linked-document-panel"]')
      const pr = panel.getBoundingClientRect()
      const grid = [...document.querySelectorAll('div')].find(
        (el) => el.className === 'h-full grid gap-2'
      )
      const gr = grid.getBoundingClientRect()
      return {
        right: pr.x >= gr.right,
        leftWidth: gr.width,
        rightWidth: pr.width,
        hit: panel.contains(document.elementFromPoint(pr.x + pr.width / 2, pr.y + pr.height / 2))
      }
    })
    t.check(
      'focused conversation left and editable document right own hit-tested halves',
      layout.right && layout.leftWidth > 100 && layout.rightWidth > 100 && layout.hit,
      layout
    )
    const editor = win.locator('[data-testid="linked-document-panel"] .markdown-page-content')
    await editor.click()
    await win.keyboard.press('Meta+End')
    await win.keyboard.type(' Final character Z')
    if (process.env.CLAVE_LINKED_CAPTURE)
      await win.screenshot({ path: fixturePath('linked-markdown.png') })
    const immediate = toolPayload(await client.call('clave_side_panel', { action: 'read' }))
    t.check(
      'immediate agent handoff flushes final typed character',
      immediate.content.includes('Final character Z'),
      immediate
    )
    t.check(
      'Markdown edits autosave source file',
      readFileSync(`${ROOT}/draft.md`, 'utf8').includes('Final character Z')
    )
    await callMcp(app, 'focus', { sessionId: other.sessionId })
    t.equal(
      'switching sessions hides linked editor',
      await win.locator('[data-testid="linked-document-panel"]:visible').count(),
      0
    )
    await callMcp(app, 'focus', { sessionId: agent.sessionId })
    await editor.waitFor({ state: 'visible' })
    t.check(
      'return restores editor content',
      await editor.textContent().then((v) => v.includes('Final character Z'))
    )
    writeFileSync(`${ROOT}/draft.md`, '# External writer\n')
    await editor.click()
    await win.keyboard.type(' retained user edit')
    await until(() => win.getByRole('alert').count())
    t.equal(
      'external file never silently overwritten',
      readFileSync(`${ROOT}/draft.md`, 'utf8'),
      '# External writer\n'
    )
    await client.call('clave_side_panel', { action: 'read' }) // flushes even when conflict result is an error
    const conflictEditor = await editor.textContent()
    const focusAtConflict = await win.evaluate(() =>
      document.activeElement?.outerHTML.slice(0, 300)
    )
    const persisted = JSON.parse(readFileSync(`${DIR}/linked-documents/${doc.id}.json`, 'utf8'))
    t.check(
      'conflicting user buffer remains durable',
      persisted.content.includes('retained user edit'),
      { saved: persisted.content, visible: conflictEditor, focus: focusAtConflict }
    )
    await win.getByRole('button', { name: 'Load saved version' }).click()
    await until(() =>
      win
        .getByRole('alert')
        .count()
        .then((c) => c === 0)
    )
    const html = await client.call('clave_open_side_panel', { path: `${ROOT}/page.html` })
    t.check('HTML link opens through same MCP flow', !toolErrored(html), html)
    const source = win.locator('[data-testid="linked-document-panel"] .cm-content')
    await source.fill(
      '<link rel="stylesheet" href="page.css"><h1>Edited HTML</h1><script>window.linkedLoads = 1</script>'
    )
    await client.call('clave_side_panel', { action: 'read' })
    t.equal(
      'HTML source autosaves',
      readFileSync(`${ROOT}/page.html`, 'utf8'),
      '<link rel="stylesheet" href="page.css"><h1>Edited HTML</h1><script>window.linkedLoads = 1</script>'
    )
    await win.getByRole('button', { name: 'Rendered', exact: true }).click()
    await win.frameLocator('iframe[title="page.html"]').getByText('Edited HTML').waitFor()
    const htmlFrame = win.frameLocator('iframe[title="page.html"]')
    t.equal(
      'linked HTML resolves relative CSS',
      await htmlFrame.locator('h1').evaluate((el) => getComputedStyle(el).color),
      'rgb(19, 73, 121)'
    )
    await htmlFrame.locator('body').evaluate(() => {
      window.linkedLoads = 7
    })
    await callMcp(app, 'focus', { sessionId: other.sessionId })
    await callMcp(app, 'focus', { sessionId: agent.sessionId })
    t.equal(
      'linked HTML frame retains in-page state on session switch',
      await htmlFrame.locator('body').evaluate(() => window.linkedLoads),
      7
    )

    if (process.env.CLAVE_LINKED_CAPTURE) await chooseTheme('Light')
    await win.evaluate(
      (path) => window.electronAPI.linkedDocuments.setDefaultSignature(path),
      `${ROOT}/signature.html`
    )
    const email = await client.call('clave_open_side_panel', {
      email: {
        from: 'sender@example.test',
        to: 'reader@example.test',
        subject: 'Synthetic email',
        bodyHtml: '<p>Hello reader.</p>'
      },
      attachments: [`${ROOT}/attachment.txt`]
    })
    t.check('structured email opens with signature and attachments', !toolErrored(email), email)
    const emailDoc = toolPayload(email)
    t.equal('fresh MCP email applies profile default', emailDoc.signatureMode, 'default')
    await win.getByLabel('Signature choice').selectOption('none')
    const optedOut = toolPayload(await client.call('clave_side_panel', { action: 'read' }))
    t.equal('composer can opt out of default', optedOut.email.signatureHtml, '')
    await win.getByLabel('Signature choice').selectOption('default')
    const reapplied = toolPayload(await client.call('clave_side_panel', { action: 'read' }))
    t.check(
      'applying default preserves body recipients and attachment',
      reapplied.email.bodyHtml === emailDoc.email.bodyHtml &&
        reapplied.email.to === emailDoc.email.to &&
        reapplied.attachments[0].sha256 === emailDoc.attachments[0].sha256
    )
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, `${ROOT}/signature.html`)
    await win.getByRole('button', { name: 'Change default', exact: true }).click()
    await win.getByLabel('Subject', { exact: true }).fill('Subject while applying default')
    const duringDefault = toolPayload(
      await client.call('clave_side_panel', { action: 'read' })
    )
    t.equal(
      'editing while picker applies default keeps final subject',
      duringDefault.email.subject,
      'Subject while applying default'
    )
    t.check(
      'editing while picker applies default retains staged signature',
      duringDefault.email.signatureHtml.includes('Example team')
    )
    t.equal(
      'optional copy recipients start collapsed',
      await win.getByLabel('Cc', { exact: true }).count(),
      0
    )
    await win.getByRole('button', { name: 'Cc / Bcc' }).click()
    await win.getByLabel('Cc', { exact: true }).fill('copy@example.test')
    await win.getByRole('button', { name: 'Cc / Bcc' }).click()
    t.check(
      'nonempty Cc remains visible when disclosure collapses',
      await win.getByLabel('Cc', { exact: true }).isVisible()
    )
    rmSync(`${ROOT}/attachment.txt`)
    rmSync(`${ROOT}/signature.html`)
    await win.getByLabel('Subject', { exact: true }).fill('Final subject')
    const emailBody = win.frameLocator('iframe[title="Email body"]').locator('body')
    await emailBody.fill('Reviewed body and final Z')
    const final = toolPayload(await client.call('clave_side_panel', { action: 'read' }))
    t.equal(
      'rich email body hands off exact last edit',
      final.email.bodyHtml,
      await emailBody.innerHTML()
    )
    t.equal('subject saved', final.email.subject, 'Final subject')
    t.check(
      'signature data image persists after original removed',
      final.email.signatureHtml.includes('data:image/png;base64,')
    )
    const signaturePreview = win.frameLocator('iframe[title="Signature preview"]')
    await signaturePreview.getByText('Example team').waitFor()
    t.check(
      'signature text and image actually render in iframe',
      await signaturePreview.locator('img').evaluate((img) => img.complete && img.naturalWidth > 0)
    )
    if (process.env.CLAVE_LINKED_CAPTURE)
      await win.screenshot({ path: fixturePath('linked-email.png') })
    const prepared = await client.call('clave_side_panel', {
      action: 'prepare',
      revision: final.revision
    })
    t.check('MCP prepares saved email revision', !toolErrored(prepared), prepared)
    const pkgInfo = toolPayload(prepared),
      pkg = JSON.parse(
        readFileSync(`${DIR}/linked-documents/${pkgInfo.packageId}.package.json`, 'utf8')
      )
    const mime = Buffer.from(pkg.raw, 'base64url').toString()
    t.check(
      'immutable package contains reviewed body and copied attachment',
      mime.includes('Reviewed body and final Z') &&
        mime.includes(Buffer.from('SYNTHETIC ATTACHMENT BYTES').toString('base64')),
      mime.slice(0, 200)
    )
    t.check(
      'signature image compiled into CID MIME part',
      mime.includes('Content-ID:') && mime.includes('cid:')
    )
    // Replace only this isolated Electron instance's fetch: no external email request is possible.
    await app.evaluate(() => {
      globalThis.__linkedSent = []
      globalThis.fetch = async (url, opts) => {
        if (String(url).includes('oauth2.googleapis.com'))
          return Response.json({ access_token: 'fake' })
        if (String(url).includes('gmail.googleapis.com')) {
          globalThis.__linkedSent.push(JSON.parse(opts.body))
          return Response.json({ id: 'synthetic-sent-id' })
        }
        throw Error('Unexpected network request')
      }
      process.env.GMAIL_CLIENT_ID = 'fake'
      process.env.GMAIL_CLIENT_SECRET = 'fake'
      process.env.GMAIL_REFRESH_TOKEN = 'fake'
    })
    t.check(
      'send requires explicit user confirmation',
      toolErrored(await client.call('clave_side_panel', { action: 'send', packageId: pkg.id }))
    )
    const sent = await client.call('clave_side_panel', {
      action: 'send',
      packageId: pkg.id,
      userConfirmed: true
    })
    t.check(
      'actual MCP and Gmail adapter persist fake transport success',
      !toolErrored(sent) && toolPayload(sent).delivery.status === 'sent',
      sent
    )
    const submitted = await app.evaluate(() => globalThis.__linkedSent)
    t.equal('Gmail raw transport receives exact frozen package bytes', submitted[0].raw, pkg.raw)
    t.check(
      'duplicate send is refused',
      toolErrored(
        await client.call('clave_side_panel', {
          action: 'send',
          packageId: pkg.id,
          userConfirmed: true
        })
      )
    )
    await win.getByLabel('Subject', { exact: true }).fill('Unsent revision after delivery')
    await client.call('clave_side_panel', { action: 'read' })
    t.check(
      'UI distinguishes current unsent edits from earlier sent revision',
      (await win.getByText(/current edits are unsent/).count()) > 0
    )
    await win.getByRole('button', { name: 'Hide linked document' }).click()
    await until(() => win.getByRole('button', { name: 'Open linked document' }).count())
    await win.getByRole('button', { name: 'Open linked document' }).click()
    await win.getByLabel('Subject', { exact: true }).waitFor()
    // Restart against the SAME isolated profile; durable document survives renderer/main teardown.
    await client.call('clave_side_panel', { action: 'read' })
    await app.close()
    ;({ app, win } = await launchApp(DIR, { settleMs: 8000 }))
    if (await win.getByRole('button', { name: 'Restore', exact: true }).count())
      await win.getByRole('button', { name: 'Restore', exact: true }).click()
    await until(async () =>
      (await callMcp(app, 'list', {})).sessions.some((s) => s.id === agent.sessionId)
    )
    const restored = JSON.parse(readFileSync(`${DIR}/linked-documents/${emailDoc.id}.json`, 'utf8'))
    t.equal(
      'restart preserves exact edited subject',
      restored.email.subject,
      'Unsent revision after delivery'
    )
    t.equal(
      'default file pointer survives restart',
      (await win.evaluate(() => window.electronAPI.linkedDocuments.getDefaultSignature())).path,
      `${ROOT}/signature.html`
    )
    t.equal(
      'restart preserves signature snapshot despite deleted default source',
      restored.email.signatureHtml,
      final.email.signatureHtml
    )
    t.equal('restart preserves delivery revision', restored.delivery.status, 'sent')
    await callMcp(app, 'focus', { sessionId: agent.sessionId })
    await win.getByLabel('Subject', { exact: true }).waitFor()
    t.equal(
      'restart restores paired composer in real UI',
      await win.getByLabel('Subject', { exact: true }).inputValue(),
      'Unsent revision after delivery'
    )
  } finally {
    await app.close()
    // Exact names from this fixture's own profile only; never terminate unrelated test/user sessions.
    for (const file of readdirSync(`${DIR}/session-records`)) {
      const record = JSON.parse(readFileSync(`${DIR}/session-records/${file}`, 'utf8'))
      if (record.cwd === ROOT && record.tmuxName) {
        try {
          execFileSync('tmux', ['-L', 'clave', 'kill-session', '-t', `=${record.tmuxName}`], {
            stdio: 'ignore'
          })
        } catch {
          /* The session may already have exited. */
        }
      }
    }
  }
}
