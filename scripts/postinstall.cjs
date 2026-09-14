/* eslint-disable @typescript-eslint/no-require-imports -- npm lifecycle script, plain CommonJS. */
// Runs after `npm install`, on every platform, without a shell.
//
// On macOS and Linux, `electron-builder install-app-deps` rebuilds the native
// modules against Electron's headers, then node-pty's spawn-helper prebuilds get
// their +x bit back (npm drops it).
//
// On Windows, no rebuild: node-pty ships N-API prebuilds for win32-x64 and
// win32-arm64 (prebuilds/win32-<arch>/pty.node, conpty.node, winpty), which
// Electron loads as they are. @electron/rebuild does not recognise them — it only
// looks for `node.napi.node` / `electron.napi.node` — so install-app-deps falls
// through to node-gyp, which needs a Visual Studio the GitHub runner does not
// have, and the install dies. That is what killed every Windows build between
// v1.52 and v1.64. Skipping is correct here, not a workaround: the prebuilds are
// node-pty's supported path since 1.1.0.
const { execFileSync } = require('node:child_process')
const { chmodSync, readdirSync, existsSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')

if (process.platform === 'win32') {
  console.log('postinstall: Windows — using node-pty prebuilds, no native rebuild')
  process.exit(0)
}

execFileSync('electron-builder', ['install-app-deps'], { cwd: root, stdio: 'inherit' })

const prebuilds = join(root, 'node_modules/node-pty/prebuilds')
if (existsSync(prebuilds)) {
  for (const dir of readdirSync(prebuilds)) {
    if (!dir.startsWith('darwin-')) continue
    const helper = join(prebuilds, dir, 'spawn-helper')
    if (existsSync(helper)) chmodSync(helper, 0o755)
  }
}
