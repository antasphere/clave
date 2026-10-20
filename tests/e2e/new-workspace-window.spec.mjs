// A workspace registered after boot must be usable by the shell even when
// the standalone server owns the registry. Run in every harness server mode.
import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import {
  launchApp,
  seedWorkspaces,
  userDataDir,
  fixturePath,
  stubFolderDialog,
  until,
  identityOf,
  openWindow,
  persistedWindows,
  serverMode,
  mcpHttpClient,
  toolPayload,
  toolErrored,
  REPO
} from './harness.mjs'

const DIR = userDataDir('new-workspace-window')
const ROOT = fixturePath('existing-workspace')
const EXISTING = {
  id: 'existing-workspace',
  name: 'Existing workspace',
  rootDir: ROOT,
  profileFile: null,
  createdAt: 1
}

export async function run(t) {
  mkdirSync(ROOT, { recursive: true })
  seedWorkspaces(DIR, { workspaces: [EXISTING], activeWorkspaceId: EXISTING.id, fresh: true })
  let { app, win } = await launchApp(DIR)
  try {
    // Fixture creation goes through the real Add workspace action; only the
    // native folder dialog is replaced. Every invocation gets its own root.
    const modulePath = fixturePath('new-workspace-fixture.mjs')
    await build({
      entryPoints: [path.join(REPO, 'tests/e2e/fixtures/new-workspace.mjs')],
      outfile: modulePath,
      bundle: true,
      platform: 'node',
      format: 'esm',
      banner: {
        js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"
      }
    })
    const { loadNewWorkspace } = await import(pathToFileURL(modulePath).href)
    const receipt = await loadNewWorkspace(
      async (runId) => {
        const root = fixturePath(`pilotage.vaillante-${runId}`)
        mkdirSync(root, { recursive: true })
        await stubFolderDialog(app, { returns: root })
        await win.getByRole('button', { name: 'Switch workspace', exact: true }).click()
        await win.getByRole('button', { name: 'Add workspace…', exact: true }).click()
        const workspace = await until(async () => {
          const state = await win.evaluate(() => window.electronAPI.workspaceLoad())
          return state.workspaces.find((ws) => ws.rootDir === root) ?? null
        })
        if (!workspace) throw new Error('Add workspace did not register the selected folder')
        return workspace
      },
      async (workspace) => {
        const state = await win.evaluate(() => window.electronAPI.workspaceLoad())
        if (!state.workspaces.some((ws) => ws.id === workspace.id)) {
          throw new Error('The new workspace is not queryable')
        }
      }
    )
    const workspace = receipt.values.workspace
    console.log(`fixture workspaces/new-window, run ${receipt.runId}, workspace ${workspace.id}`)
    if (serverMode() !== 'in-process') {
      const shell = JSON.parse(readFileSync(path.join(DIR, 'workspace-state.json'), 'utf8'))
      t.check(
        'the new workspace exists only on the server, not in the shell registry',
        !shell.workspaces.some((ws) => ws.id === workspace.id)
      )
    }

    await win.getByRole('button', { name: 'Switch workspace', exact: true }).click()
    await win.getByRole('button').filter({ hasText: workspace.name }).click()
    await until(
      async () => ((await identityOf(win))?.workspaceId === workspace.id ? true : null),
      3000
    )
    const identity = await identityOf(win)
    t.equal(
      'selecting the new workspace updates the window identity',
      identity.workspaceId,
      workspace.id
    )
    t.equal(
      'the selected workspace is saved in the window state',
      persistedWindows(DIR).find((w) => w.key === identity.windowKey)?.workspaceId,
      workspace.id
    )
    t.equal(
      'last-active is saved on the authoritative registry',
      (await win.evaluate(() => window.electronAPI.workspaceLoad())).lastActiveWorkspaceId,
      workspace.id
    )

    try {
      const opened = await openWindow(app, win, workspace.id)
      t.equal(
        'a new window opens on the selected workspace',
        (await identityOf(opened.page)).workspaceId,
        workspace.id
      )
      t.equal(
        'opening a window preserves the original window workspace',
        (await identityOf(win)).workspaceId,
        workspace.id
      )
    } catch (error) {
      t.check('a new window opens on the selected workspace', false, String(error))
    }

    const discovery = JSON.parse(readFileSync(path.join(DIR, 'mcp-server.json'), 'utf8'))
    const mcp = mcpHttpClient(discovery.url, discovery.token)
    await mcp.init()
    const rpc = await mcp.call('clave_open_window', { workspace: workspace.name.toUpperCase() })
    const result = toolPayload(rpc)
    t.check('the agent tool resolves the new workspace by name', !toolErrored(rpc), result)
    const toolIdentity = await until(async () => {
      const identities = await Promise.all(
        app.windows().map((page) => identityOf(page).catch(() => null))
      )
      return identities.find((id) => id?.windowId === result?.windowId) ?? null
    })
    t.equal('the agent tool opens the requested workspace', toolIdentity?.workspaceId, workspace.id)

    // The native menu has no renderer workspace argument. Its default must
    // come from the server even when the shell still remembers a removed root.
    await win.evaluate(async (id) => {
      const state = await window.electronAPI.workspaceLoad()
      await window.electronAPI.workspaceUpdateRegistry(
        state.workspaces.filter((ws) => ws.id === id)
      )
      await window.electronAPI.windowSetWorkspace(null)
    }, workspace.id)
    const menuCount = app.windows().length
    await app.evaluate(async ({ Menu }) => {
      const file = Menu.getApplicationMenu().items.find((item) => item.label === 'File')
      const item = file.submenu.items.find((item) => item.label === 'New Window')
      await item.click()
    })
    const menuWindow = await until(
      async () => {
        if (app.windows().length !== menuCount + 1) return null
        return identityOf(app.windows().at(-1)).catch(() => null)
      },
      { tries: 12, gapMs: 250 }
    )
    t.equal(
      'File New Window opens the authoritative default',
      menuWindow?.workspaceId,
      workspace.id
    )
    await win.evaluate((id) => window.electronAPI.windowSetWorkspace(id), workspace.id)

    // Exercise the exported opener itself. IPC has a second validation guard,
    // which otherwise masks a regression in the opener's persistence boundary.
    const directBefore = persistedWindows(DIR)
    const direct = await app.evaluate(async ({ app }) => {
      const { createRequire } = process.getBuiltinModule('module')
      const entry = app.getAppPath() + '/out/main/index.js'
      const { openWindow } = createRequire(entry)(entry)
      return openWindow('unknown-direct-workspace').then(
        () => null,
        (error) => String(error)
      )
    })
    t.check(
      'the opener independently refuses an unknown workspace',
      direct?.includes('No registered workspace'),
      direct
    )
    t.equal(
      'the refused opener does not create or persist a window',
      JSON.stringify(persistedWindows(DIR)),
      JSON.stringify(directBefore)
    )
    t.equal(
      'the refused opener does not overwrite server last-active',
      (await win.evaluate(() => window.electronAPI.workspaceLoad())).lastActiveWorkspaceId,
      workspace.id
    )

    const before = persistedWindows(DIR)
    const rejected = await win.evaluate(() =>
      window.electronAPI.windowSetWorkspace('unknown-workspace')
    )
    t.equal('an unknown workspace cannot be selected', rejected.reason, 'unknown-workspace')
    const openError = await win.evaluate(() =>
      window.electronAPI.windowOpen('unknown-workspace').then(
        () => null,
        (error) => String(error)
      )
    )
    t.check(
      'an unknown workspace cannot open a window',
      openError?.includes('No registered workspace'),
      openError
    )
    t.equal(
      'refused requests leave persisted window state unchanged',
      JSON.stringify(persistedWindows(DIR)),
      JSON.stringify(before)
    )

    await app.close()
    app = null
    const restarted = await launchApp(DIR)
    app = restarted.app
    win = restarted.win
    const restored = await Promise.all(app.windows().map((page) => identityOf(page)))
    t.check(
      'restart restores every window on the new workspace',
      restored.length === before.length && restored.every((id) => id.workspaceId === workspace.id),
      restored
    )
    t.equal(
      'restart preserves the saved window keys',
      JSON.stringify(restored.map((id) => id.windowKey).sort()),
      JSON.stringify(before.map((w) => w.key).sort())
    )
  } finally {
    await app?.close()
  }
}
