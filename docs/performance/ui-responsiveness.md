# Desktop renderer responsiveness

Issue [#204](https://github.com/antasphere/clave/issues/204). This candidate is **performance-blocked**. The original formal result remains a 69.688% reduction in extra renderer task time and tab handler-to-second-animation-frame p95 of 52.3ms against 50ms. Independent round two on `2748eef4` remains FAIL: the tab ceiling still fails, the group/composer passes do not reproduce reliably under load, and the new quick-reveal test missed its setup quota on CI. That CI run had successful required jobs and a failed informational whole-suite step. Round two independently reverified the validator, lineage and local semantic-mutation repairs. The round-two author setup/disclosure repair has no CI or independent reassessment yet. This report does not claim merge readiness.

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

Both formal phases ran with a 1ms CPU profiler, as `config.profileIntervalUs` records. Original one-minute load averages were 36.6–55.6 before and 11.9–14.4 on R2. Those external workloads were uncontrolled; serialization excludes this lane's own builds and checks, not other work on the Mac. The independent diagnostics below quantify profiler sensitivity and test a fresh pair under more comparable load. They do not replace these historical formal results.

The native input clock starts before Playwright's `keyboard.insertText` and ends after observing the controlled textarea value. Focus and clearing precede that clock. Handler clocks start inside the DOM event and end at the second rAF. Tab/group request clocks additionally include Playwright actionability, IPC, frame waits and DOM verification; their tails exceed 100ms and remain disclosed, but they are not the accepted native-input metric. None measures physical input-to-pixel latency.

## Independent round-one diagnostics

The [complete independent report](https://github.com/antasphere/clave/pull/210#issuecomment-6215668824) keeps the verdict FAIL. The following are the peer's diagnostic collections on the R2-identical product, not replacement formal runs or new author measurements.

| Diagnostic metric        | Profiled | Unprofiled |
| ------------------------ | -------: | ---------: |
| Tab handler p95          |   54.2ms |     51.6ms |
| Group handler p95        |   80.2ms |     74.8ms |
| Composer handler p95     |   45.2ms |     41.5ms |
| Native input request p95 |   21.2ms |     10.9ms |
| Median extra task time   |   1176ms |     1098ms |

The peer alternated six launches, P/U/P/U/P/U, with three launches per condition and load averages 6.8–13.7. The unprofiled condition used a private collector copy that disabled CPU profiling. Its diagnostic field discloses that change even though its tooling fields hash the frozen originals. It cannot be treated as the unchanged formal collector. Removing the profiler reduces extra task time by about 6.7%, but tab p95 still exceeds 50ms. [Peer profiler evidence](https://github.com/antasphere/clave/pull/210#issuecomment-6215668824).

The peer also ran a fresh three-before/three-after pair with the original frozen collector at load averages 21–38. Median extra task time fell from 4218ms to 1175ms, 72.1% lower. Stream rates were 19.17–19.58/s, ordered conservation held and there were no page errors. After p95 was tab **56.2ms**, group **86.8ms**, composer **50.1ms** and native input **48.7ms**. Group per-launch p95 was 82.4/82.7/90.9ms, composer 50.4/42.5/48.1ms and native input 42.2/44.6/61.3ms. Two group samples exceeded 100ms. Group and composer therefore remain blockers alongside tab; native input has little margin in the pooled result. [Peer load-pair evidence](https://github.com/antasphere/clave/pull/210#issuecomment-6215668824).

That pair swapped the four base product files into the verifier tree, reproduced all 415 historical before renderer hashes, restored the product byte-identically and reproduced all 415 R2 hashes. Both collector `source` fields name `7709dc91`, so the product hashes identify which build actually ran. These are single-machine diagnostics under uncontrolled external load. The peer used Node v23.11.1/npm 10.9.2; the historical collector recorded Node v22.12.0. No confidence interval, cross-platform result or physical input-to-pixel claim follows.

A separate one-launch attribution experiment compared 12 unprofiled and six 100µs-profiled reveals per condition. Streaming reveal median was 54.4ms to the second rAF, with 37.1ms script, versus 26.4ms and 6.7ms script after streaming stopped and the snapshot was current. The roughly 30ms script difference was in synchronous full-message Markdown parsing, with 36–95k characters in those runs. This supports a bounded parsing proposal; it proves no benefit for an unimplemented cache, block renderer or worker. The [lead's finding decision](https://github.com/antasphere/clave/issues/204#issuecomment-6215683536) keeps the original ceilings and requires scope refinement before product changes.

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

Original author mutations removed pane memoization, the final-text guard, cancellation and fixed-deadline scheduling. Each failed a meaningful assertion; sources were restored byte-identically. Removing the original reveal scroll notification failed the existing hidden-workspace painted-text assertion in both server modes. The original long-response assertion caught it in-process but passed that reveal step in separate mode, then encountered an unrelated view-menu timeout. That original coverage limit remains part of the record.

Independent round one found no content or control loss, but showed three regression gaps: routing control/non-assistant updates through the text timer, delaying quick reveal, and changing Terminal Markdown component identities all survived the committed checks. The original quiet-gap control check and eventual reveal checks were insufficient. Those peer outcomes remain unchanged in the [full report](https://github.com/antasphere/clave/pull/210#issuecomment-6215668824); author repairs are not an independent verdict.

The [author repair evidence](ui-responsiveness/author-fix-round-1.json) records the stricter validator, active-stream and second-frame assertions, both views' link/table identity checks, original semantic mutation results and restoration. It retains failed setup attempts and the initial history-paging failure alongside its unchanged passing repeat. At the round-one author handoff these repairs awaited independent reassessment. The exact-`2748eef4` round-two findings below record the later peer results.

## Author fix round one

The validator now requires exactly `config.samples` values per launch, in both collections, both phases and every action/clock. It retains the collector's minimum of 20 and the historical formal configuration of 30. Dense, finite, nonnegative timings, finite interaction percentiles and reported/raw summary agreement are checked before target comparisons. New negatives cover one/six samples, a short launch concealed by pooled data, missing or invalid percentiles and invalid/sparse values. Before the helper edit, 51 such cases failed because the old validator accepted them. The final validator suite has 86 passing cases. The original archived 30-sample arrays were already valid; their recorded performance FAIL remains unchanged.

The new presentation checks use a fresh echo session created through app commands after the original 100-pane assertion. This avoids inheriting the earlier deliberately unanswered permission's blocked state, in which unfinished text does not use the working-text clock. The checks assert working state explicitly. This extra correctness session does not alter the frozen 100-tab collector or any historical measurement.

Quick reveal waits for a real text paint, hides the view to an actual zero-size box, observes a new raw chunk while hidden, and records the latest delivered marker at the reveal click. The round-two author patch moves that setup into one page-local orchestration through the real transport and DOM click handlers, removing automation round trips between paint and the second-frame observation. An immutable observation is made at the second rAF; later polling only retrieves that observation, never waits for missing text to appear. Ten aligned quick cases are required within 25 attempts. All slower setup attempts remain recorded, and every observed reveal must be fresh.

Permission and non-assistant transcript rows are injected during a continuing stream, about 20ms after a real text paint. The observer watches the transcript's scroll container, independently of the live dock and header. Three aligned injections per kind are required within 12 attempts; slower setup attempts remain visible, and every row still has to appear within the unchanged 75ms assertion. Permissions are answered through the real dock between trials. Both native views also retain link/table/scroll-frame DOM and an 80px table scroll position during visible appends, while URL labels and destinations still update.

Original M4, M6 and M9b now fail their intended semantic assertions in both server modes. Each mutation was restored byte-identically, rebuilt to all 415 R2 renderer hashes and followed by an unmutated in-process check; the required focused suite verifies the restored product in both modes. Earlier author attempts that did not catch M6, and setup failures, remain in the repair evidence. No R2 product repair or new formal timing was performed. [Repair evidence and exact checks](ui-responsiveness/author-fix-round-1.json) distinguish these historical author results from the independent round-two verdict, which remains FAIL for the performance blockers and CI setup defect described below.

| Repair-round check                                    |   Exit | Result                                                                                        |
| ----------------------------------------------------- | -----: | --------------------------------------------------------------------------------------------- |
| `npm test`                                            |      0 | 3157 passed, 2 skipped; 271 passing files, 1 skipped                                          |
| Full lint, typecheck, build, protocol generation/diff | 0 each | No generated change                                                                           |
| Focused Electron, separate                            |      0 | 75 passed, 0 failed, 1 unstable                                                               |
| Focused Electron, in-process first / unchanged repeat |  1 / 0 | 74 passed, 1 failed, 1 unstable; then 75 passed, 0 failed, 1 unstable                         |
| Original M4/M6/M9b, each mode                         | 1 each | Intended assertion caught; exact product restore/rebuild and in-process rerun pass after each |
| Original-helper snapshot corruption / restoration     |  1 / 0 | Lineage check catches one changed byte; restored archive checks pass                          |
| Strict audit of historical before/R2                  |  **1** | Historical tab 52.3ms still exceeds 50ms                                                      |

The first in-process focused failure was the unchanged history-paging screen-anchor assertion: 308.296875px became 325.671875px, a 17.375px difference. It passed in the unchanged full repeat. This observation remains recorded without a base comparison, causal attribution, test repair or product fix. The unstable result in both modes is the already documented `chat-view` prompt assertion.

The reviewed R2 runtime source, dependency/build/packaging configuration, 415 renderer JavaScript assets and all 15 non-renderer bundles are unchanged. The peer's successful server-boot, built-terminal and package/module gates on `7709dc91` are reused on that evidence, as the repair brief permits. They were not rerun here; a newly packaged payload is not claimed byte-identical. At that author handoff, CI on the repair commit was still pending. The later exact-`2748eef4` run is recorded below; any subsequent source patch still needs its own CI after lead review/commit.

## Artifacts and reproduction

[The manifest](ui-responsiveness/manifest.json) contains all seven frozen tool hashes, product-source hashes per collection, and original/compressed SHA-256 hashes for 95 files. All five complete collections retain their measurements, 60 sanitized raw/normalized CPU profiles as lossless gzip, and 30 openable flamegraphs. Signed raw intervals are preserved; normalized intervals conserve the observed span with no tail extrapolation. Original unsanitized profiles remain private.

The current validator is a later audit revision. [Validator lineage](ui-responsiveness/validator-lineage.json) identifies its SHA-256 and the exact [original helper snapshot](ui-responsiveness/tooling/responsiveness-data.7709dc91.mjs), preserved from source commit `7709dc91`. The snapshot hash equals the historical frozen hash. All 100 pre-existing archive files, including all 95 original artifacts and every original verdict, remain byte-identical. The stricter validator audits an unchanged historical pair; it did not time those runs. Future timed pairs must freeze identical new tooling on both sides, still including this helper in the seven-file hash set. A new-tooling after run cannot be compared with old before data.

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

Running the collector with the current helper starts a new tooling lineage. It cannot extend the historical pair without restoring the original snapshot as described below.

To recreate the historical before build, use an isolated checkout of the base. Copy the frozen `renderer-responsiveness.mjs`, `renderer-workload.mjs` and `renderer-responsiveness-fixture.mjs` into their original paths, and copy the **original helper snapshot** to `scripts/performance/responsiveness-data.mjs`. The other three frozen files already exist at the base. The snapshot retains its original relative import, so run it from that restored path, not from the archive directory. Verify all seven historical hashes before building and measuring. Use the same snapshot for historical after reproduction. Do not copy product changes into the baseline or run builds/checks concurrently with collection. For any new-tooling pair, freeze a new before and after together rather than reusing the old before set.

## Historical author verification

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

## Completed CI and retained limits

[CI run 38893406919](https://github.com/antasphere/clave/actions/runs/38893406919) on exact head `7709dc91` completed with both jobs successful. Its informational whole-suite step exited **1**, with **2363 passed, 34 failed, 10 known failures and 10 unstable results**. The existing continue-on-error setting explains the green job; this is not an all-E2E-pass claim. This historical result is preserved separately from the later `2748eef4` run.

[CI run 38912449830](https://github.com/antasphere/clave/actions/runs/38912449830) completed on exact head `2748eef4b71ce6e57a5f609fc7065258f8cd64b2` with both required jobs successful, including server-boot 71/71/73, built-terminal and package/module gates. The informational whole-suite step exited **1**: **2379 passed, 30 failed, 10 known failures and 10 unstable results**. Its `renderer-responsiveness` spec failed the quick-reveal setup quota: **nine qualifying trials in 25 attempts**, against ten required. All 25 second-frame observations were fresh. Hidden setup time ranged from 75.1 to 211.8ms. Green jobs reflect the existing continue-on-error policy; the lane's own spec was red.

The [full independent round-two report](https://github.com/antasphere/clave/pull/210#issuecomment-6232389131) classifies this as **V2-F1, blocker**, a test-setup robustness defect. It attributes the exhausted quick window to several automation round trips. It makes no product stale-output claim. Widening the window could let the reveal-delay mutation survive. The round-two author setup/disclosure repair changes only the page-local setup, preserving exactly ten quick trials within 25, hidden time below 110ms, paint-to-click below 120ms, working/zero-size preconditions, the latest marker captured at the actual click and the immutable second-rAF observation. All slow or failed attempts remain recorded, and every observation must be fresh. The source patch has not run CI and has no independent fate yet.

Round two covers `2748eef4` on historical base `2439b3ab`. Product output remained byte-identical to the peer's previous build, 439/439 files. It ran no new timing. Its local focused Electron suites passed 75 checks with one listed unstable result in each mode. Original M4/M6/M9b mutations failed their intended assertions in both modes, followed by exact restoration, rebuild and an in-process baseline pass after each. These local results do not negate the CI failure.

| Finding                                                | Independent round-two fate                                                                                                       |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| V1-F1 tab; V1-F2 group/composer                        | Open performance blockers; original evidence and ceilings unchanged                                                              |
| V1-F3 disclosure; V1-F4 validator/lineage              | Fixed and reverified by the peer                                                                                                 |
| V1-F6 controls; V1-F8 identity                         | Fixed and reverified by original semantic mutations in both modes                                                                |
| V1-F7 reveal protection                                | Fixed and reverified locally; CI robustness remains blocked by V2-F1                                                             |
| V1-F5 listed chat-view unstable; V1-F9 shutdown errors | Nonblocking, unchanged; shutdown cause remains unattributed                                                                      |
| V2-F1 quick-reveal quota                               | Blocker; author setup repair supplied for lead review, with CI/peer reassessment still owed                                      |
| V2-F2 current-CI disclosure                            | Nonblocking; this document now records the completed exact-head CI and its failure; peer reassessment of this edit is still owed |
| V2-F3 base movement                                    | Informational scope limit; current-dev integration requires a separate phase and review                                          |
| L3-history-anchor                                      | Nonblocking and unattributed; initial 17.375px failure retained, not reproduced in the peer's candidate/base repeats             |

Current `dev` had advanced to `1c05ac23`, overlapping product and build inputs. Exact historical-candidate checks prove no integration with that base. Other informational CI failures are not attributed here, and counts from different runs do not establish equal failure sets. Full repository checks, integration, subsequent-candidate CI and independent reassessment are outside this bounded author repair phase. No readiness or criterion waiver follows.

The peer compared base run 38803919813 on `2439b3ab`, which had 2345 passed, 34 failed, 10 known and 11 unstable. Equal failure counts do not prove equal failures: the lead's normalized comparison found 29 shared failures, five candidate-only and five base-only. The peer's assertion-line comparison had six candidate-only FAIL lines and seven base-only FAIL/UNSTABLE lines. These remain informational and unattributed. Restore timing failed on both, 4142ms versus 2651ms from one sample each, which does not establish a regression cause. [Complete comparison and limits](https://github.com/antasphere/clave/pull/210#issuecomment-6215668824).

V1-F5 remains nonblocking. The unstable `chat-view` assertion that no prompt remains produced `1 !== 0` in four candidate runs and both base-product reproductions. It is listed unstable in the repository. No required-check waiver or blanket attribution of the other failures follows.

V1-F9 remains nonblocking and unattributed. The peer's reveal diagnostic logged 249 renderer console errors about its local server not answering. A phase-tagged repeat put all 15 errors after `app.close()` began, with no earlier console warning/error and no uncaught page exception. There is no tagged base comparison. The frozen collector records `pageerror`, not console messages. No collector or shutdown repair was made, and no zero-console-error claim is made. [Peer shutdown observation](https://github.com/antasphere/clave/pull/210#issuecomment-6215668824).

The whole informational suite was not duplicated locally in the author repair round. Product behavior remains R2. No push, PR, merge, release or install was performed by the author. Independent round two reverified the original validator/test/report repairs with the local/CI distinction above. The new author setup/disclosure patch still needs its own CI and independent reassessment; the performance scope remains unresolved.
