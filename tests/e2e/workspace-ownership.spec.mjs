import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import {
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  spawnAgentTabIn,
  mcpHttpClient,
  mcpEndpoint,
  toolPayload,
  toolErrored,
  until,
  userDataDir,
  fixturePath,
  serverDataDirOf
} from './harness.mjs'

export async function run(t) {
  const dir = userDataDir('workspace-ownership')
  const root = fixturePath('workspace-ownership-root')
  const a = {
    id: 'ownership-a',
    name: 'Ownership A',
    rootDir: path.join(root, 'a'),
    profileFile: null,
    createdAt: 1
  }
  const b = { ...a, id: 'ownership-b', name: 'Ownership B', rootDir: path.join(root, 'b') }
  for (const w of [a, b]) mkdirSync(w.rootDir, { recursive: true })
  const file = path.join(root, 'shared.md')
  writeFileSync(file, '# Workspace ownership\n')
  seedWorkspaces(dir, { workspaces: [a, b], activeWorkspaceId: a.id, fresh: true })
  seedTrustedRoots(dir, [root])
  const { app, win } = await launchApp(dir, { args: ['--test-no-machine-usage'] })
  try {
    const agent = await spawnAgentTabIn(app, win, serverDataDirOf(dir))
    if (!agent?.token) throw new Error('No caller token')
    const client = mcpHttpClient(mcpEndpoint(dir), agent.token)
    await client.init()
    const call = async (name, args) => {
      const result = await client.call(name, args)
      if (toolErrored(result)) throw new Error(JSON.stringify(result))
      return toolPayload(result)
    }
    const drawn = (id) => win.locator(`[data-sidebar-item-id="${id}"]`).count()
    const switchTo = async (workspace) => {
      await call('clave_switch_workspace', { workspace })
      await until(
        async () =>
          (await win.evaluate(() => window.electronAPI.windowIdentity())).workspaceId === workspace
      )
    }
    // The existing fixtures framework supplies a unique run and waits for real
    // application writes, rather than inventing sidebar records on disk.
    const modulePath = fixturePath('workspace-ownership-fixture.mjs')
    await build({
      entryPoints: [path.resolve('tests/e2e/fixtures/workspace-ownership.mjs')],
      outfile: modulePath,
      bundle: true,
      platform: 'node',
      format: 'esm',
      banner: {
        js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"
      }
    })
    const { loadWorkspaceOwnership } = await import(pathToFileURL(modulePath).href)
    const receipt = await loadWorkspaceOwnership(
      async (runId) => {
        const first = await call('clave_open_file', { path: file, name: `Report ${runId}` })
        return { ...first, runId }
      },
      async (first) => {
        if (!(await until(async () => await drawn(first.fileTabId))))
          throw new Error('File never drawn in A')
      }
    )
    const first = receipt.values.viewer
    console.log(`fixture workspaces/ownership, run ${receipt.runId}, file ${first.fileTabId}`)
    await switchTo(b.id)
    t.equal('A file is absent from B', await drawn(first.fileTabId), 0)
    const background = await call('clave_open_file', { path: file })
    t.equal('a background caller reopens its own file', background.fileTabId, first.fileTabId)
    t.equal('background open does not leak to visible B', await drawn(first.fileTabId), 0)
    const group = await call('clave_create_group', { name: 'Caller group' })
    t.equal('background group belongs to A', group.workspaceId, a.id)
    const child = await call('clave_open_session', {
      cwd: b.rootDir,
      mode: 'terminal',
      groupId: group.groupId
    })
    const records = await win.evaluate(
      (id) => window.electronAPI.listSessionRecords({ ids: [id] }),
      child.sessionId
    )
    t.equal('child inherits group workspace even with a cwd in B', records[0]?.workspaceId, a.id)
    // Remove only the saved stamp through the app API to exercise legacy
    // records. Its own cwd still identifies A while the window shows B.
    await win.evaluate((id) => window.electronAPI.setSessionWorkspace(id, null), agent.sessionId)
    const legacy = await call('clave_create_group', { name: 'Legacy caller group' })
    t.equal('legacy caller group is inferred from caller cwd', legacy.workspaceId, a.id)
    const legacyChild = await call('clave_open_session', { cwd: b.rootDir, mode: 'terminal' })
    const legacyRecords = await win.evaluate(
      (id) => window.electronAPI.listSessionRecords({ ids: [id] }),
      legacyChild.sessionId
    )
    t.equal(
      'legacy caller session is inferred from caller cwd',
      legacyRecords[0]?.workspaceId,
      a.id
    )
    const conflict = await client.call('clave_open_session', {
      cwd: b.rootDir,
      mode: 'terminal',
      groupId: group.groupId,
      workspace: b.id
    })
    t.check('conflicting group/workspace is refused', toolErrored(conflict))
    // A second caller in B may open the same file independently.
    const agentB = await spawnAgentTabIn(app, win, serverDataDirOf(dir))
    const clientB = mcpHttpClient(mcpEndpoint(dir), agentB.token)
    await clientB.init()
    const second = toolPayload(
      await clientB.call('clave_open_file', { path: file, name: 'B report' })
    )
    t.check(
      'same path in B gets its own viewer',
      !!second?.fileTabId && second.fileTabId !== first.fileTabId
    )
    await switchTo(a.id)
    t.equal('A viewer returns in A', await drawn(first.fileTabId), 1)
    t.equal('B viewer stays out of A', await drawn(second.fileTabId), 0)
    t.check('caller group is drawn in A', !!(await until(async () => await drawn(group.groupId))))
  } finally {
    await app.close()
  }
}
