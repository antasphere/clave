import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { launchApp, fixturePath, REPO, seedWorkspaces } from './harness.mjs'
import { frames } from './renderer-workload.mjs'

export async function checkFullLifecycle(t, save) {
  const dir = fixturePath('full-public-lifecycle')
  mkdirSync(dir, { recursive: true })
  seedWorkspaces(path.join(dir, 'data'), {
    workspaces: [{ id: 'full', name: 'Full', rootDir: dir, profileFile: null, createdAt: 1 }],
    activeWorkspaceId: 'full',
    fresh: true
  })
  writeFileSync(
    path.join(dir, 'index.html'),
    '<!doctype html><html><body><div id="root"></div><script src="./fixture.js"></script></body></html>'
  )
  writeFileSync(path.join(dir, 'empty.html'), '<!doctype html><html><body></body></html>')
  await build({
    entryPoints: [path.join(REPO, 'tests/e2e/markdown-full-lifecycle-fixture.mjs')],
    outfile: path.join(dir, 'fixture.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    define: { 'process.env.NODE_ENV': '"development"' },
    jsx: 'automatic'
  })
  const { app, win } = await launchApp(path.join(dir, 'data'), {
    args: ['--test-no-machine-usage'],
    env: { SHELL: '/bin/zsh' }
  })
  try {
    await win.goto(pathToFileURL(path.join(dir, 'index.html')).href)
    await win.waitForFunction(() => !!window.fullLifecycle)
    const snap = async (label) => {
      const s = await win.evaluate(() => window.fullLifecycle.snapshot())
      save(label, s)
      return s
    }
    const invoke = async (method, ...args) =>
      win.evaluate(({ method, args }) => window.fullLifecycle[method](...args), { method, args })
    for (let cycle = 0; cycle < 3; cycle++) {
      await invoke('start')
      await invoke('append', ' pending')
      let s = await snap('pending-' + cycle)
      assert.ok(s.timers > 0, 'actual unfinished append creates a pending real schedule')
      await invoke('visibility', false)
      s = await snap('hidden-cancel-' + cycle)
      assert.equal(s.timers, 0, 'hide actually clears owned schedule timer')
      assert.equal(s.html[0], '<p>Earlier</p>\n<p>Mutable</p>')
      await invoke('append', ' hidden-latest')
      await invoke('visibility', true)
      await frames(win)
      s = await snap('reveal-' + cycle)
      assert.equal(s.html[0], '<p>Earlier</p>\n<p>Mutable pending hidden-latest</p>')
      assert.equal(s.html[1], '<p>Earlier</p>\n<p>Mutable second</p>', 'independent row unaffected')
      await invoke('append', ' queued')
      await invoke('append', ' FINAL', { final: true })
      s = await snap('final-immediate-' + cycle)
      assert.equal(s.html[0], '<p>Earlier</p>\n<p>Mutable pending hidden-latest queued FINAL</p>')
      assert.equal(s.timers, 0, 'final commits immediately and cancels prior schedule')
      await invoke('start')
      await invoke('append', ' queued')
      await invoke('append', ' CONTROL', { control: true })
      s = await snap('control-immediate-' + cycle)
      assert.equal(s.html[0], '<p>Earlier</p>\n<p>Mutable queued CONTROL</p>')
      assert.equal(s.timers, 0)
    }
    await invoke('start')
    await invoke('append', ' abandoned-A', { mode: 'suspend', transition: true })
    await frames(win)
    await invoke('replacement', 'Committed B')
    await frames(win)
    assert.deepEqual((await snap('abandoned-A-replaced-by-B')).html, [
      '<p>Committed B</p>',
      '<p>Earlier</p>\n<p>Mutable second</p>'
    ])
    for (const mode of ['parser', 'downstream']) {
      await invoke('start')
      await invoke('append', ' error', { mode, final: true })
      await frames(win)
      const s = await snap('caught-' + mode)
      assert.ok(s.caught.includes('real ' + mode + ' failure'))
      assert.deepEqual(s.errors, [])
      await invoke('replacement', 'Recovered ' + mode)
      assert.equal((await snap('recovered-' + mode)).html[0], '<p>Recovered ' + mode + '</p>')
    }
    await invoke('start')
    await invoke('append', ' pending-unmount')
    assert.ok((await snap('before-unmount')).timers > 0)
    const cleanup = await invoke('unmount')
    save('full-public-root-cleanup', cleanup)
    assert.deepEqual(cleanup, { children: 0, timers: 0, errors: [] })
    t.check(
      'real StrictMode full renderer cancels hide/unmount timers, commits finals/controls, isolates rows and recovers abandoned/error renders',
      true
    )
  } finally {
    try {
      await win.goto(pathToFileURL(path.join(dir, 'empty.html')).href)
    } finally {
      await app.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
}
