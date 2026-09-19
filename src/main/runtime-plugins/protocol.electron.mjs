// Focused real-Chromium security check, independent of provider/model services.
// Run: node src/main/runtime-plugins/protocol.electron.mjs
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { _electron } from 'playwright-core'
import electronPath from 'electron'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const directory = await mkdtemp(path.join(root, '.plugin-protocol-test-'))
const requests = []
const server = createServer((request, response) => {
  requests.push(request.url)
  response.end('<p>escaped</p>')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
const documents = {
  ['a'.repeat(64)]: `<script>
    window.clave.ready.then(async context => {
      const result = await window.clave.request('conversation.read');
      parent.postMessage({type:'test:ready',result,entry:context.entry,
        node:typeof require,preload:typeof electronAPI,process:typeof process}, '*');
    });
    fetch('${origin}/fetch').catch(()=>{});
  </script><img src="${origin}/image"><script src="${origin}/script"></script>
  <iframe src="${origin}/nested"></iframe>`,
  ['b'.repeat(64)]: `<meta http-equiv="refresh" content="0;url=${origin}/meta">
    <script>parent.postMessage({type:'test:attack',name:'meta'},'*')</script>`,
  ['c'.repeat(64)]: `<script>window.name='unrelated-preview';
    parent.postMessage({type:'test:attack',name:'location'},'*');
    location.href='${origin}/navigation';</script>`,
  ['d'.repeat(64)]: `<script>parent.postMessage({type:'test:attack',name:'top'},'*');
    top.location.href='${origin}/top';</script>`,
  ['e'.repeat(64)]: '<p>Unrelated preview remains usable</p>'
}
let app
try {
  const main = path.join(directory, 'main.cjs')
  await build({
    stdin: {
      contents: `
        import { app, BrowserWindow, protocol, session } from 'electron';
        import { PLUGIN_SCHEME, installPluginProtocol, attachPluginFramePolicy }
          from './src/main/runtime-plugins/protocol';
        protocol.registerSchemesAsPrivileged([PLUGIN_SCHEME]);
        app.setPath('userData', ${JSON.stringify(path.join(directory, 'profile'))});
        if (process.platform === 'darwin') app.setActivationPolicy('accessory');
        app.whenReady().then(async () => {
          const documents = ${JSON.stringify(documents)};
          installPluginProtocol(session.defaultSession.protocol, {html:id => documents[id]});
          const win = new BrowserWindow({show:false,webPreferences:{
            sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false
          }});
          attachPluginFramePolicy(win.webContents);
          await win.loadURL('data:text/html,<html><body>host</body></html>');
        });
      `,
      resolveDir: root,
      loader: 'ts'
    },
    outfile: main,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron']
  })
  app = await _electron.launch({ executablePath: electronPath, args: [main, '--test-no-activate'] })
  const page = await app.firstWindow()
  await page.evaluate(() => {
    window.results = []
    window.rpc = []
    window.attacks = []
    addEventListener('message', (event) => {
      if (event.data?.type === 'test:ready')
        window.results.push({ ...event.data, origin: event.origin })
      if (event.data?.type === 'test:attack') window.attacks.push(event.data.name)
    })
    window.openTestFrame = (id) => {
      const iframe = document.createElement('iframe')
      iframe.sandbox = 'allow-scripts'
      iframe.onload = () => {
        const channel = new MessageChannel()
        channel.port1.onmessage = ({ data }) => {
          window.rpc.push(data)
          channel.port1.postMessage({ type: 'clave:response', id: data.id, result: 'bound-result' })
        }
        iframe.contentWindow.postMessage(
          {
            type: 'clave:init',
            apiVersion: 1,
            entry: { id: 'bound-entry' },
            capabilities: []
          },
          '*',
          [channel.port2]
        )
      }
      iframe.src = `clave-plugin://view/${id}`
      document.body.append(iframe)
    }
    window.openTestFrame('a'.repeat(64))
  })
  await page.waitForFunction(() => window.results.length === 1)
  const result = await page.evaluate(() => ({ result: window.results[0], rpc: window.rpc[0] }))
  assert.equal(result.result.result, 'bound-result')
  assert.equal(result.result.entry.id, 'bound-entry')
  assert.equal(result.result.node, 'undefined')
  assert.equal(result.result.process, 'undefined')
  assert.equal(result.result.preload, 'undefined')
  assert.equal(result.result.origin, 'null')
  assert.equal(result.rpc.type, 'clave:request')
  assert.equal(result.rpc.method, 'conversation.read')
  await page.evaluate(() => {
    for (const letter of ['b', 'c', 'd']) window.openTestFrame(letter.repeat(64))
  })
  await page.waitForFunction(() => window.attacks.length === 3)
  await page.waitForTimeout(750)
  assert.deepEqual(requests, [], 'A plugin frame reached the network or navigated outside its CSP')
  assert.ok(page.url().startsWith('data:text/html,'), 'Plugin changed the host document')
  // Programmatic host navigation of an unrelated frame must remain unaffected.
  await page.evaluate(() => {
    const iframe = document.createElement('iframe')
    iframe.id = 'unrelated'
    iframe.srcdoc = '<p>ordinary preview</p>'
    document.body.append(iframe)
  })
  await page.waitForFunction(
    () =>
      document.querySelector('#unrelated').contentDocument?.body?.textContent === 'ordinary preview'
  )
  await page.evaluate((origin) => {
    document.querySelector('#unrelated').removeAttribute('srcdoc')
    document.querySelector('#unrelated').src = `${origin}/ordinary-preview`
  }, origin)
  await page.waitForTimeout(250)
  assert.deepEqual(requests, ['/ordinary-preview'])
  assert.equal(
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
    false
  )
  console.log(
    'Plugin protocol: bootstrap, opaque sandbox, CSP resource denial and navigation policy passed'
  )
} finally {
  if (app) await app.close()
  await new Promise((resolve) => server.close(resolve))
  await rm(directory, { recursive: true, force: true })
}
