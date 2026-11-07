// Actual unused MarkdownMessage, actual configured parser and real hidden React.
// Functional evidence only. Importing this discovered spec performs no setup.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { randomUUID } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  readFileSync,
  existsSync,
  rmdirSync
} from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

async function runScenario({ label, evidenceDir }) {
  const harness = await import('../../harness.mjs')
  const environment = { ...process.env }
  mkdirSync(harness.fixtureRoot(), { recursive: true })
  const ownedRoot = mkdtempSync(harness.fixturePath('markdown-lifecycle-'))
  const dir = path.join(ownedRoot, 'user-data')
  const fixture = path.join(ownedRoot, 'fixture')
  const evidence = evidenceDir ? path.resolve(evidenceDir) : path.join(ownedRoot, 'evidence')
  let app, win
  const observations = [],
    consoleErrors = []
  const snap = async () => win.evaluate(() => window.markdownFixture.snapshot())
  const barrier = async () =>
    win.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
    )
  const checkpoint = async (name) => {
    const data = await snap()
    observations.push({ checkpoint: name, data })
    return data
  }
  const render = async (input, options = {}) => {
    await win.evaluate(({ input, options }) => window.markdownFixture.render(input, options), {
      input,
      options
    })
    await barrier()
    const s = await snap()
    if (!options.parserError && options.map !== 'error' && !options.suspend) {
      const oracle = await win.evaluate(
        ({ input, options }) => window.markdownFixture.oracle(input, options),
        { input, options }
      )
      assert.equal(s.dom.one, oracle, 'actual connected DOM equals unchanged full renderer')
    }
    return s
  }
  const entriesFor = (s, input) => s.entries.filter((e) => e.input === input)
  const active = (s, row = 'one') => s.stores.find((x) => x.row === row && x.input !== null)
  try {
    mkdirSync(fixture, { recursive: true })
    mkdirSync(evidence, { recursive: true })
    harness.seedWorkspaces(dir, {
      workspaces: [
        {
          id: 'markdown',
          name: 'Markdown proof',
          rootDir: fixture,
          profileFile: null,
          createdAt: 1
        }
      ],
      activeWorkspaceId: 'markdown',
      fresh: true
    })
    const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
    const anchors = []
    function replaceOnce(source, before, after) {
      assert.equal(source.split(before).length - 1, 1, 'instrumentation anchor: ' + before)
      anchors.push(before)
      return source.replace(before, after)
    }
    const built = await build({
      entryPoints: [path.join(repo, 'tests/e2e/diagnostics/prefix-cache/markdown-parser-lifecycle-fixture.mjs')],
      outfile: path.join(fixture, 'fixture.js'),
      bundle: true,
      platform: 'browser',
      format: 'iife',
      define: { 'process.env.NODE_ENV': '"development"' },
      jsx: 'automatic',
      metafile: true,
      plugins: [
        {
          name: 'actual-markdown-observations',
          setup(build) {
            build.onLoad(
              { filter: /tests\/diagnostics\/prefix-cache\/plugins\/chat-view\/src\/markdown-parser-reuse\.ts$/ },
              ({ path: file }) => {
                let source = readFileSync(file, 'utf8')
                source = replaceOnce(
                  source,
                  '    snapshot = next',
                  '    snapshot = next\n    globalThis.__markdownProbe.published(store, next)'
                )
                source = replaceOnce(
                  source,
                  '  return {\n    getSnapshot:',
                  '  const store: MarkdownStore = {\n    getSnapshot:'
                )
                source = replaceOnce(
                  source,
                  '      listeners.add(listener)',
                  '      listeners.add(listener)\n      globalThis.__markdownProbe.subscribed(store, listeners.size)'
                )
                source = replaceOnce(
                  source,
                  '        listeners.delete(listener)',
                  '        listeners.delete(listener)\n        globalThis.__markdownProbe.subscribed(store, listeners.size)'
                )
                source = replaceOnce(
                  source,
                  '    clear: () => publish(undefined)\n  }',
                  '    clear: () => publish(undefined)\n  }\n  globalThis.__markdownProbe.created(store, () => listeners.size)\n  return store'
                )
                source = replaceOnce(
                  source,
                  '    base = undefined',
                  '    base = undefined\n    globalThis.__markdownProbe.released(attempt)'
                )
                // Instrument BELOW the reuse wrapper, at the actual configured parser.
                const start = source.indexOf('export function createMarkdownAttempt(')
                assert.ok(start > 0)
                const prefix = source.slice(0, start)
                let attemptSource = source.slice(start)
                attemptSource = replaceOnce(
                  attemptSource,
                  '    const original = this.parser',
                  '    const configured = this.parser\n    const original = configured && ((document, file) => {\n      globalThis.__markdownProbe.entry(attempt, document, file)\n      return configured(document, file)\n    })'
                )
                attemptSource = replaceOnce(
                  attemptSource,
                  '  return { plugin, ready: () => complete, candidate: () => next, release }',
                  '  const attempt = { plugin, ready: () => complete, candidate: () => next, release }\n  globalThis.__markdownProbe.attempt(attempt, input, base)\n  return attempt'
                )
                return { contents: prefix + attemptSource, loader: 'ts' }
              }
            )
            build.onLoad(
              { filter: /tests\/diagnostics\/prefix-cache\/plugins\/chat-view\/src\/MarkdownMessage\.tsx$/ },
              ({ path: file }) => {
                let source = readFileSync(file, 'utf8')
                source = replaceOnce(
                  source,
                  '      if (attempt.ready())',
                  '      globalThis.__markdownProbe.effect(attempt, store)\n      if (attempt.ready())'
                )
                source = replaceOnce(
                  source,
                  'remarkPlugins={[[remarkGfm, { singleTilde }], attempt.plugin]}',
                  'remarkPlugins={[[remarkGfm, { singleTilde }], attempt.plugin, () => (tree, file) => globalThis.__markdownProbe.collect(attempt, tree, file)]}'
                )
                source = replaceOnce(
                  source,
                  '    previous.children === next.children &&',
                  '    !globalThis.__markdownProbe.forceParserRetry && previous.children === next.children &&'
                )
                source = replaceOnce(
                  source,
                  '  const attempt = createMarkdownAttempt(',
                  '  globalThis.__markdownProbe.owner(store, props.children, committed)\n  const attempt = createMarkdownAttempt('
                )
                return { contents: source, loader: 'tsx' }
              }
            )
          }
        }
      ]
    })
    const inputs = Object.keys(built.metafile.inputs)
    for (const suffix of [
      'plugins/chat-view/src/MarkdownMessage.tsx',
      'plugins/chat-view/src/markdown-parser-reuse.ts',
      'react-dom/cjs/react-dom-client.development.js',
      'react-markdown/lib/index.js',
      'remark-parse/lib/index.js'
    ])
      assert.ok(
        inputs.some((p) => p.endsWith(suffix)),
        'actual installed input: ' + suffix
      )
    writeFileSync(
      path.join(evidence, label + '-metafile.json'),
      JSON.stringify({ anchors, inputs }, null, 2),
      { flag: 'wx' }
    )
    writeFileSync(
      path.join(fixture, 'fixture.html'),
      '<!doctype html><html><body><div id="root"></div><script src="./fixture.js"></script></body></html>'
    )
    ;({ app, win } = await harness.launchApp(dir, {
      server: 'in-process',
      args: ['--test-no-machine-usage']
    }))
    assert.ok(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((w) => !w.isVisible())
      ),
      'all actual windows hidden'
    )
    const mainArgs = await app.evaluate(() => process.argv)
    assert.ok(
      !mainArgs.includes('--server=separate'),
      'this scenario explicitly pins its own launch in-process'
    )
    assert.equal(harness.serverDataDirOf(dir), dir, 'own server data belongs to in-process launch')
    win.on('pageerror', (e) => consoleErrors.push(e.message))
    await win.goto(pathToFileURL(path.join(fixture, 'fixture.html')).href)
    await win.waitForFunction(() => Boolean(window.markdownFixture))
    const seed = '# Notes\n\nA complete paragraph with [late][x].\n\nMutable'
    let s = await render(seed, { phase: 'mount' })
    assert.equal(
      entriesFor(s, seed).length,
      2,
      'real StrictMode parser replay, no notification re-entry'
    )
    assert.ok(s.owners.length > s.entries.length, 'real metadata notification rerenders owner only')
    assert.ok(
      s.publications.filter((p) => p.input === seed).length >= 2,
      'StrictMode clear and republish'
    )
    assert.ok(
      s.effects.every((e) => e.ready),
      'actual NESTED child parser completed before layout publication'
    )
    assert.ok(active(s).accounting.sourceBytes <= 131072)
    for (const p of s.publications.filter((p) => p.input !== null))
      assert.equal(p.dom, s.dom.one, 'publication follows actual DOM commit')
    await checkpoint('mount')
    const initialCount = s.entries.length,
      initialPublications = s.publications.length
    await barrier()
    s = await snap()
    assert.equal(s.entries.length, initialCount, 'no settled parser notification loop')
    assert.equal(s.publications.length, initialPublications)
    s = await render(seed, { phase: 'same-text' })
    assert.equal(s.entries.length, initialCount, 'same text does not parse again')
    // React may discard memo. Force that behavior only in the compiled fixture;
    // semantic equality must prevent a new snapshot/notification/publication.
    s = await render(seed, { phase: 'forced-memo-retry', forceParserRetry: true })
    assert.equal(s.entries.length, initialCount + 2, 'actual parser entered on forced retry')
    assert.equal(
      s.publications.length,
      initialPublications,
      'complete equality deduplicates actual retry'
    )
    const next = seed + ' text ~one~ [unsafe](javascript:bad) [safe](https://example.org)'
    s = await render(next, { phase: 'eligible-append' })
    assert.equal(entriesFor(s, next).length, 2)
    assert.ok(
      entriesFor(s, next).every((e) => e.length < e.fullLength),
      'actual configured parser receives only eligible tail'
    )
    assert.ok(s.urls.includes('') && s.urls.includes('https://example.org'), 'unchanged URL policy')
    const committedId = active(s).snapshotId
    const a = next + ' A',
      b = next + ' B'
    await win.evaluate(
      (input) =>
        window.markdownFixture.render(input, {
          phase: 'suspended-A',
          suspend: true,
          transition: true
        }),
      a
    )
    await win.waitForFunction(
      (input) => window.markdownFixture.snapshot().suspensions.some((x) => x.input === input),
      a
    )
    s = await checkpoint('entered-suspended-A')
    assert.ok(entriesFor(s, a).length > 0, 'A actually entered the ACTUAL parser before suspension')
    assert.ok(!s.publications.some((p) => p.input === a), 'abandoned A never publishes')
    assert.equal(active(s).snapshotId, committedId)
    const priorDOM = await win.evaluate((input) => window.markdownFixture.oracle(input), next)
    assert.equal(s.dom.one, priorDOM)
    s = await render(b, { phase: 'committed-B' })
    assert.ok(
      entriesFor(s, b).every((e) => e.baseId === committedId && e.base === next),
      'B reads committed snapshot, never A'
    )
    assert.ok(s.publications.some((p) => p.input === b))
    await win.evaluate(() => window.markdownFixture.release())
    await barrier()
    s = await checkpoint('committed-B')
    assert.ok(!s.publications.some((p) => p.input === a))
    const global = b + '\n\n[x]: https://example.org/late'
    s = await render(global, { phase: 'global-context' })
    assert.deepEqual(
      entriesFor(s, global).map((e) => e.length < e.fullLength),
      [true, false, true, false]
    )
    assert.equal(active(s).kind, 'full')
    assert.ok(s.dom.one.includes('href="https://example.org/late"'))
    const following = global + '\n\nFollowing'
    s = await render(following, { phase: 'known-full-only' })
    assert.ok(
      entriesFor(s, following).every((e) => e.length === following.length),
      'no repeated failed-tail speculation'
    )
    for (const [phase, input] of [
      ['replace', 'Replacement\n\nTail'],
      ['prepend', 'Prepended\n\nReplacement\n\nTail'],
      ['shrink', 'Small\n\nTail']
    ]) {
      s = await render(input, { phase })
      assert.ok(
        entriesFor(s, input).every((e) => e.length === input.length),
        phase + ' invalidates'
      )
    }
    const tilde = 'Header\n\n~one~ and ~~two~~\n\nMutable'
    await render(tilde, { phase: 'tilde-on' })
    s = await render(tilde, { phase: 'pipeline-change', singleTilde: false })
    assert.ok(s.dom.one.includes('~one~') && s.dom.one.includes('<del>two</del>'))
    assert.ok(
      s.entries
        .filter((e) => e.phase === 'pipeline-change')
        .every((e) => e.length === tilde.length),
      'pipeline change full parse'
    )
    s = await render(tilde, { phase: 'component-map-change', singleTilde: false, map: 'alternate' })
    assert.ok(s.dom.one.includes('data-custom="yes"'), 'Components identity is output-affecting')
    assert.equal(s.entries.filter((e) => e.phase === 'component-map-change').length, 2)
    s = await render(tilde, { phase: 'final', final: true })
    assert.ok(
      s.stores.every((x) => x.input === null),
      'final releases all retained metadata'
    )
    assert.ok(s.entries.filter((e) => e.phase === 'final').every((e) => e.length === tilde.length))
    const boundary = 'a'.repeat(32767) + '\n\ntail'
    s = await render(boundary, { phase: 'exact-source-cap' })
    assert.equal(active(s).accounting.sourceBytes, 131072)
    s = await render(boundary + '\n\nextra', { phase: 'above-source-cap' })
    assert.equal(active(s).kind, 'full')
    assert.deepEqual(active(s).keys, ['blocked', 'input', 'kind', 'signature'])
    await checkpoint('context-options-caps')
    // Failed real parser and downstream component errors are caught by React.
    // Clearing old metadata on teardown is allowed; publishing failed input is not.
    for (const kind of ['parser', 'downstream']) {
      const good = kind + ' good\n\nTail',
        bad = good + ' failure'
      await render(good, { phase: kind + '-baseline', boundary: kind + '-boundary' })
      s = await render(bad, {
        phase: kind + '-error',
        boundary: kind + '-boundary',
        parserError: kind === 'parser',
        map: kind === 'downstream' ? 'error' : 'default'
      })
      assert.ok(entriesFor(s, bad).length > 0, kind + ' error actual parser entered')
      assert.ok(!s.publications.some((p) => p.input === bad), kind + ' error never publishes')
      assert.ok(
        !s.effects.some((e) => e.input === bad),
        kind + ' failed subtree never commits effect'
      )
      assert.ok(
        s.stores.every((x) => x.input === null && x.listeners === 0),
        kind + ' error unmount cleanup'
      )
      assert.ok(
        s.caught.some(
          (e) =>
            e ===
            (kind === 'parser'
              ? 'actual configured parser sentinel'
              : 'downstream component sentinel')
        )
      )
    }
    await win.evaluate(() => window.markdownFixture.unmount())
    await barrier()
    s = await render('One\n\nTail', { phase: 'remount-two', second: 'Two\n\nTail' })
    const twoCount = s.entries.filter((e) => e.row === 'two').length
    s = await render('One\n\nTail appended', { phase: 'row-isolation', second: 'Two\n\nTail' })
    assert.equal(s.entries.filter((e) => e.row === 'two').length, twoCount)
    assert.equal(s.stores.filter((x) => x.input !== null).length, 2)
    assert.equal(new Set(s.stores.filter((x) => x.input !== null).map((x) => x.snapshotId)).size, 2)
    for (let n = 0; n < 3; n++) {
      await win.evaluate(() => window.markdownFixture.unmount())
      await barrier()
      s = await snap()
      assert.ok(s.stores.every((x) => x.input === null && x.listeners === 0))
      await render('Mount ' + n + '\n\nTail', { phase: 'mount-cycle-' + n })
    }
    await win.evaluate(() => window.markdownFixture.finish())
    await barrier()
    s = await checkpoint('teardown')
    assert.ok(
      s.stores.every((x) => x.input === null && x.listeners === 0 && x.cached),
      'every store empty and unsubscribed after teardown'
    )
    assert.ok(
      s.listeners.some((x) => x.count === 1) &&
        s.listeners.every((x) => x.count <= 1 && x.count >= 0)
    )
    const successful = s.entries.filter((e) => !e.phase.endsWith('-error'))
    assert.ok(
      successful.length > 0 &&
        successful.every((e) => e.sameFile && e.fullLength === e.input.length),
      'actual original parser receives exact full VFile downstream identity'
    )
    assert.ok(s.effects.every((e) => e.ready))
    for (const publication of s.publications.filter((p) => p.input !== null)) {
      assert.ok(
        s.effects.some(
          (effect) =>
            effect.candidateId === publication.snapshotId &&
            effect.storeId === publication.storeId &&
            effect.input === publication.input
        ),
        'every real published identity belongs to a successfully committed nested parser attempt'
      )
      const oracle = await win.evaluate(
        ({ input, options }) => window.markdownFixture.oracle(input, options),
        publication
      )
      assert.equal(publication.dom, oracle, 'every publication follows exact connected DOM output')
    }
    assert.ok(!s.publications.some((p) => p.input === a))
    for (const effect of s.effects)
      assert.ok(
        s.attempts.find((x) => x.id === effect.attemptId).released,
        'committed attempt releases advisory base'
      )
    assert.deepEqual(s.errors, [])
    assert.deepEqual(consoleErrors, [])
    writeFileSync(
      path.join(evidence, label + '-observations.json'),
      JSON.stringify(observations, null, 2),
      { flag: 'wx' }
    )
    const summary = {
      result: 'actual-Markdown-lifecycle-pass',
      checkpoints: observations.length,
      owners: s.owners.length,
      actualParserEntries: s.entries.length,
      attempts: s.attempts.length,
      publications: s.publications.length,
      stores: s.stores.length,
      peakSubscribers: Math.max(...s.listeners.map((x) => x.count)),
      abandonedPublications: s.publications.filter((p) => p.input === a).length,
      launchMode: 'in-process',
      callerMode: process.env.CLAVE_E2E_SERVER ?? null
    }
    console.log(JSON.stringify(summary))
    return summary
  } catch (error) {
    if (win) {
      try {
        observations.push({ checkpoint: 'failed', data: await snap() })
      } catch {
        /* crashed renderer has no snapshot */
      }
    }
    writeFileSync(
      path.join(evidence, label + '-failed.json'),
      JSON.stringify({ error: error.stack, observations, consoleErrors }, null, 2),
      { flag: 'wx' }
    )
    throw error
  } finally {
    try {
      await app?.close()
    } finally {
      rmSync(ownedRoot, { recursive: true, force: true })
    }
    const changedKeys = [
      ...new Set([...Object.keys(environment), ...Object.keys(process.env)])
    ].filter((key) => environment[key] !== process.env[key])
    assert.deepEqual(
      changedKeys,
      [],
      'lifecycle scenario leaves the complete caller environment unchanged'
    )
    assert.ok(!existsSync(ownedRoot), 'only the exact owned scenario root is removed')
  }
}

/** Standard discovered-spec contract. The outer runner owns suite sweeps. */
export async function run(t) {
  const namespace = process.env.CLAVE_E2E_NS
  const mode = process.env.CLAVE_E2E_SERVER
  const summary = await runScenario({ label: 'runner' })
  t.check(
    'actual configured parser entered the complete hidden React lifecycle',
    summary.actualParserEntries > 0,
    summary
  )
  t.check('actual committed metadata publications were observed', summary.publications > 0, summary)
  t.equal('no abandoned Markdown attempt was published', summary.abandonedPublications, 0)
  t.equal('the lifecycle launch alone is pinned in-process', summary.launchMode, 'in-process')
  t.equal('the caller server mode is unchanged', process.env.CLAVE_E2E_SERVER, mode)
  t.equal('the caller namespace is unchanged', process.env.CLAVE_E2E_NS, namespace)
}

// CLI arguments belong to this direct entry only, never run.mjs imports.
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const label = process.argv[2] || 'default'
  assert.match(label, /^[a-z0-9-]+$/, 'nonempty exact run label')
  assert.ok(process.argv.length <= 4, 'no unknown arguments or test selectors')
  const previousNamespace = process.env.CLAVE_E2E_NS
  const ownsNamespace = !previousNamespace?.trim()
  if (ownsNamespace)
    process.env.CLAVE_E2E_NS = 'ui204-markdown-lifecycle-' + label + '-' + randomUUID()
  try {
    await runScenario({ label, evidenceDir: process.argv[3] })
  } finally {
    if (ownsNamespace) {
      try {
        const { fixtureRoot } = await import('../../namespace.mjs')
        if (existsSync(fixtureRoot())) rmdirSync(fixtureRoot())
      } finally {
        if (previousNamespace === undefined) delete process.env.CLAVE_E2E_NS
        else process.env.CLAVE_E2E_NS = previousNamespace
      }
    }
  }
}
