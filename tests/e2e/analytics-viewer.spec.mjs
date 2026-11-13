// The pages of the bundled Analytics plugin as Slideless decks on this Mac: each opened page
// written as a deck folder under the plugin's data folder and served by the Slideless CLI's
// own local viewer (`slideless dev`), the page Clave shows being the viewer's copy. Nothing
// here reaches Slideless or needs the real CLI: the `slideless` first on the PATH is a stub
// whose `dev` subcommand is a small static server in node with the real viewer's shape (the
// sandbox header, a reload snippet, a watch on the root), recording the arguments it got. The
// checks are on the arguments (an argument list, never a shell string), on the deck folder and
// its three files, on the page pane showing the viewer's URL with the deck's title and its
// footer line, on a settings change reaching the deck on disk and the page in place, on a
// range chip leading through the plugin's open route under the sandbox, and on the fallback:
// the plugin switched off and on again with a stub whose `dev` refuses, the pane shows the
// page Clave serves itself with the one line saying why. The plugin runs in its own process
// with the path the host hands it, so the stub reaches it the way a dev app's or a packaged
// app's CLI does. A CLI absent from the path altogether cannot be staged here: the plugin
// reads the login shell's path too, and this Mac's may carry the real one; `viewer.test.ts`
// pins that case with a fake spawn.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fixturePath, until } from './harness.mjs'
import { openChat } from './chat-view.spec.mjs'
import { PAGE, PLUGIN, inGuest, menuItem, menuItems, rowButton } from './analytics-actions.spec.mjs'

const BIN = fixturePath('analytics-viewer-bin')
const CALLS = `${BIN}/slideless-calls.jsonl`
const REFUSE = `${BIN}/slideless-refuse`
const VIEWER_NOTE = 'Served by the Slideless viewer on this Mac'
const REFUSED_NOTE =
  'The Slideless viewer could not start (dev refused by the stub); this page is served by Clave itself'

function writeStub() {
  rmSync(BIN, { recursive: true, force: true })
  mkdirSync(BIN, { recursive: true })
  writeFileSync(
    `${BIN}/slideless`,
    `#!${process.execPath}
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify({ args }) + '\\n');
if (args[0] !== 'dev') { process.stderr.write('unknown command\\n'); process.exit(2); }
if (fs.existsSync(${JSON.stringify(REFUSE)})) {
  process.stderr.write('dev refused by the stub\\n');
  process.exit(3);
}
// The real viewer's shape: every file under the root, no dotfiles, the sandbox header on
// every answer, a reload snippet in every page, a reload broadcast on any change under the
// root, and one JSON line with the URL once it listens.
const root = path.resolve(args[1]);
const port = Number(args[args.indexOf('--port') + 1] || 0);
const HEADERS = {
  'content-security-policy': 'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store'
};
const SNIPPET = '<script>(() => { const connect = () => { const es = new EventSource("/__slideless/reload"); es.addEventListener("reload", () => location.reload()); es.onerror = () => { es.close(); setTimeout(connect, 1000); }; }; connect(); })();</script>';
const clients = new Set();
const types = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.md': 'text/markdown; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };
const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (pathname === '/__slideless/reload') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(': connected\\n\\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\\/+/, '');
  if (rel.split('/').some((s) => s.startsWith('.'))) { res.writeHead(404, HEADERS).end('Not found'); return; }
  const target = path.resolve(root, rel);
  if (!target.startsWith(root + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
    res.writeHead(404, HEADERS).end('Not found');
    return;
  }
  const type = types[path.extname(target)] || 'application/octet-stream';
  let body = fs.readFileSync(target);
  if (type.startsWith('text/html')) {
    const html = body.toString('utf8');
    const at = html.lastIndexOf('</body>');
    body = Buffer.from(at === -1 ? html + SNIPPET : html.slice(0, at) + SNIPPET + html.slice(at));
  }
  res.writeHead(200, { ...HEADERS, 'content-type': type }).end(body);
});
let debounce = null;
try {
  fs.watch(root, { recursive: true }, () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => { for (const c of clients) c.write('event: reload\\ndata: now\\n\\n'); }, 100);
  });
} catch {}
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(JSON.stringify({ url: 'http://127.0.0.1:' + server.address().port + '/', entry: 'index.html' }) + '\\n');
});
const stop = () => { server.close(); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
`,
    { mode: 0o755 }
  )
}

const calls = () =>
  existsSync(CALLS)
    ? readFileSync(CALLS, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line).args)
    : []

/** The guest's own URL, once it answers. */
const guestUrl = (win) => until(() => inGuest(win, 'location.href'))
const footNote = (win) =>
  until(() => inGuest(win, `document.querySelector('.foot-note')?.textContent ?? null`))
const footText = (win, part) =>
  until(async () => {
    const text = await inGuest(win, `document.querySelector('.foot-text')?.textContent ?? ''`)
    return typeof text === 'string' && text.includes(part) ? text : null
  })

export async function run(t) {
  writeStub()
  const chat = await openChat('analytics-viewer', [], undefined, {
    PATH: `${BIN}:${process.env.PATH}`
  })
  const { win, record } = chat
  try {
    const plugin = await until(async () => {
      const p = (await win.evaluate(() => window.electronAPI.pluginsList())).find(
        (p) => p.id === PLUGIN
      )
      return p?.status === 'active' && p.actions.includes('deck') ? p : null
    })
    assert.ok(plugin, 'the plugin runs')

    // 1. The viewer: the CLI's dev server over the plugin's decks root, as an argument list,
    // any port the first time.
    const dev = await until(() => calls().find((args) => args[0] === 'dev') ?? null)
    assert.ok(dev, JSON.stringify(calls()))
    const root = dev[1]
    const dataDir = path.resolve(root, '..')
    t.check(
      'the plugin runs the viewer over its decks root, as an argument list, any port, no browser, JSON out',
      dev.length === 6 &&
        root.includes(path.join('clave-plugins', 'data', PLUGIN, 'decks')) &&
        dev.slice(2).join(' ') === '--port 0 --no-open --json',
      JSON.stringify(dev)
    )
    const rootIndex = await until(() =>
      existsSync(path.join(root, 'index.html')) ? path.join(root, 'index.html') : null
    )
    t.check("the decks root carries its own index.html, the viewer's entry", !!rootIndex)
    const info = await until(() => {
      try {
        const saved = JSON.parse(readFileSync(path.join(dataDir, 'server.json'), 'utf8'))
        return saved.viewerPort ? saved : null
      } catch {
        return null
      }
    })
    t.check(
      'the port the viewer took is kept in server.json beside the plugin port and token',
      !!info && Number.isInteger(info.viewerPort) && info.viewerPort > 0,
      JSON.stringify(info)
    )
    const viewerOrigin = `http://127.0.0.1:${info.viewerPort}`
    const pluginBase = `http://127.0.0.1:${info.port}/${info.token}/`

    // 2. The tab's page: the action leads through the open route, the pane lands on the
    // viewer's copy of the deck, drawn with the tab's name, its footer naming the viewer.
    await rowButton(win, record.id).click({ button: 'right' })
    await menuItems(win).first().waitFor()
    await menuItem(win, 'Analytics').click()
    await win.locator(PAGE).waitFor({ timeout: 10_000 })
    const src = await win.locator(`${PAGE} webview`).getAttribute('src')
    t.check(
      'the action opens the plugin open route for the session',
      !!src && src.startsWith(pluginBase) && src.includes(`/open/session/${record.id}`),
      String(src)
    )
    const landed = await until(async () => {
      const href = await guestUrl(win)
      return typeof href === 'string' && href.startsWith(viewerOrigin) ? href : null
    })
    const folderName = `session-${record.id}`
    t.check(
      "the pane shows the viewer's copy of the session deck",
      landed === `${viewerOrigin}/${encodeURIComponent(folderName)}/index.html`,
      String(landed)
    )
    const title = await until(async () => {
      const text = await inGuest(win, `document.querySelector('.deck-title')?.textContent ?? ''`)
      return text === record.title ? text : null
    })
    t.check('the deck draws the session by its name', !!title, String(title))
    t.equal('the deck page says it is served by the viewer', await footNote(win), VIEWER_NOTE)
    t.check(
      "the deck's links lead through the plugin server, the gear to its settings page",
      (await inGuest(win, `document.querySelector('.gear')?.getAttribute('href')`)) ===
        `${pluginBase}settings`
    )

    // 3. The folder: three files, the data a session view, the page self-contained with the
    // plugin's stream and root named absolute.
    const folder = path.join(root, folderName)
    t.check(
      'the deck folder holds index.html, data.json and AGENT.md',
      ['index.html', 'data.json', 'AGENT.md'].every((f) => existsSync(path.join(folder, f))),
      folder
    )
    const data = JSON.parse(readFileSync(path.join(folder, 'data.json'), 'utf8'))
    const html = readFileSync(path.join(folder, 'index.html'), 'utf8')
    t.check(
      'the deck is the session page, self-contained, its stream and its root the plugin server',
      data.kind === 'session' &&
        data.name === record.title &&
        !html.includes('<link rel="stylesheet"') &&
        !html.includes('<script src=') &&
        html.includes('<meta name="analytics-mode" content="deck" />') &&
        html.includes(`<meta name="analytics-base" content="${pluginBase}" />`) &&
        html.includes(`<meta name="analytics-events" content="${pluginBase}events?scope=`),
      JSON.stringify({ kind: data.kind, name: data.name })
    )
    t.check(
      'AGENT.md says what the deck is and that Clave never pushes it',
      readFileSync(path.join(folder, 'AGENT.md'), 'utf8').includes('Clave never pushes anything')
    )

    // 4. A settings change: the gap saved through the plugin reaches the deck on disk and the
    // page in place, through the plugin's stream, with no reload of the pane's document.
    await inGuest(win, `window.__sameDocument = true; true`)
    const saved = await fetch(`${pluginBase}settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gapMinutes: 23 })
    })
    t.equal('the gap saves through the plugin', saved.status, 200)
    const footer = await footText(win, 'less than 23 minutes apart')
    t.check('the deck page counts with the new gap, live', !!footer, String(footer))
    const rewritten = await until(() => {
      try {
        const now = JSON.parse(readFileSync(path.join(folder, 'data.json'), 'utf8'))
        return now.footer.gapMinutes === 23 ? now : null
      } catch {
        return null
      }
    })
    t.check('the deck on disk is rewritten with the new gap', !!rewritten)
    t.check(
      'the pane kept its document: the page followed the stream, it did not reload',
      (await inGuest(win, `window.__sameDocument === true`)) === true
    )

    // 5. The workspace page from the toolbar, and a range chip clicked inside the sandboxed
    // deck: the page navigates itself through the open route to the deck of the other range.
    await win.locator('[data-plugin-action="home"]').click()
    const wsLanded = await until(async () => {
      const href = await guestUrl(win)
      return typeof href === 'string' &&
        href.includes('/workspace-') &&
        href.endsWith('-today/index.html')
        ? href
        : null
    })
    t.check(
      "the workspace page is the viewer's copy of the today deck",
      !!wsLanded,
      String(wsLanded)
    )
    await until(() =>
      inGuest(
        win,
        `(() => { const a = [...document.querySelectorAll('.ranges a.chip')].find((c) => c.textContent === '7 days'); if (!a) return null; a.click(); return true })()`
      )
    )
    const sevenDays = await until(async () => {
      const href = await guestUrl(win)
      return typeof href === 'string' && href.endsWith('-7d/index.html') ? href : null
    })
    t.check(
      'a range chip leads through the open route to the deck of that range, under the sandbox',
      !!sevenDays && sevenDays.startsWith(viewerOrigin),
      String(sevenDays)
    )
    const sevenDaysFolder = decodeURIComponent(new URL(sevenDays).pathname.split('/')[1])
    t.check(
      'the two workspace decks are on disk',
      existsSync(path.join(root, sevenDaysFolder, 'data.json')) &&
        existsSync(
          path.join(root, decodeURIComponent(new URL(wsLanded).pathname.split('/')[1]), 'data.json')
        ),
      sevenDaysFolder
    )

    // 6. The fallback: the plugin stopped (its viewer with it) and started again with a stub
    // whose dev refuses; the pane shows the page Clave serves itself, with the line saying why.
    writeFileSync(REFUSE, '')
    await win.evaluate((id) => window.electronAPI.pluginsDisable(id), PLUGIN)
    await win.locator(PAGE).waitFor({ state: 'detached', timeout: 10_000 })
    const before = calls().length
    await win.evaluate(
      ([id, permissions]) => window.electronAPI.pluginsEnable(id, permissions),
      [PLUGIN, plugin.manifest?.permissions ?? []]
    )
    await until(async () => {
      const p = (await win.evaluate(() => window.electronAPI.pluginsList())).find(
        (p) => p.id === PLUGIN
      )
      return p?.status === 'active' && p.actions.includes('deck') ? p : null
    })
    const refused = await until(() => (calls().length > before ? calls().slice(before) : null))
    t.check(
      'the restarted plugin asks the viewer for its saved port',
      !!refused && refused[0][0] === 'dev' && refused[0][3] === String(info.viewerPort),
      JSON.stringify(refused)
    )
    await rowButton(win, record.id).click({ button: 'right' })
    await menuItems(win).first().waitFor()
    await menuItem(win, 'Analytics').click()
    await win.locator(PAGE).waitFor({ timeout: 10_000 })
    const fallback = await until(async () => {
      const href = await guestUrl(win)
      return typeof href === 'string' &&
        href.startsWith(pluginBase) &&
        href.includes(`/session/${record.id}`)
        ? href
        : null
    })
    t.check(
      'without a viewer the pane shows the page Clave serves itself',
      !!fallback && !fallback.includes('/open/'),
      String(fallback)
    )
    t.equal('and its footer says why, in one line', await footNote(win), REFUSED_NOTE)
    t.check(
      'the fallback page still counts with the saved gap',
      !!(await footText(win, 'less than 23 minutes apart'))
    )
  } finally {
    await chat.close()
  }
}

assert.ok(run)
