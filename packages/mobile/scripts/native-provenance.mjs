#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- Node verification driver */
// Compare what Hermes loaded with this Metro's bundle and original source map.
// No app instrumentation, credentials, or trust in merely starting a port.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { WebSocket } from 'ws'

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const option = (name) => {
  const index = process.argv.indexOf(`--${name}`)
  return index < 0 ? undefined : process.argv[index + 1]
}
const sha = (s) => createHash('sha256').update(s).digest('hex')
// Only transport metadata comments differ between Hermes bytecode and JS requests.
const normalize = (s) => s.replace(/^\/\/[#@] source(?:Mapping)?URL=.*$/gm, '').trimEnd()

export async function proveNativeSource({ port, deviceName, output, bundleHost = '127.0.0.1' }) {
  execFileSync('git', ['diff', 'HEAD', '--exit-code', '--quiet'], { cwd: pkg, stdio: 'pipe' })
  const origin = `http://127.0.0.1:${port}`
  const targets = await (await fetch(`${origin}/json/list`)).json()
  const own = targets.filter(
    (t) => t.appId === 'com.clave.app.mobile' && (!deviceName || t.deviceName === deviceName)
  )
  assert.equal(
    own.length,
    1,
    'Exactly one owned native app must be connected to the requested Metro'
  )
  const ws = new WebSocket(own[0].webSocketDebuggerUrl, { origin })
  const pending = new Map()
  const scripts = []
  let id = 0
  const timer = setTimeout(() => ws.terminate(), 30000)
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const request = ++id
      pending.set(request, { resolve, reject })
      ws.send(JSON.stringify({ id: request, method, params }))
    })
  ws.on('message', (data) => {
    const m = JSON.parse(String(data))
    if (m.method === 'Debugger.scriptParsed') scripts.push(m.params)
    const request = pending.get(m.id)
    if (request) {
      pending.delete(m.id)
      if (m.error) request.reject(new Error('Inspector refused source inspection'))
      else request.resolve(m.result)
    }
  })
  ws.on('close', () => {
    for (const request of pending.values())
      request.reject(new Error('Inspector closed before source proof'))
    pending.clear()
  })
  try {
    await new Promise((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    await call('Debugger.enable')
    const bundle = scripts.find((s) => s.url.includes('/packages/mobile/index.bundle'))
    assert.ok(bundle, 'Hermes must name the mobile entry bundle')
    assert.ok(
      ['127.0.0.1', '10.0.2.2'].includes(bundleHost),
      'Only loopback or the standard owned Android emulator host is supported'
    )
    assert.equal(
      new URL(bundle.url).hostname,
      bundleHost,
      'Loaded bundle must use the explicit device host'
    )
    assert.equal(
      new URL(bundle.url).port,
      String(port),
      'Loaded bundle must use the owned Metro port'
    )
    const { scriptSource } = await call('Debugger.getScriptSource', { scriptId: bundle.scriptId })
    assert.ok(
      scriptSource.includes(JSON.stringify(pkg)),
      'Loaded bundle must name this exact worktree'
    )
    const servedUrl = new URL(bundle.sourceMapURL)
    servedUrl.hostname = '127.0.0.1'
    servedUrl.pathname = servedUrl.pathname.replace(/\.map$/, '.bundle')
    servedUrl.searchParams.set('transform.bytecode', '0')
    const served = await (await fetch(servedUrl)).text()
    assert.equal(
      sha(normalize(scriptSource)),
      sha(normalize(served)),
      'Loaded Hermes source differs from the current Metro bundle'
    )
    const mapUrl = new URL(bundle.sourceMapURL)
    mapUrl.hostname = '127.0.0.1'
    mapUrl.searchParams.set('excludeSource', 'false')
    const map = await (await fetch(mapUrl)).json()
    const checked = []
    const check = (m) => {
      for (const section of m.sections ?? []) check(section.map)
      for (let i = 0; i < (m.sources ?? []).length; i++) {
        const source = m.sources[i]
        // Metro's source URLs may be absolute paths or /[metro-project]/src/... .
        const relative = source.match(/(?:^|\/)src\/(.+\.[tj]sx?)$/)?.[1]
        if (!relative || source.includes('/node_modules/')) continue
        const file = path.join(pkg, 'src', relative)
        let disk
        try {
          disk = readFileSync(file, 'utf8')
        } catch {
          continue
        }
        assert.equal(m.sourcesContent?.[i], disk, `Source map differs from disk: src/${relative}`)
        checked.push(`src/${relative}`)
      }
    }
    check(map)
    assert.ok(checked.includes('src/App.tsx'), 'Source map must include this App.tsx')
    const candidate = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: pkg,
      encoding: 'utf8'
    }).trim()
    execFileSync('git', ['diff', 'HEAD', '--exit-code', '--quiet'], { cwd: pkg, stdio: 'pipe' })
    const proof = {
      candidate,
      worktree: pkg,
      deviceName: own[0].deviceName,
      port,
      bundleHost,
      bundleSha256: sha(normalize(scriptSource)),
      checked
    }
    if (output) writeFileSync(output, `${JSON.stringify(proof, null, 2)}\n`)
    return proof
  } finally {
    clearTimeout(timer)
    ws.close()
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(option('port') || '8081')
  proveNativeSource({
    port,
    deviceName: option('device-name'),
    output: option('output'),
    bundleHost: option('bundle-host') ?? '127.0.0.1'
  })
    .then((proof) =>
      console.log(
        `Native source verified: ${proof.candidate}, Metro ${proof.port}, ${proof.checked.length} source files`
      )
    )
    .catch((error) => {
      console.error(error.message)
      process.exitCode = 1
    })
}
