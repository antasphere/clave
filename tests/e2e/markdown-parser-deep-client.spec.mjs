import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { randomUUID, createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  REPO,
  fixturePath,
  fixtureRoot,
  launchApp,
  seedWorkspaces,
  seedTrustedRoots,
  callMcp
} from './harness.mjs'
import { chatSelector } from './renderer-workload.mjs'
import { inject } from './chat-view.spec.mjs'
import {
  DEPTHS,
  STAGES,
  ROLES,
  literal,
  checkLiteral,
  checkClientRows,
  checkNativeRows
} from './markdown-deep-contract.mjs'

// Primary functional check. The only stream observation is a passive public
// onSessionStream subscription. No debugger, source transform, parser/store
// observation, expected-value polling or timing/heap collection.
export async function run(t) {
  const runId = randomUUID()
  mkdirSync(fixtureRoot(), { recursive: true })
  const owned = mkdtempSync(fixturePath('markdown-deep-'))
  const evidence = process.env.CLAVE_DEEP_EVIDENCE_DIR || path.join(owned, 'evidence')
  mkdirSync(evidence, { recursive: true })
  const clientRows = [],
    nativeRows = [],
    cleanups = [],
    errors = []
  const write = (name, value) =>
    writeFileSync(
      path.join(evidence, runId + '-' + name + '.json'),
      JSON.stringify(value, null, 2) + '\n',
      { flag: 'wx' }
    )
  const captureErrors = (win) => {
    win.on('pageerror', (error) => errors.push({ kind: 'pageerror', message: error.message }))
    win.on('console', (message) => {
      if (message.type() === 'error') errors.push({ kind: 'console', message: message.text() })
    })
  }
  const seed = (dir) => {
    const root = path.join(owned, 'workspace')
    mkdirSync(root, { recursive: true })
    seedWorkspaces(dir, {
      workspaces: [
        { id: 'deep', name: 'Deep contract', rootDir: root, profileFile: null, createdAt: 1 }
      ],
      activeWorkspaceId: 'deep',
      fresh: true
    })
    seedTrustedRoots(dir, [root])
    return root
  }
  const hidden = async (app) =>
    assert.ok(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((w) => !w.isVisible())
      ),
      'all owned windows stay hidden'
    )
  let app, win, primaryCleanup
  const closeOwnedApp = async () => {
    // Unload the tested renderer while its server is still alive. Otherwise
    // pending public transport calls can race the server's shutdown and emit
    // console errors into the next cohort. No primary row is sampled here.
    if (win && !win.isClosed())
      await win.goto(pathToFileURL(path.join(owned, 'fixture', 'empty.html')).href)
    await app?.close()
    app = undefined
    win = undefined
  }
  try {
    const fixture = path.join(owned, 'fixture')
    mkdirSync(fixture)
    writeFileSync(path.join(fixture, 'empty.html'), '<!doctype html><html><body></body></html>')
    const bundled = await build({
      entryPoints: [path.join(REPO, 'tests/e2e/markdown-parser-deep-client-fixture.mjs')],
      outfile: path.join(fixture, 'fixture.js'),
      bundle: true,
      platform: 'browser',
      format: 'iife',
      define: { 'process.env.NODE_ENV': '"development"' },
      jsx: 'automatic',
      metafile: true
    })
    const inputs = Object.keys(bundled.metafile.inputs)
    for (const suffix of [
      'plugins/chat-view/src/MarkdownMessage.tsx',
      'plugins/chat-view/src/markdown-parser-reuse.ts',
      'react-dom/cjs/react-dom-client.development.js',
      'react-markdown/lib/index.js',
      'remark-parse/lib/index.js'
    ])
      assert.ok(
        inputs.some((input) => input.endsWith(suffix)),
        'actual uninstrumented input: ' + suffix
      )
    write('bundle', {
      inputs,
      sourceSha256: Object.fromEntries(
        inputs.map((input) => [
          input,
          createHash('sha256')
            .update(readFileSync(path.resolve(REPO, input)))
            .digest('hex')
        ])
      ),
      bundleSha256: createHash('sha256')
        .update(readFileSync(path.join(fixture, 'fixture.js')))
        .digest('hex')
    })
    writeFileSync(
      path.join(fixture, 'fixture.html'),
      '<!doctype html><html><body><script src="./fixture.js"></script></body></html>'
    )
    const dir = path.join(owned, 'client-user-data')
    seed(dir)
    ;({ app, win } = await launchApp(dir, { args: ['--test-no-machine-usage'] }))
    captureErrors(win)
    await hidden(app)
    await win.goto(pathToFileURL(path.join(fixture, 'fixture.html')).href)
    await win.waitForFunction(() => Boolean(window.markdownDeepFixture))
    try {
      for (const depth of DEPTHS) {
        await win.evaluate((depth) => window.markdownDeepFixture.start(depth), depth)
        for (const stage of STAGES)
          for (const role of ROLES) {
            const row = await win.evaluate((args) => window.markdownDeepFixture.step(args), {
              depth,
              stage,
              role,
              input: literal(depth, stage).input
            })
            row.errors.push(...errors)
            clientRows.push(row)
            write('client-' + clientRows.length, row) // Persist the first value before asserting.
            checkLiteral(row)
          }
      }
    } finally {
      primaryCleanup = await win.evaluate(() => window.markdownDeepFixture.cleanup())
      write('client-cleanup', primaryCleanup)
    }
    checkClientRows(clientRows, primaryCleanup)
    await hidden(app)
    await closeOwnedApp()

    for (const view of ['chat', 'terminal']) {
      const dir = path.join(owned, view + '-user-data'),
        root = seed(dir)
      let fixture
      ;({ app, win, fixture } = await launchApp(dir, {
        args: [
          '--dev-echo-adapter',
          '--dev-echo-view=clave.chat-view/' + view,
          '--test-no-machine-usage'
        ]
      }))
      captureErrors(win)
      await hidden(app)
      for (const depth of DEPTHS) {
        const opened = await callMcp(app, 'openSession', {
          cwd: root,
          mode: 'claude',
          profile: 'dev-echo-adapter',
          account: 'default',
          name: 'Deep ' + view + ' ' + depth
        })
        const sessionId = opened.sessionId
        assert.equal(typeof sessionId, 'string', 'fresh real echo session ID')
        await win.locator(`[data-sidebar-item-id="${sessionId}"] > button`).click()
        const selector = chatSelector(sessionId, view)
        await win.locator(selector + ' textarea:not(:disabled)').waitFor()
        await win.evaluate(() => {
          window.__deepArticle = null
        })
        for (const stage of STAGES) {
          const input = literal(depth, stage).input,
            delta = stage === 'initial' ? input : ' grows'
          await win.evaluate(
            ({ runId, view, sessionId, depth, stage, selector, input, delta }) => {
              const state = {
                done: false,
                row: null,
                errors: [],
                off: null,
                retired: false,
                receipts: 0
              }
              window.__deepSample = state
              state.off = window.electronAPI.onSessionStream(sessionId, (value) => {
                if (
                  value.kind !== 'event' ||
                  value.event.type !== 'assistant_text' ||
                  value.event.delta !== delta
                )
                  return
                state.receipts++
                if (state.receipts !== 1) {
                  state.errors.push('duplicate matching receipt')
                  return
                }
                const receivedAt = performance.now(),
                  receipt = structuredClone(value)
                setTimeout(
                  () =>
                    requestAnimationFrame(() =>
                      requestAnimationFrame(() => {
                        try {
                          // The only eligible DOM sample: fixed 200 ms from receipt,
                          // exactly two animation frames, no output-based waiting.
                          const articles = document.querySelectorAll(
                            selector + ' .chat-turn[data-role="assistant"]'
                          )
                          const article = articles[0],
                            text = article?.textContent ?? null
                          if (stage === 'initial') window.__deepArticle = article
                          state.row = {
                            runId,
                            view,
                            sessionId,
                            depth,
                            stage,
                            input,
                            receipt,
                            receivedAt,
                            sampledAt: performance.now(),
                            sampleCount: 1,
                            animationFrames: 2,
                            articleCount: articles.length,
                            sameArticle:
                              !!article &&
                              article === window.__deepArticle &&
                              window.__deepArticle.isConnected,
                            html: article?.innerHTML ?? null,
                            text,
                            em: article?.querySelectorAll('em').length ?? 0,
                            strong: article?.querySelectorAll('strong').length ?? 0,
                            paragraphsCount: article?.querySelectorAll('p').length ?? 0,
                            paragraphs: article
                              ? Array.from(article.querySelectorAll('p'), (p) => p.textContent)
                              : [],
                            middleOccurrences: text?.split('middle').length - 1,
                            connected: article?.isConnected ?? false
                          }
                        } catch (error) {
                          state.errors.push(error.message)
                        } finally {
                          state.done = true
                        }
                      })
                    ),
                  200
                )
              })
            },
            { runId, view, sessionId, depth, stage, selector, input, delta }
          )
          let row
          try {
            await inject(fixture, sessionId, [
              ...(stage === 'initial' ? [{ type: 'state_change', state: 'working' }] : []),
              { type: 'assistant_text', delta, final: false }
            ])
            // Wait only for the fixed protocol callback, never expected DOM.
            await win.waitForFunction(() => window.__deepSample.done)
            row = await win.evaluate(() => {
              const s = window.__deepSample
              return { ...s.row, errors: [...s.errors], receipts: s.receipts }
            })
            row.errors.push(...errors)
            nativeRows.push(row)
            write('native-' + nativeRows.length, row)
            checkLiteral(row)
            assert.equal(row.receipts, 1, 'exactly one matching public receipt')
            assert.equal(row.articleCount, 1, 'exactly one assistant article')
            assert.ok(row.sameArticle, 'same connected assistant article')
          } finally {
            const cleanup = await win.evaluate(() => {
              const s = window.__deepSample
              s.off()
              s.off = null
              s.retired = true
              return {
                done: s.done,
                receipts: s.receipts,
                callbackErrors: [...s.errors],
                firstSample: s.row,
                retired: s.retired,
                callbackReferenceCleared: s.off === null,
                sessionId: s.row?.sessionId ?? null
              }
            })
            cleanups.push(cleanup)
            write('listener-cleanup-' + cleanups.length, cleanup)
            assert.ok(
              cleanup.retired && cleanup.callbackReferenceCleared,
              'public listener retired'
            )
          }
        }
      }
      await hidden(app)
      await closeOwnedApp()
    }
    checkNativeRows(nativeRows)
    assert.equal(cleanups.length, 16)
    assert.deepEqual(errors, [])
    const summary = {
      runId,
      result: 'PASS',
      clientRows,
      primaryCleanup,
      nativeRows,
      cleanups,
      errors,
      protocol: 'public receipt + fixed 200ms + exactly 2rAF; functional only'
    }
    write('summary', summary)
    console.log(JSON.stringify(summary))
    t.check('24 complete real StrictMode client values; all 12 roots unmounted', true)
    t.check(
      '16 complete first native samples in eight fresh echo sessions; retained append articles',
      true
    )
  } catch (error) {
    write('failure', {
      runId,
      error: error.stack,
      clientRows,
      nativeRows,
      primaryCleanup,
      cleanups,
      errors,
      remaining: 'NOTRUN'
    })
    throw error
  } finally {
    try {
      await closeOwnedApp()
    } finally {
      rmSync(owned, { recursive: true, force: true })
      assert.ok(!existsSync(owned), 'owned profiles and fixtures removed')
    }
  }
}
