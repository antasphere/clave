# Desktop renderer responsiveness

Issue [#204](https://github.com/antasphere/clave/issues/204). This candidate is **performance-blocked**. It reduces the measured extra renderer task time by 69.688%, but tab handler-to-second-animation-frame p95 is 52.3ms against the unchanged 50ms target. Independent diagnosis and current-head CI remain pending. This report does not claim merge readiness.

## Cause and change

Selecting one tab called `RegisteredSessionView`, `ChatView` and `TerminalView` for all 100 mounted sessions. Only two sessions changed visibility. CDP function-entry breakpoints counted 98 unrelated hidden renders. Memoizing the registered host retains its mounted state and subscriptions while preventing those calls. The regression asserts that both changed sessions really hit each breakpoint, so a broken probe cannot report a false zero.

A selected unfinished answer also reparsed its complete Markdown on every incoming delta. Presentation now coalesces only append-only text on the same unfinished assistant entry, at a 150ms cadence. Transport and reducers still process every event. A fixed deadline keeps continuous input from postponing presentation indefinitely. Final text, controls, other entries, state/model/effort/mode changes and reveal bypass the timer. Hiding and unmounting cancel pending presentation.

Inline link and table renderer functions previously changed their React component identity on each parse. A real Electron regression observed an existing anchor disconnect after an append. Stable component mappings in both native views preserve those DOM nodes and existing link behavior. No dependency, server, protocol, style or shared store changed.

## Frozen comparison

Three fresh launches before and three for each after collection ran on this Mac. Collections were serialized against this lane's own builds and checks; other Mac workloads were uncontrolled. Each used 100 echo chats in 10 groups, 20 histories of 200 alternating turns, 80 short histories, and a selected 34,380-byte response with 480 Markdown links/emphasis spans. Streaming appends uniquely numbered 128-byte chunks every 50ms. Thirty samples per action follow five warmups in each phase. Every produced chunk arrived once, in order.

The task counter covers the initial five seconds of each quiet/streaming phase. CPU profiles cover the full phase, including later interactions. Full-phase duration depends on how long those interactions take, so baseline profiles contain more appended text. Their sampled totals must not be substituted for the fixed-window task comparison. Realized stream rates remain comparable, 19.34–19.60 events/s across the before and R2 collections.

| Source       | Launch | Quiet task ms | Streaming task ms | Extra task ms | Events/s | Full-phase events |
| ------------ | -----: | ------------: | ----------------: | ------------: | -------: | ----------------: |
| Before       |      1 |        24.385 |          4068.213 |      4043.828 |   19.382 |               738 |
| Before       |      2 |        59.474 |          3848.807 |      3789.333 |   19.566 |               454 |
| Before       |      3 |        23.388 |          3851.146 |      3827.758 |   19.595 |               398 |
| R2 candidate |      1 |        33.871 |          1194.142 |      1160.271 |   19.434 |               254 |
| R2 candidate |      2 |        24.685 |          1041.361 |      1016.676 |   19.343 |               243 |
| R2 candidate |      3 |        26.414 |          1231.723 |      1205.309 |   19.466 |               240 |

Median extra task time falls from 3827.758ms to 1160.271ms, exceeding the accepted 60% reduction target. These are renderer task counters, not whole-app CPU or a confidence interval.

| Streaming metric, 90 pooled samples      | Before p95 |  R2 p95 | Target | Result   |
| ---------------------------------------- | ---------: | ------: | -----: | -------- |
| Native input request to controlled value |  103.848ms | 8.147ms |  ≤50ms | Pass     |
| Tab handler to second rAF                |     84.5ms |  52.3ms |  ≤50ms | **Fail** |
| Group handler to second rAF              |    143.1ms |  71.2ms |  ≤75ms | Pass     |
| Composer handler to second rAF           |    110.0ms |  37.7ms |  ≤50ms | Pass     |

R2 per-launch tab p95 is 52.5/52.3/49.8ms, group 70.9/72.0/71.2ms, composer 37.7/38.1/37.4ms, and native input 8.306/7.158/7.877ms. The raw samples, maxima and every sample over 100ms remain in [the comparison](ui-responsiveness/comparison.json) and measurements. The tab samples above 45ms reveal the long streaming answer. That correlation does not prove a specific reveal-hook cause.

Both formal phases ran with a 1ms CPU profiler, as `config.profileIntervalUs` records. These are instrumented timings; a paired unprofiled cohort has not established their sensitivity to profiling.

The native input clock starts before Playwright's `keyboard.insertText` and ends after observing the controlled textarea value. Focus and clearing precede that clock. Handler clocks start inside the DOM event and end at the second rAF. Tab/group request clocks additionally include Playwright actionability, IPC, frame waits and DOM verification; their tails exceed 100ms and remain disclosed, but they are not the accepted native-input metric. None measures physical input-to-pixel latency.

## Retained failed refinements

| Collection | Change from prior candidate                | Median extra task ms | Tab/group/composer p95 ms | Outcome                              |
| ---------- | ------------------------------------------ | -------------------: | ------------------------- | ------------------------------------ |
| R1         | Host memo and 150ms cadence                |             1417.910 | 54.8 / 81.0 / 56.3        | Misses handler targets               |
| R2         | Stable Markdown component types            |             1160.271 | 52.3 / 71.2 / 37.7        | Tab miss; retained source            |
| R3         | Additional layout-phase virtualizer resync |             1084.796 | 51.9 / 77.3 / 46.3        | No measured latency benefit; removed |
| R4         | Memoized static link href/children         |             1180.316 | 52.1 / 72.8 / 38.6        | No material latency benefit; removed |

The original next-rAF reveal notification remains byte-identical to the base. Neither rejected experiment remains in the product. No threshold, workload, stream rate or measurement boundary changed. The lead froze R2 for independent diagnosis rather than authoring another speculative refinement.

Earlier setup failures are retained privately and excluded from formal pooling: the initial fixture omitted the framework's required readiness callback; the first memo syntax let Rollup rename the function needed by the breakpoint probe; a permission timestamp probe initially matched `textContent` without its keyboard shortcut suffix. None counts as a behavioral red. A baseline hidden-workspace check failed on a delayed question-node addition, then passed unchanged. A concurrent correctness run recorded a 110.4ms native-input outlier; it remains outside the exclusive formal comparison.

The first final in-process focused run passed 45 checks, then timed out reopening the view menu in the new fixture. Its manual switch did not await the previous menu's 100ms closing animation. The fixture now uses its shared switch helper and waits for the menu to close. Behavioral assertions and the frozen formal runner remain unchanged. The failed run is retained alongside the repaired runs.

## Behavior and mutation evidence

The reusable `chat/renderer-responsiveness` scenario uses `@structure-ai/fixtures`, app commands and the recording echo adapter. It creates no production data and makes no inference request. Readiness checks assert 100 distinct sessions and 10 groups. Every invocation gets an isolated namespace, user-data directory and fixture UUID. The harness launches real Electron with `--test-no-activate`, invisible windows and background throttling disabled. Cleanup closes only owned instances and removes owned fixture data. Some exploratory shutdowns required the harness's existing exact-PID timeout fallback; no quit-performance improvement is claimed.

The regression checks zero unrelated renders, both views' actual glyph ranges on reveal after a hidden zero-size scroll box, native wheel reading intent under a visible stream, nonzero reading offset through hide/reveal, retained drafts, exact ordered final content, live controls/model/state and changing link labels/destinations. Existing focused specs also cover every selected grid pane, history paging and input history. Live freshness samples remained below the 150ms target. A measured permission arrival reached the DOM in 9–11ms.

Author mutations removed pane memoization, the final-text guard, cancellation and fixed-deadline scheduling. Each failed a meaningful assertion; sources were restored byte-identically. Removing the original reveal scroll notification failed the existing hidden-workspace painted-text assertion in both server modes. The new long-response assertion caught it in-process but passed that reveal step in separate mode, then encountered an unrelated view-menu timeout. Its reveal coverage alone is therefore insufficient to prove notification necessity in every run. These are author checks. Independent Opus verification has not occurred and must assess the remaining tab miss and test limitations itself.

## Artifacts and reproduction

[The manifest](ui-responsiveness/manifest.json) contains all seven frozen tool hashes, product-source hashes per collection, and original/compressed SHA-256 hashes for 95 files. All five complete collections retain their measurements, 60 sanitized raw/normalized CPU profiles as lossless gzip, and 30 openable flamegraphs. Signed raw intervals are preserved; normalized intervals conserve the observed span with no tail extrapolation. Original unsanitized profiles remain private.

The collection `source` field is the checked-out base HEAD `2439b3aba905bc8f9084e33cc51306fb7ae9d766`; product edits were uncommitted during measurement. Use the manifest's product-source hashes and each run's full renderer-chunk hashes to identify the actual build. The final candidate restores all five R2 product sources exactly, and the final build matches all 415 renderer asset hashes in every R2 launch. Test/report changes do not alter those source inputs.

Representative graphs: [before streaming](ui-responsiveness/before/run-3-on.html), [R2 streaming](ui-responsiveness/candidate-r2/run-1-on.html). [Before measurements](ui-responsiveness/before/measurements.json) and [R2 measurements](ui-responsiveness/candidate-r2/measurements.json) retain every fixture identity, runtime version, PID, port, raw sample and delta. Archived artifact checks recompute all summaries and acceptance verdicts, validate hashes/privacy, and reconstruct every raw/normalized profile pair.

```sh
npx electron-vite build
SHELL=/bin/zsh CLAVE_E2E_NS=<fresh-namespace> \
  node scripts/performance/renderer-responsiveness.mjs \
  --runs 3 --samples 30 --out <fresh-directory>

SHELL=/bin/zsh CLAVE_E2E_NS=<fresh-namespace> CLAVE_E2E_SERVER=<in-process-or-separate> \
  node tests/e2e/run.mjs renderer-responsiveness hidden-chat-rendering \
  chat-scroll-end chat-terminal-rows chat-input-history chat-prompt-dock chat-history-pages

node --test tests/performance/responsiveness-artifacts.test.mjs
gunzip -k docs/performance/ui-responsiveness/candidate-r2/*.cpuprofile.gz
```

To recreate the before build, use an isolated checkout of the base and copy only the four new frozen files, `renderer-responsiveness.mjs`, `responsiveness-data.mjs`, `renderer-workload.mjs` and `renderer-responsiveness-fixture.mjs`, from this candidate into their original paths. The other three frozen files already exist at the base. Verify all seven hashes before building and measuring. Do not copy product changes into the baseline or run builds/checks concurrently with collection.

## Local verification

[The command inventory](ui-responsiveness/local-checks.json) retains exact commands, environments, timestamps, initial failures and successful repeats. [Author mutation outcomes](ui-responsiveness/author-checks.json) and [both modes' behavior samples](ui-responsiveness/behavior-samples.json) retain fixture identities and measured freshness/control observations.

| Check                                           |   Exit | Result                                                             |
| ----------------------------------------------- | -----: | ------------------------------------------------------------------ |
| `npm test`                                      |      0 | 3,080 passed, 2 skipped; 271 passing files, 1 skipped              |
| `npm run lint`                                  |      0 | Full repeat after the JavaScript rule exemption and fixture repair |
| `npm run typecheck`                             |      0 | Node and renderer                                                  |
| `npm run build`                                 |      0 | Native build, typechecks and all bundles                           |
| `npm run proto:gen`, generated protocol diff    | 0 each | No generated change                                                |
| Built terminal-process tests                    |      0 | 52 passed in 4 files                                               |
| Focused real Electron, in-process / separate    | 0 each | 47 passed in each mode                                             |
| Server boot, in-process / attached / separate   | 0 each | 71 / 71 / 73 passed                                                |
| Unsigned arm64 package and packaged module gate | 0 each | 51 external modules, 15 bundles                                    |
| Archive false-green mutation / restored archive |  1 / 0 | Incorrect success verdict caught; bytes restored                   |
| Frozen performance comparator                   |  **1** | **Tab p95 52.3ms exceeds 50ms**                                    |

The packaged checker finds `electron-log/main` but excludes its probe exception, `__electronLog is not defined`, under its existing policy. Passing that checker does not claim this exception disappeared.

The whole informational E2E suite is deferred to current-head CI by the lead. Current-head CI and independent Opus diagnosis are owed before any readiness decision. No push, PR, merge, release or install was performed by the author.
